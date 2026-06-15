# TYPO3 Fluid for Zed

A [Zed](https://zed.dev) extension providing language support for the
[TYPO3 Fluid](https://docs.typo3.org/permalink/t3coreapi:fluid) templating
language. It is a port of the
[FriendsOfTYPO3/vscode-fluid-language](https://github.com/FriendsOfTYPO3/vscode-fluid-language)
VS Code extension.

> **Status: highlighting + snippets + language server.** Highlighting is powered
> by a dedicated [`tree-sitter-fluid`](../tree-sitter-fluid) grammar; a bundled
> Node language server adds ViewHelper completion, hover docs and live
> diagnostics. See [Language server](#language-server).

## Why this isn't a straight port

Zed and VS Code have incompatible foundations, so the source extension could not
be copied file-for-file:

| Concern | VS Code extension | Zed |
| --- | --- | --- |
| Syntax highlighting | TextMate grammar (`.tmLanguage`) | **Tree-sitter** only → new grammar |
| ViewHelper completion / docs | VS Code **HTML Custom Data** | no equivalent → needs an LSP |
| Live analysis | TS client runs `fluid`/`typo3` PHP binary | needs an LSP |
| Snippets | `snippets/*.json` | same format ✅ |
| File detection | globs over `Resources/Private/**` dirs | `path_suffixes` + `first_line_pattern`, **no globs** |

Highlighting is driven by a purpose-built **`tree-sitter-fluid`** grammar (in the
sibling `tree-sitter-fluid/` repo) that extends tree-sitter-html and actually
parses Fluid syntax — so `{…}` expressions, inline ViewHelpers, operators, casts
and arrays are tokenized, not just the surrounding HTML.

## Features

- Full HTML highlighting (elements, attributes, comments, entities, embedded
  CSS/JS).
- Fluid **ViewHelper tags** — `<f:if>`, `<f:format.raw>`, `<v:…>`, `<core:icon>`,
  custom `vendor:…` namespaces — as functions.
- Fluid **`{expressions}`**, tokenized everywhere (text **and** attribute values):
  - object accessors `{user.name}` → variables,
  - inline ViewHelpers & pipelines `{foo -> f:format.raw()}` → functions,
  - named arguments / array keys → properties,
  - operators, ternaries, `as` casts, booleans/`_all`, numbers, strings.
- **`{namespace …}`** declarations, `xmlns:f`, `data-namespace-typo3-fluid`.
- **Dynamic tag names** `<{headline}>…</{headline}>`.
- 26 **snippets** for core and TYPO3 ViewHelpers (`f:for`, `f:if`, `f:translate`,
  `f:image`, `f:render.*`, …).

### Known limitations

- **File detection.** Zed `path_suffixes` can't glob TYPO3's
  `Resources/Private/Templates/**` directories. Detection is therefore: the
  explicit Fluid suffixes (`*.fluid.html`, `*.fluid`, …) **plus** a
  `first_line_pattern` that sniffs `{namespace`, `data-namespace-typo3-fluid`,
  `xmlns:f`, or a `<f:…>`/`<x:y>` tag on line 1. Templates that open with plain
  HTML still need a manual language switch (command palette → language selector).
- **Grammar edge cases** (localized, non-fatal — the rest of the file still
  highlights): same-quote nesting inside an attribute value
  (`value='{ … 'x': … }'`) and the interior of string literals are not fully
  tokenized.

## File detection

Auto-detected suffixes: `*.fluid.html`, `*.fluid.htm`, `*.fluid.txt`, `*.fluid`.

## Language server

A bundled, **dependency-free Node** language server (`server/server.js`,
spawned by `src/lib.rs` via Zed's Node) provides:

- **Completion** — ViewHelper tag names (`<f:…>`) filtered by prefix, and the
  attributes of the ViewHelper you're inside.
- **Hover** — Markdown documentation for ViewHelper tags and their attributes.
- **Diagnostics** — live template analysis (errors + deprecations) by shelling
  out to the project's Fluid/TYPO3 binary, ported from the VS Code extension:
  it tries (in order) configured paths → `ddev typo3 fluid:analyze` →
  `vendor/bin/typo3 fluid:analyze` → `ddev exec … fluid analyze` →
  `vendor/bin/fluid analyze`, all with `--json --stdin`. If no binary is found
  it silently provides no diagnostics (completion/hover still work).

### ViewHelper data: project-dynamic (incl. custom ViewHelpers)

Completion/hover are **project-aware** and cover your **custom** ViewHelpers —
something the VS Code extension does not do (its README lists "only built-in
ViewHelpers … no XSD support yet"). On startup, in a TYPO3 13.2+ project, the
server runs

```
vendor/bin/typo3 fluid:schema:generate      # binary-detected, DDEV-aware
```

which writes XSD schema files for **every** registered namespace (core,
extensions and your own ViewHelpers) into `var/transient/`. The server parses
those XSDs and resolves completion/hover **per template** using its `xmlns:`
and `{namespace x=Vendor\Ext}` declarations:

- `<f:…>` → core/merged Fluid namespace,
- `<my:…>` where the file declares `{namespace my=Vendor\Ext\ViewHelpers}` →
  your custom ViewHelpers, with their real attributes + docblocks.

If schema generation isn't available (no `typo3` binary, older TYPO3), it falls
back to the bundled `server/viewhelpers.json` — a curated seed of 30 core
ViewHelpers (VS Code HTML custom-data shape) so `<f:…>` still works offline.

### Configuration

Configure via Zed settings (`lsp."fluid-language-server".settings`):

```json [settings]
{
  "lsp": {
    "fluid-language-server": {
      "settings": {
        "bin": { "useDdevIfAvailable": true, "fluid": { "path": "", "args": [] } },
        "features": {
          "liveTemplateAnalysis": true,
          "generateViewHelperSchema": true
        }
      }
    }
  }
}
```

## Requirements

- **Node.js** — Zed supplies a managed Node to run the language server.
- **Rust toolchain** with a `wasm32-wasip2` target — Zed compiles this
  extension's Rust glue (`src/lib.rs`) to WebAssembly on install
  (`rustup target add wasm32-wasip2`).

## Install (development)

1. Clone this repo (and the sibling `tree-sitter-fluid` repo the grammar points
   at).
2. In Zed: **Extensions → Install Dev Extension**, then select this directory.
   Zed builds the grammar and the Rust extension (first build takes a moment).
3. Open a file from `test/fixtures/` (e.g. `tag-viewhelpers.fluid.html`) and
   confirm highlighting. Type `f:for` + <kbd>Tab</kbd> for a snippet; type `<f:`
   for completion; hover a `<f:…>` tag for docs.
4. For logs, launch Zed with `zed --foreground`.

## Roadmap

- **Inline-syntax completion** inside `{f:…()}` expressions (currently tag
  syntax only, matching the source extension).
- **Smarter schema refresh** — regenerate XSDs only when ViewHelper sources
  change, rather than once per server start.
- **Publish:** push `tree-sitter-fluid` to GitHub (swap the `file://` grammar URL
  for the GitHub URL) and submit to the Zed extension registry.

## Credits

Grammar scope design, snippets and ViewHelper data derive from
[FriendsOfTYPO3/vscode-fluid-language](https://github.com/FriendsOfTYPO3/vscode-fluid-language).
