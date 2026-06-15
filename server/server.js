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
const { spawnSync, spawn } = require('node:child_process');

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

// ──────────────────── Project ViewHelpers (XSD schemas) ─────────────────────
// Dynamic, project-aware ViewHelper data — covers core, extensions AND custom
// ViewHelpers — by running `typo3 fluid:schema:generate` and parsing the XSDs
// it writes to var/transient/. Keyed by the XSD's targetNamespace URL.
/** @type {Map<string, Map<string, {description:string, arbitrary:boolean, attributes:{name:string,description:string,required:boolean,type:string,default:string}[]}>>} */
let projectByUrl = new Map();
let schemaGenerating = false;

// The global `f:` prefix is registered to BOTH Fluid namespaces; TYPO3 CMS
// ViewHelpers override/extend the standalone ones, so CMS is merged last.
const F_NAMESPACES = [
  'http://typo3.org/ns/TYPO3Fluid/Fluid/ViewHelpers',
  'http://typo3.org/ns/TYPO3/CMS/Fluid/ViewHelpers',
];

function hasProjectData() { return projectByUrl.size > 0; }

/** Minimal XSD reader: pull <xsd:element> ViewHelpers + their <xsd:attribute>s. */
function parseXsd(xml) {
  const nsMatch = /targetNamespace\s*=\s*"([^"]+)"/.exec(xml);
  if (!nsMatch) return null;
  const url = nsMatch[1];
  const tags = new Map();

  // Each top-level <xsd:element name="…"> … </xsd:element> is one ViewHelper.
  const elementRe = /<xsd:element\b[^>]*\bname\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/xsd:element>/g;
  for (const el of matchAll(xml, elementRe)) {
    const tagName = el[1];
    const body = el[2];
    // Element documentation = first <xsd:documentation> that is NOT inside an attribute.
    const beforeAttrs = body.split(/<xsd:attribute\b/)[0];
    const elDoc = firstCdataDoc(beforeAttrs);
    const attributes = [];
    // Match the self-closing form first so it can't be swallowed by the paired form.
    const attrRe = /<xsd:attribute\b([^>]*?)\/>|<xsd:attribute\b([^>]*)>([\s\S]*?)<\/xsd:attribute>/g;
    for (const at of matchAll(body, attrRe)) {
      const attrTag = at[1] || at[2] || '';
      const inner = at[3] || '';
      const nm = /\bname\s*=\s*"([^"]+)"/.exec(attrTag);
      if (!nm) continue;
      const ty = /\btype\s*=\s*"([^"]+)"/.exec(attrTag);
      const def = /\bdefault\s*=\s*"([^"]*)"/.exec(attrTag);
      attributes.push({
        name: nm[1],
        description: firstCdataDoc(inner),
        required: /\buse\s*=\s*"required"/.test(attrTag),
        type: ty ? ty[1] : '',
        default: def ? def[1] : undefined,
      });
    }
    tags.set(tagName, { description: elDoc, arbitrary: /<xsd:anyAttribute\b/.test(body), attributes });
  }
  return { url, tags };
}

function firstCdataDoc(fragment) {
  const m = /<xsd:documentation\b[^>]*>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/xsd:documentation>/.exec(fragment);
  if (!m) return '';
  return decodeEntities((m[1] !== undefined ? m[1] : m[2] || '').trim());
}

function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&amp;/g, '&');
}

function schemaDir() { return path.join(rootPath, 'var', 'transient'); }

function loadXsdDir() {
  const dir = schemaDir();
  // var/transient is a general TYPO3 cache dir — read only its top level and
  // only the `schema_*.xsd` files the generator writes (no recursive scan).
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && /\.xsd$/i.test(e.name));
  } catch (_) { return false; }
  if (!entries.length) return false;
  const byUrl = new Map();
  for (const e of entries.slice(0, 500)) {
    try {
      const file = path.join(dir, e.name);
      if (fs.statSync(file).size > 8 * 1024 * 1024) continue; // guard against runaway files
      const parsed = parseXsd(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.tags.size) byUrl.set(parsed.url, parsed.tags);
    } catch (_) { /* skip unreadable/odd files */ }
  }
  if (!byUrl.size) return false;
  projectByUrl = byUrl;
  log(`loaded ${byUrl.size} ViewHelper namespace(s) from ${dir}`);
  return true;
}

/** Run `typo3 fluid:schema:generate` (binary-detected, DDEV-aware), then reload. */
function generateSchemas() {
  if (schemaGenerating) return;
  schemaGenerating = true;
  const candidates = schemaCandidates();
  let i = 0;
  const tryNext = () => {
    if (i >= candidates.length) { schemaGenerating = false; log('no typo3 binary found to generate Fluid schemas'); return; }
    const c = candidates[i++];
    let child;
    // Ignore the child's stdio so a chatty bootstrap can't fill a pipe and hang,
    // and never share our stdout (which carries the LSP stream).
    try { child = spawn(c.command, c.args, { cwd: rootPath, stdio: 'ignore' }); }
    catch (_) { return tryNext(); }
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, 180000);
    child.on('error', () => { clearTimeout(timer); tryNext(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // A clean exit means this binary ran the generator — don't re-run the same
      // (multi-second) generation through the remaining candidates.
      if (code === 0) {
        schemaGenerating = false;
        if (loadXsdDir()) {
          log(`generated schemas via "${[c.command, ...c.args].join(' ')}"`);
          for (const uri of documents.keys()) runDiagnostics(uri);
        } else {
          log('schema generation ran but produced no parseable namespaces');
        }
      } else {
        tryNext();
      }
    });
  };
  tryNext();
}

function schemaCandidates() {
  const subst = (s) => String(s).replaceAll('${workspaceFolder}', rootPath);
  const out = [];
  const ddev = ddevAvailable();
  if (config.bin.typo3.path) {
    out.push({ command: subst(config.bin.typo3.path), args: [...config.bin.typo3.args.map(subst), 'fluid:schema:generate'] });
  }
  if (ddev) out.push({ command: ddev, args: ['typo3', 'fluid:schema:generate'] });
  for (const b of ['vendor/bin/typo3', 'bin/typo3', '.Build/bin/typo3']) {
    out.push({ command: path.join(rootPath, b), args: ['fluid:schema:generate'] });
  }
  return out;
}

// Map prefixes used in a template to their namespace URLs, via `xmlns:x="…"`
// and `{namespace x=Vendor\Ext}` declarations.
function namespacesForDoc(text) {
  const map = {};
  for (const m of matchAll(text, /xmlns:([a-z0-9_]+)\s*=\s*"([^"]+)"/gi)) map[m[1]] = m[2];
  for (const m of matchAll(text, /\{namespace\s+([a-z0-9_]+)\s*=\s*([^}\s]+)\s*\}/gi)) {
    map[m[1]] = 'http://typo3.org/ns/' + m[2].trim().replace(/\\+/g, '/').replace(/\/+$/, '');
  }
  return map;
}

/** Resolve the ViewHelpers available under `prefix` in the given document. */
function tagsForPrefix(prefix, docText) {
  if (hasProjectData()) {
    // Resolve the namespace URL(s) backing this prefix. `f:` is global and maps
    // to both Fluid namespaces (merged); other prefixes come from the template's
    // xmlns:/{namespace} declarations.
    const ns = namespacesForDoc(docText);
    let urls;
    if (prefix === 'f') urls = F_NAMESPACES.filter(u => projectByUrl.has(u));
    else if (ns[prefix]) urls = [ns[prefix]];
    else urls = [];

    if (urls.length) {
      const merged = new Map();
      for (const url of urls) {
        const m = projectByUrl.get(url);
        if (m) for (const [tagName, vh] of m) merged.set(tagName, vh); // later overrides
      }
      if (merged.size) {
        return [...merged].map(([tagName, vh]) => ({
          name: `${prefix}:${tagName}`, tagName, description: vh.description, arbitrary: vh.arbitrary, attributes: vh.attributes,
        }));
      }
    }
  }
  // Fallback to the bundled seed (default `f:` only).
  if (prefix === 'f') return TAGS.map(t => ({ name: t.name, tagName: t.name.slice(2), description: descText(t.description), arbitrary: true, attributes: (t.attributes || []).map(a => ({ name: a.name, description: descText(a.description), required: false, type: '' })) }));
  return [];
}

function lookupTag(prefix, tagName, docText) {
  return tagsForPrefix(prefix, docText).find(t => t.tagName === tagName) || null;
}

// ──────────────────── Static schema validation ─────────────────────────────
function friendlyType(xsdType) {
  switch (String(xsdType).replace(/^xsd:/, '')) {
    case 'integer': return 'integer';
    case 'float': case 'double': return 'number';
    case 'boolean': return 'boolean';
    case 'string': return 'string';
    default: return 'mixed';
  }
}

/** Returns true when `value` (a literal, no {expression}) violates `xsdType`. */
function typeMismatch(xsdType, value) {
  const v = value.trim();
  if (v === '') return false;
  switch (String(xsdType).replace(/^xsd:/, '')) {
    case 'integer': return !/^[+-]?\d+$/.test(v);
    case 'float': case 'double': return !/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v);
    // Booleans are intentionally NOT validated: Fluid treats any non-empty
    // literal as truthy and accepts NULL/yes/no/on/off (incl. documented
    // defaults like default="NULL"), so there is no reliable "invalid" literal.
    case 'boolean': return false;
    default: return false; // string / anySimpleType / unknown → accept anything
  }
}

function makePositioner(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (off) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return { line: lo, character: off - starts[lo] };
  };
}

function skipBraces(text, i) {
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return i;
}

/** Parse attributes of one start tag beginning at offset `i` (after the name). */
function parseTagAttributes(text, i) {
  const attrs = [];
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    const c = text[i];
    if (c === '>') return { attrs, end: i + 1 };
    if (c === '/' && text[i + 1] === '>') return { attrs, end: i + 2 };
    if (c === '<') return { attrs, end: i };          // malformed; bail
    if (c === '{') { i = skipBraces(text, i); continue; } // bare {expression} in tag
    const nameStart = i;
    while (i < n && !/[\s=>/]/.test(text[i])) i++;
    const name = text.slice(nameStart, i);
    while (i < n && /\s/.test(text[i])) i++;
    if (text[i] === '=') {
      i++;
      while (i < n && /\s/.test(text[i])) i++;
      const q = text[i];
      if (q === '"' || q === "'") {
        i++;
        const valStart = i;
        let dynamic = false;
        while (i < n && text[i] !== q) {
          if (text[i] === '\\') { i += 2; continue; }
          if (text[i] === '{') { dynamic = true; i = skipBraces(text, i); continue; }
          i++;
        }
        attrs.push({ name, value: text.slice(valStart, i), valStart, valEnd: i, dynamic });
        i++; // closing quote
      } else {
        const valStart = i;
        while (i < n && !/[\s>/]/.test(text[i])) i++;
        attrs.push({ name, value: text.slice(valStart, i), valStart, valEnd: i, dynamic: false });
      }
    } else {
      attrs.push({ name, value: null, dynamic: false });
    }
  }
  return { attrs, end: i };
}

function scanViewHelperTags(text) {
  const tags = [];
  const re = /<([a-z][a-z0-9_]*):([a-z0-9.]+)/gi;
  let m;
  while ((m = re.exec(text))) {
    const after = m.index + m[0].length;
    const { attrs, end } = parseTagAttributes(text, after);
    tags.push({ prefix: m[1], name: m[2], nameStart: m.index + 1, nameEnd: after, attrs });
    if (end > re.lastIndex) re.lastIndex = end;
  }
  return tags;
}

/** Validate literal attribute types and required attributes against the schema. */
function validateSchema(text) {
  if (!hasProjectData()) return []; // need real types/required flags from XSDs
  const pos = makePositioner(text);
  const diagnostics = [];
  for (const tag of scanViewHelperTags(text)) {
    const vh = lookupTag(tag.prefix, tag.name, text);
    if (!vh) continue; // unknown ViewHelper — leave to the binary analyzer
    const provided = new Set(tag.attrs.map(a => a.name));

    for (const def of vh.attributes) {
      if (def.required && !provided.has(def.name)) {
        diagnostics.push({
          range: { start: pos(tag.nameStart), end: pos(tag.nameEnd) },
          severity: 2, // Warning
          source: 'fluid-schema',
          message: `Missing required attribute "${def.name}" on <${tag.prefix}:${tag.name}>.`,
        });
      }
    }

    for (const at of tag.attrs) {
      if (at.value == null || at.dynamic) continue; // boolean attr or {expression}
      const def = vh.attributes.find(d => d.name === at.name);
      if (!def || !def.type) continue;
      if (typeMismatch(def.type, at.value)) {
        diagnostics.push({
          range: { start: pos(at.valStart), end: pos(at.valEnd) },
          severity: 1, // Error
          source: 'fluid-schema',
          message: `Attribute "${at.name}" expects ${friendlyType(def.type)}, got "${at.value}".`,
        });
      }
    }
  }
  return diagnostics;
}

// ───────────────────────────── Configuration ───────────────────────────────
const config = {
  bin: {
    typo3: { path: '', args: [] },
    fluid: { path: '', args: [] },
    useDdevIfAvailable: true,
  },
  features: { liveTemplateAnalysis: true, generateViewHelperSchema: true },
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
  if (s.features) {
    if (typeof s.features.liveTemplateAnalysis === 'boolean') config.features.liveTemplateAnalysis = s.features.liveTemplateAnalysis;
    if (typeof s.features.generateViewHelperSchema === 'boolean') config.features.generateViewHelperSchema = s.features.generateViewHelperSchema;
  }
  binaryCache = null; // re-resolve binary after config change
  ddevResolved = undefined;
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
    try {
      handle(msg);
    } catch (e) {
      log(`handler error (${msg && msg.method}): ${(e && e.stack) || e}`);
      // Never leave a request hanging: reply with a JSON-RPC error.
      if (msg && msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String((e && e.message) || e) } });
      }
    }
  }
});

// Exit if the client closes the input stream (avoids an orphaned process).
process.stdin.on('close', () => process.exit(shuttingDown ? 0 : 1));
process.stdin.on('error', () => process.exit(1));

function uriToPath(uri) {
  if (!uri) return '';
  try { return decodeURIComponent(uri.replace(/^file:\/\//, '')); } catch (_) { return uri; }
}

// ───────────────────────────── Message handling ────────────────────────────
let shuttingDown = false;
function handle(msg) {
  // Document/text-document requests must carry params.textDocument.
  if (/^textDocument\//.test(msg.method) && (!msg.params || !msg.params.textDocument)) {
    if (msg.id !== undefined) reply(msg.id, null);
    return;
  }
  switch (msg.method) {
    case 'initialize': return onInitialize(msg);
    case 'initialized': return;
    case 'shutdown': shuttingDown = true; return reply(msg.id, null);
    case 'exit': return process.exit(shuttingDown ? 0 : 1);
    case 'workspace/didChangeConfiguration':
      applySettings(msg.params && msg.params.settings);
      // Settings (bin paths, feature flags) arrive after initialize, so apply
      // their effects now: (re)generate schemas if needed and refresh diagnostics.
      if (config.features.generateViewHelperSchema && !hasProjectData()) generateSchemas();
      for (const uri of documents.keys()) runDiagnostics(uri);
      return;
    case 'textDocument/didOpen': {
      const d = msg.params.textDocument;
      documents.set(d.uri, d.text || '');
      runDiagnostics(d.uri);
      return;
    }
    case 'textDocument/didChange': {
      const uri = msg.params.textDocument.uri;
      const changes = msg.params.contentChanges;
      const last = changes && changes.length ? changes[changes.length - 1] : null;
      if (last && typeof last.text === 'string') documents.set(uri, last.text);
      scheduleDiagnostics(uri);
      return;
    }
    case 'textDocument/didClose':
      documents.delete(msg.params.textDocument.uri);
      notify('textDocument/publishDiagnostics', { uri: msg.params.textDocument.uri, diagnostics: [] });
      return;
    case 'textDocument/completion': return reply(msg.id, onCompletion(msg.params));
    case 'textDocument/hover': return reply(msg.id, onHover(msg.params));
    case 'textDocument/onTypeFormatting': return reply(msg.id, onTypeFormatting(msg.params));
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
      completionProvider: { triggerCharacters: ['<', ':', ' ', '.', '{'] },
      hoverProvider: true,
      documentOnTypeFormattingProvider: { firstTriggerCharacter: '>' },
    },
    serverInfo: { name: 'fluid-language-server', version: '0.0.1' },
  });
  log(`initialized (root: ${rootPath}, ${TAGS.length} bundled ViewHelpers)`);

  // Project-dynamic ViewHelpers: load any existing XSDs immediately, then
  // (re)generate in the background so completion/hover cover custom ViewHelpers.
  loadXsdDir();
  if (config.features.generateViewHelperSchema) generateSchemas();
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
  const line = lineUpToCursor(text, params.position);

  // 1. Inline ViewHelper call: `{f:` or `value -> f:` → name(arg: …) snippet.
  //    (Disjoint from tag completion: inline is preceded by `{` or `->`.)
  const inline = /(?:\{|->\s*)([a-z][a-z0-9_]*):([a-z0-9.]*)$/i.exec(line);
  if (inline) {
    const typed = inline[2].toLowerCase();
    return tagsForPrefix(inline[1], text)
      .filter(t => t.tagName.toLowerCase().startsWith(typed))
      .map(t => {
        const required = (t.attributes || []).filter(a => a.required);
        const args = required.map((a, i) => `${a.name}: $${i + 1}`).join(', ');
        return {
          label: t.name,
          kind: 3, // Function
          detail: 'Fluid ViewHelper (inline)',
          documentation: { kind: 'markdown', value: descText(t.description) },
          insertText: `${t.name}(${args})`,
          insertTextFormat: 2,
        };
      });
  }

  // 2. Inside an open ViewHelper tag → complete its attributes (multi-line aware).
  const ctx = openTagContext(text, params.position);
  if (ctx && /[\s]$|[\s][a-z0-9-]*$/i.test(ctx.slice) && !/=\s*["'][^"']*$/.test(ctx.slice)) {
    const vh = lookupTag(ctx.prefix, ctx.name, text);
    if (vh && Array.isArray(vh.attributes)) {
      const used = new Set((ctx.slice.match(/([a-z0-9-]+)=/gi) || []).map(s => s.slice(0, -1)));
      return vh.attributes.filter(a => !used.has(a.name)).map(a => ({
        label: a.name,
        kind: 5, // Field
        detail: a.required ? 'required' : undefined,
        documentation: { kind: 'markdown', value: descText(a.description) },
        insertText: `${a.name}="$1"`,
        insertTextFormat: 2, // snippet
        sortText: (a.required ? '0' : '1') + a.name,
      }));
    }
  }

  // 3. Typing a tag name: `<f:`, `<f:fo`, `<my:teas` …
  const tagStart = /<([a-z0-9_]+):([a-z0-9.]*)$/i.exec(line);
  if (tagStart) {
    const typed = tagStart[2].toLowerCase();
    return tagsForPrefix(tagStart[1], text)
      .filter(t => t.tagName.toLowerCase().startsWith(typed))
      .map(t => {
        // Pre-fill required attributes as tabstops so the user must complete them.
        const required = (t.attributes || []).filter(a => a.required);
        const snippet = t.name + required.map((a, i) => ` ${a.name}="$${i + 1}"`).join('');
        return {
          label: t.name,
          kind: 7, // Class (tag)
          detail: required.length ? `Fluid ViewHelper · ${required.length} required` : 'Fluid ViewHelper',
          documentation: { kind: 'markdown', value: descText(t.description) },
          insertText: snippet,
          insertTextFormat: required.length ? 2 : 1, // snippet only when there are tabstops
        };
      });
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

  // Hover over a ViewHelper tag name (<ns:name, </ns:name) or an inline call
  // ({ns:name(…)}, value -> ns:name()). Both resolve via lookupTag.
  const nameRe = /([<{(,]|->\s*|^|\s)\/?([a-z][a-z0-9_]*):([a-z0-9.]+)/gi;
  for (const m of matchAll(line, nameRe)) {
    const full = `${m[2]}:${m[3]}`;
    const nameStart = m.index + m[0].length - full.length;
    const nameEnd = nameStart + full.length;
    if (col >= nameStart && col <= nameEnd) {
      const vh = lookupTag(m[2], m[3], text);
      if (vh) return { contents: { kind: 'markdown', value: `**${full}**\n\n${descText(vh.description)}` } };
    }
  }

  // Hover over an attribute name inside a known ViewHelper tag.
  const ctxTag = openTagContext(text, params.position);
  if (ctxTag) {
    const p = ctxTag.prefix, n = ctxTag.name;
    const attrRe = /([a-z][a-z0-9-]*)\s*=/gi;
    for (const m of matchAll(line, attrRe)) {
      const start = m.index;
      const end = start + m[1].length;
      if (col >= start && col <= end) {
        const vh = lookupTag(p, n, text);
        const attr = vh && vh.attributes.find(a => a.name === m[1]);
        if (attr) {
          const meta = [];
          if (attr.type) meta.push(`type \`${friendlyType(attr.type)}\``);
          meta.push(attr.required ? '**required**' : 'optional');
          if (attr.default) meta.push(`default \`${attr.default}\``);
          return { contents: { kind: 'markdown', value: `**${p}:${n} → ${attr.name}** — ${meta.join(' · ')}\n\n${descText(attr.description)}` } };
        }
      }
    }
  }
  return null;
}

function* matchAll(str, re) { let m; while ((m = re.exec(str)) !== null) yield m; }

// Resolve the unclosed `<ns:name …` tag the cursor sits inside (multi-line),
// returning its prefix, name and the `<`-to-cursor slice (for attribute scans).
function openTagContext(text, position) {
  const lines = text.split(/\r\n|\r|\n/);
  let buf = lines[position.line] ? lines[position.line].slice(0, position.character) : '';
  for (let i = position.line - 1; i >= 0 && i > position.line - 50; i--) {
    buf = lines[i] + '\n' + buf;
  }
  const lastLt = buf.lastIndexOf('<');
  const lastGt = buf.lastIndexOf('>');
  if (lastLt === -1 || lastLt < lastGt) return null;
  const slice = buf.slice(lastLt);
  const m = /^<\/?([a-z][a-z0-9_]*):([a-z0-9.]+)/i.exec(slice);
  if (!m) return null;
  return { prefix: m[1], name: m[2], slice };
}

// ───────────────────── Auto-close tags (on typing `>`) ──────────────────────
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen',
  'link', 'menuitem', 'meta', 'param', 'source', 'track', 'wbr',
]);

function posToOffset(text, position) {
  let line = 0, i = 0;
  while (line < position.line && i < text.length) {
    const c = text[i];
    if (c === '\r') { i += text[i + 1] === '\n' ? 2 : 1; line++; }
    else if (c === '\n') { i++; line++; }
    else i++;
  }
  return i + position.character;
}

// Insert the matching close tag when `>` is typed to finish a start tag.
// Self-closing tags (`<f:image/>`) and void HTML elements are skipped, as are
// `>` characters inside quoted values or {expressions}.
function onTypeFormatting(params) {
  const text = documents.get(params.textDocument.uri);
  if (text === undefined) return null;

  let off = posToOffset(text, params.position);
  if (text[off] === '>') off += 1;        // position reported at the '>' itself
  if (text[off - 1] !== '>') return null;  // not immediately after a '>'
  if (text[off - 2] === '/') return null;  // self-closing  <… />

  const before = text.slice(0, off);
  const lt = before.lastIndexOf('<');
  if (lt < 0 || before[lt + 1] === '/' || before[lt + 1] === '!') return null;
  const nameMatch = /^<([a-zA-Z][\w.:-]*)/.exec(before.slice(lt));
  if (!nameMatch) return null;
  const name = nameMatch[1];

  // Verify the typed `>` is the tag's real close (ignore `>` inside "…" / '…' / {…}).
  let q = null, depth = 0, closeAt = -1;
  for (let i = lt + 1; i < off; i++) {
    const c = before[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; }
    else if (c === '{') depth++;
    else if (c === '}') { if (depth > 0) depth--; }
    else if (c === '>' && depth === 0) { closeAt = i; break; }
  }
  if (closeAt !== off - 1) return null;

  // ViewHelpers (names with `:`) are never void; for plain HTML, skip void tags.
  if (!name.includes(':') && VOID_ELEMENTS.has(name.toLowerCase())) return null;

  // Don't duplicate an existing close tag right after the cursor.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp('^\\s*</' + escaped + '\\s*>').test(text.slice(off))) return null;

  const pos = makePositioner(text)(off);
  return [{ range: { start: pos, end: pos }, newText: `</${name}>` }];
}

// ───────────────────────────── Diagnostics ─────────────────────────────────
let diagTimer = null;
function scheduleDiagnostics(uri) {
  if (diagTimer) clearTimeout(diagTimer);
  diagTimer = setTimeout(() => runDiagnostics(uri), 300);
}

let ddevResolved; // memoized; reset on config change (applySettings)
function ddevAvailable() {
  if (!config.bin.useDdevIfAvailable) return '';
  if (!fs.existsSync(path.join(rootPath, '.ddev'))) return '';
  if (ddevResolved === undefined) {
    const r = spawnSync('which', ['ddev']);
    ddevResolved = r.stdout ? r.stdout.toString().trim() : '';
  }
  return ddevResolved;
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

function runDiagnostics(uri) {
  const text = documents.get(uri);
  if (text === undefined) return;

  // Static, instant validation from the XSD schema (types + required fields).
  const base = validateSchema(text);
  notify('textDocument/publishDiagnostics', { uri, diagnostics: base });

  // Parse-error/deprecation analysis runs asynchronously — the binary boots
  // TYPO3 (multiple seconds) and must never block the LSP event loop.
  if (config.features.liveTemplateAnalysis) analyzeAsync(uri, text, base);
}

const analyzingUris = new Set();
function analyzeAsync(uri, text, baseDiagnostics) {
  if (analyzingUris.has(uri)) return; // one analysis per file at a time
  analyzingUris.add(uri);
  const candidates = binaryCache ? [binaryCache] : buildCandidates();
  let idx = 0;
  const tryNext = () => {
    if (idx >= candidates.length) { analyzingUris.delete(uri); return; }
    const c = candidates[idx++];
    let child;
    try { child = spawn(c.command, c.args, { cwd: rootPath, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch (_) { return tryNext(); }
    let out = '';
    child.on('error', () => tryNext());
    child.stdout.on('data', (d) => {
      out += d;
      if (out.length > 16 * 1024 * 1024) { try { child.kill(); } catch (_) {} }
    });
    child.on('close', () => {
      let data = null;
      try {
        const j = JSON.parse(out);
        if (j && Array.isArray(j.errors) && Array.isArray(j.deprecations)) data = j;
      } catch (_) { /* not a fluid analyzer */ }
      if (!data) return tryNext();
      if (binaryCache !== c) log(`using "${[c.command, ...c.args].join(' ')}" for analysis`);
      binaryCache = c;
      analyzingUris.delete(uri);
      if (!documents.has(uri)) return; // file closed meanwhile
      const merged = baseDiagnostics.slice();
      mapAnalyzerResult(data, merged);
      notify('textDocument/publishDiagnostics', { uri, diagnostics: merged });
    });
    try { child.stdin.end(text); } catch (_) { /* stdin may already be gone */ }
  };
  tryNext();
}

function mapAnalyzerResult(result, diagnostics) {
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
}

// ───────────────────────────── Boot ────────────────────────────────────────
loadViewHelperData();
process.on('uncaughtException', (e) => log(`uncaught: ${(e && e.stack) || e}`));
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${(e && e.stack) || e}`));
