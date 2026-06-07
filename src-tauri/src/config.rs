use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::types::{LlmConfig, KNOWN_PROVIDERS};

// ── Config file path ──────────────────────────────────────────────────────

fn config_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        PathBuf::from(appdata).join("SRTRepair")
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home).join("Library").join("Application Support").join("SRTRepair")
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let xdg = std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_default();
            format!("{}/.config", home)
        });
        PathBuf::from(xdg).join("SRTRepair")
    }
}

fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

// ── Structs ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub ai: AiSettings,
    #[serde(default)]
    pub workspace: WorkspaceSettings,
    #[serde(default)]
    pub ui: UiSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSettings {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_key_env: String,
    #[serde(default)]
    pub last_successful_provider: String,
    #[serde(default)]
    pub last_successful_model: String,
    #[serde(default)]
    pub connection_verified_at: String, // ISO 8601, empty if never verified
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSettings {
    #[serde(default)]
    pub work_dir: String, // absolute path, empty = use default
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiSettings {
    #[serde(default = "default_tab")]
    pub last_opened_settings_tab: String, // "ai" or "workdir"
}

fn default_tab() -> String {
    "ai".to_string()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            ai: AiSettings::default(),
            workspace: WorkspaceSettings::default(),
            ui: UiSettings::default(),
        }
    }
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            provider: String::new(),
            base_url: String::new(),
            model: String::new(),
            api_key_env: String::new(),
            last_successful_provider: String::new(),
            last_successful_model: String::new(),
            connection_verified_at: String::new(),
        }
    }
}

impl Default for WorkspaceSettings {
    fn default() -> Self {
        Self {
            work_dir: String::new(),
        }
    }
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            last_opened_settings_tab: "ai".to_string(),
        }
    }
}

// ── ConfigManager ─────────────────────────────────────────────────────────

pub struct ConfigManager {
    path: PathBuf,
    config: AppConfig,
}

impl ConfigManager {
    /// Load config from disk. Migrates from legacy env vars if no JSON file exists.
    pub fn load() -> Result<Self, String> {
        let path = config_path();
        let config = if path.exists() {
            let json = std::fs::read_to_string(&path)
                .map_err(|e| format!("設定ファイルを読み込めません: {}", e))?;
            serde_json::from_str(&json)
                .map_err(|e| format!("設定ファイルの解析に失敗しました: {}", e))?
        } else {
            // Migrate from legacy env vars
            let migrated = Self::migrate_from_env()?;
            // Ensure parent directory exists
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("設定フォルダを作成できません: {}", e))?;
            }
            atomic_write(&path, &migrated)?;
            // Delete old env vars
            Self::cleanup_env_vars();
            migrated
        };

        Ok(Self { path, config })
    }

    /// Migrate settings from legacy environment variables.
    fn migrate_from_env() -> Result<AppConfig, String> {
        let provider = crate::env_config::read_config("SRT_REPAIR_LLM_PROVIDER").unwrap_or_default();
        let base_url = crate::env_config::read_config("SRT_REPAIR_LLM_BASE_URL").unwrap_or_default();
        let model = crate::env_config::read_config("SRT_REPAIR_LLM_MODEL").unwrap_or_default();
        let api_key_env = if provider == "custom" {
            "SRT_REPAIR_LLM_API_KEY".to_string()
        } else if !provider.is_empty() {
            let kp = KNOWN_PROVIDERS.iter().find(|p| p.id == provider);
            let stored = crate::env_config::read_config("SRT_REPAIR_LLM_API_KEY").unwrap_or_default();
            if !stored.is_empty() {
                stored
            } else {
                kp.map(|p| p.api_key_env.to_string()).unwrap_or_default()
            }
        } else {
            String::new()
        };

        // Fill defaults for known providers
        let (base_url, model) = if provider.is_empty() || provider == "custom" {
            (base_url, model)
        } else if let Some(kp) = KNOWN_PROVIDERS.iter().find(|p| p.id == provider) {
            (
                if base_url.is_empty() { kp.default_base_url.to_string() } else { base_url },
                if model.is_empty() { kp.default_model.to_string() } else { model },
            )
        } else {
            (base_url, model)
        };

        let work_dir = crate::env_config::read_config("SRT_REPAIR_WORK_DIR").unwrap_or_default();

        Ok(AppConfig {
            ai: AiSettings {
                provider,
                base_url,
                model,
                api_key_env,
                ..Default::default()
            },
            workspace: WorkspaceSettings { work_dir },
            ui: UiSettings::default(),
        })
    }

    /// Delete legacy env vars after successful migration.
    fn cleanup_env_vars() {
        let _ = crate::env_config::delete_config("SRT_REPAIR_LLM_PROVIDER");
        let _ = crate::env_config::delete_config("SRT_REPAIR_LLM_BASE_URL");
        let _ = crate::env_config::delete_config("SRT_REPAIR_LLM_MODEL");
        let _ = crate::env_config::delete_config("SRT_REPAIR_LLM_API_KEY");
        let _ = crate::env_config::delete_config("SRT_REPAIR_WORK_DIR");
    }

    /// Save config to disk atomically.
    fn save(&self) -> Result<(), String> {
        atomic_write(&self.path, &self.config)
    }

    // ── AI ──────────────────────────────────────────────────────────────

    pub fn to_llm_config(&self) -> LlmConfig {
        let ai = &self.config.ai;
        let provider = ai.provider.clone();

        // Fill defaults for known providers
        let (base_url, model) = if provider.is_empty() || provider == "custom" {
            (ai.base_url.clone(), ai.model.clone())
        } else if let Some(kp) = KNOWN_PROVIDERS.iter().find(|p| p.id == provider) {
            (
                if ai.base_url.is_empty() { kp.default_base_url.to_string() } else { ai.base_url.clone() },
                if ai.model.is_empty() { kp.default_model.to_string() } else { ai.model.clone() },
            )
        } else {
            (ai.base_url.clone(), ai.model.clone())
        };

        let api_key_env = if ai.api_key_env.is_empty() {
            if provider == "custom" {
                "SRT_REPAIR_LLM_API_KEY".to_string()
            } else if let Some(kp) = KNOWN_PROVIDERS.iter().find(|p| p.id == provider) {
                kp.api_key_env.to_string()
            } else {
                String::new()
            }
        } else {
            ai.api_key_env.clone()
        };

        // Check if the API key env var has a value (process env only — API keys
        // set by the system are always in the process environment)
        let configured = if provider == "custom" {
            std::env::var("SRT_REPAIR_LLM_API_KEY").map(|v| !v.is_empty()).unwrap_or(false)
        } else if !api_key_env.is_empty() {
            let primary = std::env::var(&api_key_env).unwrap_or_default();
            if !primary.is_empty() {
                true
            } else {
                // Check fallback for known providers
                KNOWN_PROVIDERS
                    .iter()
                    .find(|p| p.id == provider)
                    .and_then(|p| p.api_key_env_fallback)
                    .map(|fb| std::env::var(fb).map(|v| !v.is_empty()).unwrap_or(false))
                    .unwrap_or(false)
            }
        } else {
            false
        };

        LlmConfig {
            provider,
            base_url,
            model,
            api_key_env,
            configured,
            last_successful_provider: ai.last_successful_provider.clone(),
            last_successful_model: ai.last_successful_model.clone(),
            connection_verified_at: ai.connection_verified_at.clone(),
        }
    }

    pub fn set_ai_config(
        &mut self,
        provider: &str,
        base_url: &str,
        model: &str,
        api_key_env: &str,
    ) -> Result<(), String> {
        self.config.ai.provider = provider.to_string();
        self.config.ai.base_url = base_url.to_string();
        self.config.ai.model = model.to_string();
        self.config.ai.api_key_env = api_key_env.to_string();
        self.save()
    }

    pub fn clear_ai_config(&mut self) -> Result<(), String> {
        self.config.ai = AiSettings::default();
        self.save()
    }

    pub fn mark_connection_success(&mut self, provider: &str, model: &str) -> Result<(), String> {
        self.config.ai.last_successful_provider = provider.to_string();
        self.config.ai.last_successful_model = model.to_string();
        self.config.ai.connection_verified_at =
            chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%:z").to_string();
        self.save()
    }

    // ── Workspace ───────────────────────────────────────────────────────

    pub fn work_dir(&self) -> Option<&str> {
        let d = &self.config.workspace.work_dir;
        if d.is_empty() {
            None
        } else {
            Some(d.as_str())
        }
    }

    pub fn set_work_dir(&mut self, dir: &str) -> Result<(), String> {
        self.config.workspace.work_dir = dir.to_string();
        self.save()
    }

    pub fn reset_work_dir(&mut self) -> Result<(), String> {
        self.config.workspace.work_dir = String::new();
        self.save()
    }

    // ── UI ──────────────────────────────────────────────────────────────

    pub fn last_settings_tab(&self) -> &str {
        &self.config.ui.last_opened_settings_tab
    }

    pub fn set_last_settings_tab(&mut self, tab: &str) -> Result<(), String> {
        self.config.ui.last_opened_settings_tab = tab.to_string();
        self.save()
    }
}

// ── Atomic write helper ───────────────────────────────────────────────────

fn atomic_write(path: &PathBuf, config: &AppConfig) -> Result<(), String> {
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("設定フォルダを作成できません: {}", e))?;
    let tmp = dir.join(".config.json.tmp");
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("設定のシリアライズに失敗しました: {}", e))?;
    std::fs::write(&tmp, json)
        .map_err(|e| format!("設定ファイルを書き込めません: {}", e))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("設定ファイルを保存できません: {}", e))?;
    Ok(())
}
