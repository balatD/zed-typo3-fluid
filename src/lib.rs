//! Zed extension glue for TYPO3 Fluid.
//!
//! Spawns the bundled dependency-free Node language server
//! (`server/server.js`) which provides ViewHelper completion, hover
//! documentation and live template diagnostics. User settings under
//! `lsp."fluid-language-server".settings` are forwarded to the server.

use zed_extension_api::{
    self as zed, serde_json::Value, settings::LspSettings, Command, LanguageServerId, Result,
    Worktree,
};

const SERVER_NAME: &str = "fluid-language-server";

struct FluidExtension;

impl zed::Extension for FluidExtension {
    fn new() -> Self {
        FluidExtension
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        _worktree: &Worktree,
    ) -> Result<Command> {
        // Zed does not copy loose extension files (server/) into the work dir,
        // and the wasm sandbox can only read its work dir (== current_dir).
        // So we embed the server + ViewHelper data at compile time and
        // materialize them into the work dir on startup. server.js reads
        // viewhelpers.json from its own __dirname, so both go side by side.
        let dir =
            std::env::current_dir().map_err(|e| format!("cannot resolve work dir: {e}"))?;
        let server = dir.join("fluid-language-server.js");
        std::fs::write(&server, include_str!("../server/server.js"))
            .map_err(|e| format!("cannot write language server: {e}"))?;
        std::fs::write(
            dir.join("viewhelpers.json"),
            include_str!("../server/viewhelpers.json"),
        )
        .map_err(|e| format!("cannot write ViewHelper data: {e}"))?;

        Ok(Command {
            command: zed::node_binary_path()?,
            args: vec![server.to_string_lossy().into_owned(), "--stdio".into()],
            env: Default::default(),
        })
    }

    fn language_server_workspace_configuration(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<Value>> {
        // Forward `lsp."fluid-language-server".settings` (bin paths, DDEV
        // toggle, liveTemplateAnalysis) to the server.
        let settings = LspSettings::for_worktree(SERVER_NAME, worktree)
            .ok()
            .and_then(|s| s.settings)
            .unwrap_or_default();
        Ok(Some(settings))
    }
}

zed::register_extension!(FluidExtension);
