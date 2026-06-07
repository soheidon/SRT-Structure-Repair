import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LlmConfig, LlmProviderInfo } from "../types";

interface LlmSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  onConfigChanged: (config: LlmConfig) => void;
}

export default function LlmSettings({
  isOpen,
  onClose,
  onConfigChanged,
}: LlmSettingsProps) {
  const [providers, setProviders] = useState<LlmProviderInfo[]>([]);
  const [selectedProvider, setSelectedProvider] = useState("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const currentProvider = providers.find((p) => p.id === selectedProvider);
  const isCustom = selectedProvider === "custom";

  // Load providers and config on modal open
  useEffect(() => {
    if (!isOpen) return;

    (async () => {
      const [pList, cfg] = await Promise.all([
        invoke<LlmProviderInfo[]>("scan_llm_providers"),
        invoke<LlmConfig>("get_llm_config"),
      ]);
      setProviders(pList);

      if (cfg.provider) {
        setSelectedProvider(cfg.provider);
        setBaseUrl(cfg.base_url);
        setModel(cfg.model);
        if (cfg.provider === "custom") {
          // Reload key value for custom (stored in env var)
          setApiKeyValue(cfg.configured ? "••••existing••••" : "");
        }
      } else {
        // First time: default to OpenAI
        const openai = pList.find((p) => p.id === "openai");
        setSelectedProvider("openai");
        setBaseUrl(openai?.default_base_url ?? "https://api.openai.com/v1");
        setModel(openai?.default_model ?? "gpt-5.5");
      }

      setTestResult(null);
      setMessage(null);
    })();
  }, [isOpen]);

  // When provider changes, pre-fill defaults
  const handleProviderChange = useCallback(
    (id: string) => {
      setSelectedProvider(id);
      setTestResult(null);
      setMessage(null);

      const p = providers.find((pr) => pr.id === id);
      if (id === "custom") {
        setBaseUrl("");
        setModel("");
        setApiKeyValue("");
        // Try to load existing custom key
        invoke<LlmConfig>("get_llm_config").then((cfg) => {
          if (cfg.provider === "custom" && cfg.configured) {
            setApiKeyValue("••••existing••••");
          }
        });
      } else if (p) {
        setBaseUrl(p.default_base_url);
        setModel(p.default_model);
        setApiKeyValue("");
      }
    },
    [providers]
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    try {
      if (isCustom) {
        // For Custom, pass the actual key value
        // Only send if changed (not the placeholder)
        const keyToSave =
          apiKeyValue === "••••existing••••" ? null : apiKeyValue || null;
        await invoke("save_llm_config", {
          provider: "custom",
          baseUrl: baseUrl || "",
          model: model || "",
          apiKeyEnv: "SRT_REPAIR_LLM_API_KEY",
          apiKeyValue: keyToSave,
        });
      } else if (currentProvider) {
        await invoke("save_llm_config", {
          provider: selectedProvider,
          baseUrl,
          model,
          apiKeyEnv: currentProvider.api_key_env,
          apiKeyValue: null,
        });
      }

      // Refresh config for caller
      const updated = await invoke<LlmConfig>("get_llm_config");
      onConfigChanged(updated);
      setMessage("保存しました。");
    } catch (e) {
      setMessage(`保存に失敗しました: ${e}`);
    } finally {
      setSaving(false);
    }
  }, [isCustom, selectedProvider, baseUrl, model, apiKeyValue, currentProvider, onConfigChanged]);

  const handleClear = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    try {
      await invoke("delete_llm_config");
      setSelectedProvider("openai");
      const openai = providers.find((p) => p.id === "openai");
      setBaseUrl(openai?.default_base_url ?? "https://api.openai.com/v1");
      setModel(openai?.default_model ?? "gpt-5.5");
      setApiKeyValue("");
      onConfigChanged({
        provider: "",
        base_url: "",
        model: "",
        api_key_env: "",
        configured: false,
      });
      setMessage("設定を削除しました。");
    } catch (e) {
      setMessage(`削除に失敗しました: ${e}`);
    } finally {
      setSaving(false);
    }
  }, [providers, onConfigChanged]);

  const handleTest = useCallback(async () => {
    if (!currentProvider) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await invoke<string>("test_llm_connection", {
        baseUrl: baseUrl || currentProvider.default_base_url,
        model: model || currentProvider.default_model,
        apiKeyEnv: currentProvider.api_key_env,
        apiKeyFallback: currentProvider.api_key_env_fallback ?? null,
      });
      setTestResult(result);
    } catch (e) {
      setTestResult(`接続テスト失敗: ${e}`);
    } finally {
      setTesting(false);
    }
  }, [baseUrl, model, currentProvider]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>AIの設定</h2>

        {/* Provider selector */}
        <div className="modal-field">
          <label>プロバイダ:</label>
          <div className="provider-list">
            {providers.map((p) => (
              <div
                key={p.id}
                className={`provider-card ${
                  selectedProvider === p.id ? "selected" : ""
                }`}
                onClick={() => handleProviderChange(p.id)}
              >
                <div className="provider-info">
                  <span className="provider-name">{p.name}</span>
                  {p.display_model && (
                    <span className="provider-model">
                      {p.display_model}
                    </span>
                  )}
                </div>
                <span
                  className={`provider-badge ${
                    p.detected ? "detected" : "not-detected"
                  }`}
                >
                  {p.detected ? "✓ 検出" : "- 未検出"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Base URL */}
        <div className="modal-field">
          <label>API Base URL:</label>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={
              currentProvider?.default_base_url || "https://api.example.com/v1"
            }
          />
        </div>

        {/* Model */}
        <div className="modal-field">
          <label>モデル名:</label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={currentProvider?.default_model || "model-name"}
          />
        </div>

        {/* API Key section */}
        {isCustom ? (
          <div className="modal-field">
            <label>APIキー:</label>
            <input
              type="password"
              value={apiKeyValue}
              onChange={(e) => setApiKeyValue(e.target.value)}
              placeholder="sk-..."
            />
            {apiKeyValue === "••••existing••••" && (
              <div className="masked-key">
                既存のキーが保存されています。変更する場合のみ入力してください。
              </div>
            )}
            <div className="modal-note">
              APIキーはこのPCのユーザー環境変数 SRT_REPAIR_LLM_API_KEY に保存されます。
              共有PCでは使用しないでください。
            </div>
          </div>
        ) : (
          <div className="modal-field">
            <label>APIキー環境変数:</label>
            <div className="api-key-env-display">
              <span className="env-var-name">
                {currentProvider?.api_key_env ?? ""}
              </span>
              {currentProvider?.api_key_env_fallback && (
                <span className="env-var-fallback">
                  （または {currentProvider.api_key_env_fallback}）
                </span>
              )}
            </div>
            <div className="env-var-hint">
              <span
                className={
                  currentProvider?.detected ? "key-detected" : "key-not-detected"
                }
              >
                {currentProvider?.detected
                  ? "✓ 環境変数が検出されました"
                  : "✗ 環境変数が見つかりません"}
              </span>
            </div>
            <div className="modal-note">
              このキーはお使いの環境変数から読み取られます。
              アプリには保存されません。
            </div>
          </div>
        )}

        {testResult && (
          <div
            className={`test-result ${
              testResult.includes("成功") ? "test-success" : "test-error"
            }`}
          >
            {testResult}
          </div>
        )}

        {message && <div className="modal-message">{message}</div>}

        <div className="modal-actions">
          <button
            className="modal-btn test-btn"
            onClick={handleTest}
            disabled={testing}
          >
            {testing ? "テスト中..." : "接続テスト"}
          </button>
          <button
            className="modal-btn save-btn"
            onClick={handleSave}
            disabled={saving}
          >
            {saving
              ? "保存中..."
              : isCustom
                ? "保存"
                : "この設定を使う"}
          </button>
          {isCustom && (
            <button
              className="modal-btn clear-btn"
              onClick={handleClear}
              disabled={saving}
            >
              Custom設定を削除
            </button>
          )}
          <button className="modal-btn close-btn" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
