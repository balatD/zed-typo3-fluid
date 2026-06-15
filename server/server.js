#!/usr/bin/env node
'use strict';
/**
 * Fluid Language Server — a dependency-free LSP for TYPO3 Fluid templates.
 *
 * Provides:
 *   - completion: ViewHelper tag names (<f:…>) and their attributes
 *   - hover: ViewHelper / attribute documentation
 *   - diagnostics: live template analysis via the project's fluid/typo3 binary
 *     (with DDEV support), ported from the FriendsOfTYPO3 VS Code extension.
 *
 * ViewHelper metadata is loaded from viewhelpers.json (VS Code HTML
 * custom-data shape). Talks LSP over stdio with manual JSON-RPC framing, so it
 * has zero npm dependencies and can be spawned directly with `node server.js`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// ───────────────────────────── ViewHelper data ─────────────────────────────
/** @type {{name:string, description?:any, attributes?:any[], references?:any[]}[]} */
let TAGS = [];
/** @type {Map<string, any>} */
const TAG_BY_NAME = new Map();

function loadViewHelperData() {
  const candidates = [
    process.env.FLUID_VIEWHELPERS_JSON,
    path.join(__dirname, 'viewhelpers.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const tags = Array.isArray(data) ? data : data.tags || [];
      for (const tag of tags) {
        if (!tag || !tag.name) continue;
        if (!TAG_BY_NAME.has(tag.name)) {
          TAGS.push(tag);
          TAG_BY_NAME.set(tag.name, tag);
        }
      }
    } catch (_) { /* ignore missing/invalid files */ }
  }
}

function descText(description) {
  if (!description) return '';
  if (typeof description === 'string') return description;
  return description.value || '';
}

// ───────────────────────────── Configuration ───────────────────────────────
const config = {
  bin: {
    typo3: { path: '', args: [] },
    fluid: { path: '', args: [] },
    useDdevIfAvailable: true,
  },
  features: { liveTemplateAnalysis: true },
};
let rootPath = process.cwd();
/** @type {Map<string,string>} */
const documents = new Map();
/** binary resolution cache per workspace */
let binaryCache = null;

function applySettings(settings) {
  if (!settings) return;
  const s = settings.fluid || settings;
  if (s.bin) {
    if (s.bin.fluid) {
      config.bin.fluid.path = s.bin.fluid.path ?? config.bin.fluid.path;
      config.bin.fluid.args = s.bin.fluid.args ?? config.bin.fluid.args;
    }
    if (s.bin.typo3) {
      config.bin.typo3.path = s.bin.typo3.path ?? config.bin.typo3.path;
      config.bin.typo3.args = s.bin.typo3.args ?? config.bin.typo3.args;
    }
    if (typeof s.bin.useDdevIfAvailable === 'boolean') {
      config.bin.useDdevIfAvailable = s.bin.useDdevIfAvailable;
    }
  }
  if (s.features && typeof s.features.liveTemplateAnalysis === 'boolean') {
    config.features.liveTemplateAnalysis = s.features.liveTemplateAnalysis;
  }
  binaryCache = null; // re-resolve binary after config change
}

// ───────────────────────────── JSON-RPC plumbing ───────────────────────────
function send(msg) {
  const json = JSON.stringify(msg);
  const buf = Buffer.from(json, 'utf8');
  process.stdout.write(`Content-Length: ${buf.length}\r\n\r\n`);
  process.stdout.write(buf);
}
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }
function log(message) { notify('window/logMessage', { type: 3, message: `[fluid] ${message}` }); }

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const header = buffer.slice(0, headerEnd).toString('ascii');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) { buffer = buffer.slice(headerEnd + 4); continue; }
    const len = parseInt(m[1], 10);
    const start = headerEnd + 4;
    if (buffer.length < start + len) return; // wait for full body
    const body = buffer.slice(start, start + len).toString('utf8');
    buffer = buffer.slice(start + len);
    let msg;
    try { msg = JSON.parse(body); } catch (_) { continue; }
    handle(msg);
  }
});

function uriToPath(uri) {
  if (!uri) return '';
  try { return decodeURIComponent(uri.replace(/^file:\/\//, '')); } catch (_) { return uri; }
}

// ───────────────────────────── Message handling ────────────────────────────
function handle(msg) {
  switch (msg.method) {
    case 'initialize': return onInitialize(msg);
    case 'initialized': return;
    case 'shutdown': return reply(msg.id, null);
    case 'exit': return process.exit(0);
    case 'workspace/didChangeConfiguration':
      applySettings(msg.params && msg.params.settings);
      return;
    case 'textDocument/didOpen': {
      const d = msg.params.textDocument;
      documents.set(d.uri, d.text);
      runDiagnostics(d.uri);
      return;
    }
    case 'textDocument/didChange': {
      const uri = msg.params.textDocument.uri;
      const changes = msg.params.contentChanges;
      if (changes && changes.length) documents.set(uri, changes[changes.length - 1].text);
      scheduleDiagnostics(uri);
      return;
    }
    case 'textDocument/didClose':
      documents.delete(msg.params.textDocument.uri);
      notify('textDocument/publishDiagnostics', { uri: msg.params.textDocument.uri, diagnostics: [] });
      return;
    case 'textDocument/completion': return reply(msg.id, onCompletion(msg.params));
    case 'textDocument/hover': return reply(msg.id, onHover(msg.params));
    default:
      if (msg.id !== undefined) reply(msg.id, null);
  }
}

function onInitialize(msg) {
  const p = msg.params || {};
  if (p.rootUri) rootPath = uriToPath(p.rootUri);
  else if (p.rootPath) rootPath = p.rootPath;
  applySettings(p.initializationOptions);
  reply(msg.id, {
    capabilities: {
      textDocumentSync: 1, // full
      completionProvider: { triggerCharacters: ['<', ':', ' ', '.'] },
      hoverProvider: true,
    },
    serverInfo: { name: 'fluid-language-server', version: '0.0.1' },
  });
  log(`initialized (root: ${rootPath}, ${TAGS.length} ViewHelpers loaded)`);
}

// ───────────────────────────── Completion ──────────────────────────────────
function lineUpToCursor(text, position) {
  const lines = text.split(/\r\n|\r|\n/);
  const line = lines[position.line] || '';
  return line.slice(0, position.character);
}

function onCompletion(params) {
  const text = documents.get(params.textDocument.uri);
  if (text === undefined) return null;
  const prefix = lineUpToCursor(text, params.position);

  // Inside an open ViewHelper tag → complete its attributes.
  const openTag = /<([a-z][a-z0-9]*(?::[a-z0-9.]+)?)\b[^<>]*$/i.exec(prefix);
  if (openTag && openTag[1].includes(':')) {
    const tag = TAG_BY_NAME.get(openTag[1]);
    if (tag && Array.isArray(tag.attributes)) {
      // only if we're at an attribute boundary (after whitespace)
      if (/[\s]$|[\s][a-z0-9-]*$/i.test(prefix)) {
        const used = new Set((prefix.match(/([a-z0-9-]+)=/gi) || []).map(s => s.slice(0, -1)));
        return tag.attributes.filter(a => !used.has(a.name)).map(a => ({
          label: a.name,
          kind: 5, // Field
          documentation: { kind: 'markdown', value: descText(a.description) },
          insertText: `${a.name}="$1"`,
          insertTextFormat: 2, // snippet
        }));
      }
    }
  }

  // Typing a tag name: `<f:` or `<f:fo` or bare `<`.
  const tagStart = /<([a-z0-9]*(?::[a-z0-9.]*)?)$/i.exec(prefix);
  if (tagStart) {
    const typed = tagStart[1].toLowerCase();
    return TAGS
      .filter(t => t.name.toLowerCase().startsWith(typed))
      .map(t => ({
        label: t.name,
        kind: 7, // Class (tag)
        detail: 'Fluid ViewHelper',
        documentation: { kind: 'markdown', value: descText(t.description) },
      }));
  }
  return null;
}

// ───────────────────────────── Hover ───────────────────────────────────────
function onHover(params) {
  const text = documents.get(params.textDocument.uri);
  if (text === undefined) return null;
  const lines = text.split(/\r\n|\r|\n/);
  const line = lines[params.position.line] || '';
  const col = params.position.character;

  // Hover over a ViewHelper tag name: <f:format.raw or </f:format.raw
  const tagRe = /<\/?([a-z][a-z0-9]*:[a-z0-9.]+)/gi;
  for (const m of matchAll(line, tagRe)) {
    const nameStart = m.index + m[0].indexOf(m[1]);
    const nameEnd = nameStart + m[1].length;
    if (col >= nameStart && col <= nameEnd) {
      const tag = TAG_BY_NAME.get(m[1]);
      if (tag) return { contents: { kind: 'markdown', value: `**${tag.name}**\n\n${descText(tag.description)}` } };
    }
  }

  // Hover over an attribute name inside a known ViewHelper tag.
  const openTag = lastOpenTagBefore(lines, params.position);
  if (openTag) {
    const attrRe = /([a-z][a-z0-9-]*)\s*=/gi;
    for (const m of matchAll(line, attrRe)) {
      const start = m.index;
      const end = start + m[1].length;
      if (col >= start && col <= end) {
        const tag = TAG_BY_NAME.get(openTag);
        const attr = tag && (tag.attributes || []).find(a => a.name === m[1]);
        if (attr) return { contents: { kind: 'markdown', value: `**${openTag} → ${attr.name}**\n\n${descText(attr.description)}` } };
      }
    }
  }
  return null;
}

function* matchAll(str, re) { let m; while ((m = re.exec(str)) !== null) yield m; }

function lastOpenTagBefore(lines, position) {
  // Scan backwards from the cursor for an unclosed `<ns:name` tag.
  let buf = '';
  for (let i = position.line; i >= 0 && i > position.line - 50; i--) {
    const seg = i === position.line ? lines[i].slice(0, position.character) : lines[i];
    buf = seg + '\n' + buf;
  }
  const lastLt = buf.lastIndexOf('<');
  const lastGt = buf.lastIndexOf('>');
  if (lastLt === -1 || lastLt < lastGt) return null;
  const m = /^<\/?([a-z][a-z0-9]*:[a-z0-9.]+)/i.exec(buf.slice(lastLt));
  return m ? m[1] : null;
}

// ───────────────────────────── Diagnostics ─────────────────────────────────
let diagTimer = null;
function scheduleDiagnostics(uri) {
  if (diagTimer) clearTimeout(diagTimer);
  diagTimer = setTimeout(() => runDiagnostics(uri), 300);
}

function ddevAvailable() {
  if (!config.bin.useDdevIfAvailable) return '';
  if (!fs.existsSync(path.join(rootPath, '.ddev'))) return '';
  const r = spawnSync('which', ['ddev'], { shell: true });
  return r.stdout ? r.stdout.toString().trim() : '';
}

function buildCandidates() {
  const subst = (s) => String(s).replaceAll('${workspaceFolder}', rootPath);
  const candidates = [];
  const ddev = ddevAvailable();

  if (config.bin.typo3.path) {
    candidates.push({ command: subst(config.bin.typo3.path), args: [...config.bin.typo3.args.map(subst), 'fluid:analyze', '--json', '--stdin'] });
  }
  if (config.bin.fluid.path) {
    candidates.push({ command: subst(config.bin.fluid.path), args: [...config.bin.fluid.args.map(subst), 'analyze', '--json', '--stdin'] });
  }
  if (ddev) candidates.push({ command: ddev, args: ['typo3', 'fluid:analyze', '--json', '--stdin'] });
  for (const b of ['vendor/bin/typo3', 'bin/typo3', '.Build/bin/typo3']) {
    candidates.push({ command: path.join(rootPath, b), args: ['fluid:analyze', '--json', '--stdin'] });
  }
  const fluidBins = ['vendor/bin/fluid', 'bin/fluid', '.Build/bin/fluid'];
  if (ddev) for (const b of fluidBins) candidates.push({ command: ddev, args: ['exec', b, 'analyze', '--json', '--stdin'] });
  for (const b of fluidBins) candidates.push({ command: path.join(rootPath, b), args: ['analyze', '--json', '--stdin'] });
  return candidates;
}

function tryAnalyze(candidate, input) {
  try {
    const proc = spawnSync(candidate.command, candidate.args, { input, cwd: rootPath, maxBuffer: 16 * 1024 * 1024 });
    if (!proc.stdout) return null;
    const data = JSON.parse(proc.stdout.toString());
    if (data && Array.isArray(data.errors) && Array.isArray(data.deprecations)) return data;
  } catch (_) { /* not this binary */ }
  return null;
}

function runDiagnostics(uri) {
  const text = documents.get(uri);
  if (text === undefined) return;
  if (!config.features.liveTemplateAnalysis) {
    notify('textDocument/publishDiagnostics', { uri, diagnostics: [] });
    return;
  }
  let result = null;
  if (binaryCache) result = tryAnalyze(binaryCache, text);
  if (!result) {
    for (const c of buildCandidates()) {
      const data = tryAnalyze(c, text);
      if (data) { binaryCache = c; log(`using "${[c.command, ...c.args].join(' ')}" for analysis`); result = data; break; }
    }
  }
  if (!result) { notify('textDocument/publishDiagnostics', { uri, diagnostics: [] }); return; }

  const diagnostics = [];
  for (const err of result.errors) {
    const loc = err.templateLocation;
    const line = Math.max(0, Number((loc && loc.line) ?? 1) - 1);
    const character = Math.max(0, Number((loc && loc.character) ?? 1) - 1);
    const cleaned = /Fluid parse error in template .+?, line [0-9]+ at character [0-9]+\. Error: (.*?)(?: Template source chunk:|$)/s.exec(err.message);
    diagnostics.push({
      range: { start: { line, character }, end: { line, character: character + 1 } },
      severity: 1, // Error
      source: 'fluid',
      message: cleaned && cleaned[1] ? cleaned[1] : err.message,
    });
  }
  for (const dep of result.deprecations) {
    diagnostics.push({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 3, // Information
      source: 'fluid',
      message: `${dep.message} (${dep.file} in line ${dep.line})`,
    });
  }
  notify('textDocument/publishDiagnostics', { uri, diagnostics });
}

// ───────────────────────────── Boot ────────────────────────────────────────
loadViewHelperData();
process.on('uncaughtException', (e) => log(`uncaught: ${e && e.stack || e}`));
