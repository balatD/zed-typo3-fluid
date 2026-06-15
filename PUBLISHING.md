# Publishing checklist

Steps to publish **TYPO3 Fluid** to the Zed extension registry
([zed-industries/extensions](https://github.com/zed-industries/extensions)).

## 1. Host the grammar (hard requirement)

Zed's registry CI clones the grammar from a **public git URL** at the pinned
commit — a local `file://` path cannot be built. Push the grammar repo:

```bash
cd ../tree-sitter-fluid
git remote add origin https://github.com/balatD/tree-sitter-fluid.git
git push -u origin main
git rev-parse HEAD          # note this SHA
```

Then in `extension.toml` set:

```toml
[grammars.fluid]
repository = "https://github.com/balatD/tree-sitter-fluid"
commit = "<the pushed SHA>"
```

Verify a **fresh clone** builds (not just the local checkout): the committed
`src/parser.c`, `src/scanner.c`, `src/tag.h` and `src/tree_sitter/*` headers are
all present, so it is self-contained.

## 2. Host the extension

```bash
git remote add origin https://github.com/balatD/zed-typo3-fluid.git
git push -u origin main
```

`extension.toml` `repository` and the grammar `tree-sitter.json`/README already
point at `github.com/balatD/…` — just make sure those repos exist and are public.

## 3. Confirm it installs

Zed → Extensions → **Install Dev Extension** → select this directory. Confirm the
Rust + grammar compile and the language server starts (`zed --foreground`:
`[fluid] initialized …`). Requires the Rust toolchain with the `wasm32-wasip2`
target installed.

## 4. (Optional) bump version

`version = "0.1.0"` in `extension.toml` for the first public release.

## 5. Submit to the registry

```bash
# fork + clone zed-industries/extensions, then:
git submodule add https://github.com/balatD/zed-typo3-fluid.git extensions/fluid
```

Add an entry to that repo's top-level `extensions.toml`:

```toml
[fluid]
submodule = "extensions/fluid"
version = "0.1.0"     # must match this extension.toml
```

Commit and open a PR against `zed-industries/extensions`. CI builds the grammar
and the Rust extension on its own infrastructure; both must compile from the
public URLs.

## Pre-flight

- [ ] `LICENSE` present (MIT) ✓
- [ ] grammar pushed; `[grammars.fluid].repository` is a public URL + pushed SHA
- [ ] extension pushed; `repository` is the real public URL (no `your-org`)
- [ ] placeholder `your-org` gone from `tree-sitter.json` (both copies) and grammar README
- [ ] `target/`, `grammars/`, `*.wasm`, `test/xsd/` gitignored ✓
- [ ] fresh dev-install compiles and the LSP starts
