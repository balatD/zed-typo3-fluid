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
        // Resolve an absolute path to the bundled server (the spawned process'
        // cwd is the worktree root, not the extension dir, so a relative path
        // would not resolve).
        let extension_dir =
            std::env::current_dir().map_err(|e| format!("cannot resolve extension dir: {e}"))?;
        let server = extension_dir.join("server").join("server.js");

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
