//! Zed extension glue for TYPO3 Fluid.
//!
//! Downloads the dependency-free Node language server (`server.js` +
//! `viewhelpers.json`, shipped as a `.tar.gz` asset on this repo's GitHub
//! releases) and runs it via Zed's Node. User settings under
//! `lsp."fluid-language-server".settings` are forwarded to the server.

use zed_extension_api::{
    self as zed, serde_json::Value, settings::LspSettings, Command, DownloadedFileType,
    GithubReleaseOptions, LanguageServerId, LanguageServerInstallationStatus, Result, Worktree,
};

const SERVER_NAME: &str = "fluid-language-server";
const REPO: &str = "balatD/zed-typo3-fluid";
const ASSET_NAME: &str = "fluid-language-server.tar.gz";

struct FluidExtension {
    cached_server_path: Option<String>,
}

impl FluidExtension {
    /// Resolve an absolute path to `server.js`, downloading + extracting the
    /// release asset into the extension work dir on first use (or after an
    /// update). The asset contains `server.js` and `viewhelpers.json`.
    fn server_script_path(&mut self, language_server_id: &LanguageServerId) -> Result<String> {
        if let Some(path) = &self.cached_server_path {
            if std::fs::metadata(path).is_ok_and(|m| m.is_file()) {
                return Ok(path.clone());
            }
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &LanguageServerInstallationStatus::CheckingForUpdate,
        );
        let release = zed::latest_github_release(
            REPO,
            GithubReleaseOptions { require_assets: true, pre_release: false },
        )?;
        let asset = release
            .assets
            .iter()
            .find(|a| a.name == ASSET_NAME)
            .ok_or_else(|| format!("release {} has no asset {ASSET_NAME}", release.version))?;

        let version_dir = format!("{SERVER_NAME}-{}", release.version);
        let server_path = format!("{version_dir}/server.js");

        if !std::fs::metadata(&server_path).is_ok_and(|m| m.is_file()) {
            zed::set_language_server_installation_status(
                language_server_id,
                &LanguageServerInstallationStatus::Downloading,
            );
            zed::download_file(&asset.download_url, &version_dir, DownloadedFileType::GzipTar)
                .map_err(|e| format!("failed to download {ASSET_NAME}: {e}"))?;

            // Drop older downloaded versions.
            if let Ok(entries) = std::fs::read_dir(".") {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.starts_with(&format!("{SERVER_NAME}-")) && name != version_dir {
                        let _ = std::fs::remove_dir_all(entry.path());
                    }
                }
            }
        }

        self.cached_server_path = Some(server_path.clone());
        Ok(server_path)
    }
}

impl zed::Extension for FluidExtension {
    fn new() -> Self {
        FluidExtension { cached_server_path: None }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        _worktree: &Worktree,
    ) -> Result<Command> {
        let server_path = self.server_script_path(language_server_id)?;
        zed::set_language_server_installation_status(
            language_server_id,
            &LanguageServerInstallationStatus::None,
        );

        // The language server process' cwd is the worktree root, not the
        // extension dir, so the script path must be absolute.
        let extension_dir =
            std::env::current_dir().map_err(|e| format!("cannot resolve work dir: {e}"))?;
        let server = extension_dir.join(&server_path);

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
