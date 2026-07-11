import { useEffect, useState } from 'preact/hooks';
import { Plus, RefreshCw, Trash2 } from 'lucide-preact';
import {
    DEFAULT_MODELS,
    REASONING_EFFORT_OPTIONS,
    getAiSettings,
    getRegisteredBaseUrlConfigs,
    getAvailableModels,
    saveAiSettings,
    testAiConnection,
} from '../../services/ai';
import { MESSAGES_JA } from '@tik-choco/mistai';
import { ConsumerStatusIndicator, ProviderStatusPanel } from '@tik-choco/mistai/preact';
import { useMistllm } from '../../hooks/useMistllm';
import { useNetworkProvider } from '../../hooks/useNetworkProvider';

const SETTINGS_TABS = [
    { key: 'api', label: 'API接続' },
    { key: 'models', label: 'モデル' },
    { key: 'network', label: 'ネットワーク' },
];

const MODEL_TASKS = [
    { key: 'explain', label: 'AI解説' },
    { key: 'translate', label: 'AI翻訳' },
    { key: 'chat', label: 'チャット' },
    { key: 'ocr', label: 'OCR' },
];

function NetworkProviderCard({ settings, updateSettings }) {
    const provider = useNetworkProvider({
        networkProviderEnabled: settings.networkProviderEnabled,
        mistllmRoomId: settings.mistllmRoomId,
    });

    return (
        <div className="settings-role-card">
            <label className="settings-role-head">
                <input
                    type="checkbox"
                    checked={Boolean(settings.networkProviderEnabled)}
                    onChange={(event) => updateSettings({ ...settings, networkProviderEnabled: event.target.checked })}
                />
                <span className="settings-role-title">
                    <strong>AIを提供する（プロバイダ）</strong>
                    <span className="hint">このデバイスのAPI設定を使って、ネットワーク上の他デバイスからのLLMリクエストを処理します。</span>
                </span>
            </label>
            {settings.networkProviderEnabled && (
                <div className="settings-role-body">
                    <ProviderStatusPanel
                        status={provider.status}
                        statusUpdatedAt={provider.statusUpdatedAt}
                        errorMessage={provider.errorMessage}
                        ownNodeId={provider.ownNodeId}
                        peers={provider.peers}
                        consumerCount={provider.consumerCount}
                        logs={provider.logs}
                        messages={MESSAGES_JA}
                        notice={!provider.upstreamConfigured ? (
                            <p className="mistai-status-detail error">
                                提供するには「API接続」タブでBase URL/APIキー、「モデル」タブでチャット用モデルを設定してください。
                            </p>
                        ) : null}
                    />
                </div>
            )}
        </div>
    );
}

export function SettingsPanel() {
    const [activeTab, setActiveTab] = useState('api');
    const [settings, setSettings] = useState(getAiSettings());
    const [availableModelsByBaseUrl, setAvailableModelsByBaseUrl] = useState({});
    const [loadingModelsForBaseUrl, setLoadingModelsForBaseUrl] = useState('');
    const [newBaseUrlLabel, setNewBaseUrlLabel] = useState('');
    const [newBaseUrl, setNewBaseUrl] = useState('');
    const [newBaseUrlApiKey, setNewBaseUrlApiKey] = useState('');
    const [connectionStatus, setConnectionStatus] = useState('');
    const [connectionError, setConnectionError] = useState('');
    const [isTestingConnection, setIsTestingConnection] = useState(false);
    const [roomIdInput, setRoomIdInput] = useState(settings.mistllmRoomId || '');
    const mistllm = useMistllm();

    useEffect(() => {
        const handleSyncUpdate = () => setSettings(getAiSettings());
        window.addEventListener('sync-data-updated', handleSyncUpdate);
        fetchModels();

        return () => window.removeEventListener('sync-data-updated', handleSyncUpdate);
    }, []);

    const fetchModels = async (baseUrl = settings.baseUrl, settingsOverride = settings) => {
        setLoadingModelsForBaseUrl(baseUrl);
        const models = await getAvailableModels({ ...settingsOverride, baseUrl });
        setAvailableModelsByBaseUrl((current) => ({ ...current, [baseUrl]: models }));
        setLoadingModelsForBaseUrl('');
    };

    const updateSettings = (nextSettings) => {
        const baseUrlConfigs = getRegisteredBaseUrlConfigs(nextSettings);
        const normalizedSettings = {
            ...nextSettings,
            baseUrlConfigs,
            baseUrls: baseUrlConfigs.map((config) => config.url),
        };
        setSettings(normalizedSettings);
        saveAiSettings(normalizedSettings);
        window.dispatchEvent(new CustomEvent('sync-data-updated'));
    };

    const handleAddBaseUrl = () => {
        const baseUrl = newBaseUrl.trim().replace(/\/$/, '');
        if (!baseUrl) return;

        const baseUrlConfigs = [
            ...getRegisteredBaseUrlConfigs(settings).filter((config) => config.url !== baseUrl),
            { label: newBaseUrlLabel.trim() || baseUrl, url: baseUrl, apiKey: newBaseUrlApiKey },
        ];
        updateSettings({
            ...settings,
            baseUrl,
            baseUrlConfigs,
            baseUrls: baseUrlConfigs.map((config) => config.url),
        });
        setNewBaseUrlLabel('');
        setNewBaseUrl('');
        setNewBaseUrlApiKey('');
        fetchModels(baseUrl, { ...settings, baseUrl, baseUrlConfigs });
    };

    const handleRemoveBaseUrl = (baseUrlToRemove) => {
        const baseUrlConfigs = getRegisteredBaseUrlConfigs(settings).filter((config) => config.url !== baseUrlToRemove);
        if (!baseUrlConfigs.length) return;

        const baseUrls = baseUrlConfigs.map((config) => config.url);
        const nextBaseUrl = settings.baseUrl === baseUrlToRemove ? baseUrls[0] : settings.baseUrl;
        const nextModelBaseUrls = Object.fromEntries(
            Object.entries(settings.modelBaseUrls || {}).map(([task, baseUrl]) => [
                task,
                baseUrl === baseUrlToRemove ? nextBaseUrl : baseUrl,
            ])
        );

        updateSettings({
            ...settings,
            baseUrl: nextBaseUrl,
            baseUrlConfigs,
            baseUrls,
            modelBaseUrls: nextModelBaseUrls,
        });
    };

    const handleUpdateBaseUrlApiKey = (baseUrlToUpdate, apiKey) => {
        const baseUrlConfigs = getRegisteredBaseUrlConfigs(settings).map((config) => (
            config.url === baseUrlToUpdate ? { ...config, apiKey } : config
        ));
        updateSettings({
            ...settings,
            baseUrlConfigs,
            baseUrls: baseUrlConfigs.map((config) => config.url),
        });
    };

    const handleUpdateBaseUrlLabel = (baseUrlToUpdate, label) => {
        const baseUrlConfigs = getRegisteredBaseUrlConfigs(settings).map((config) => (
            config.url === baseUrlToUpdate ? { ...config, label } : config
        ));
        updateSettings({
            ...settings,
            baseUrlConfigs,
            baseUrls: baseUrlConfigs.map((config) => config.url),
        });
    };

    const handleUpdateBaseUrlUrl = (baseUrlToUpdate, rawUrl) => {
        const newUrl = rawUrl.trim().replace(/\/$/, '');
        if (!newUrl || newUrl === baseUrlToUpdate) return;
        if (getRegisteredBaseUrlConfigs(settings).some((config) => config.url === newUrl)) return;

        const baseUrlConfigs = getRegisteredBaseUrlConfigs(settings).map((config) => (
            config.url === baseUrlToUpdate ? { ...config, url: newUrl } : config
        ));
        const nextModelBaseUrls = Object.fromEntries(
            Object.entries(settings.modelBaseUrls || {}).map(([task, baseUrl]) => [
                task,
                baseUrl === baseUrlToUpdate ? newUrl : baseUrl,
            ])
        );

        updateSettings({
            ...settings,
            baseUrl: settings.baseUrl === baseUrlToUpdate ? newUrl : settings.baseUrl,
            baseUrlConfigs,
            baseUrls: baseUrlConfigs.map((config) => config.url),
            modelBaseUrls: nextModelBaseUrls,
        });
        setAvailableModelsByBaseUrl((current) => {
            if (!(baseUrlToUpdate in current)) return current;
            const next = { ...current, [newUrl]: current[baseUrlToUpdate] };
            delete next[baseUrlToUpdate];
            return next;
        });
        fetchModels(newUrl, { ...settings, baseUrl: newUrl });
    };

    const handleTestConnection = async () => {
        setIsTestingConnection(true);
        setConnectionStatus(`Testing API connection: ${settings.baseUrl}`);
        setConnectionError('');

        try {
            const result = await testAiConnection(settings);
            setConnectionStatus(`Connected. ${result.modelCount} models available.`);
            await fetchModels(settings.baseUrl, settings);
        } catch (err) {
            setConnectionStatus('Connection failed');
            setConnectionError(err.message || String(err));
        } finally {
            setIsTestingConnection(false);
        }
    };

    // The mistllm consumer connection itself is maintained eagerly at the app
    // level (see hooks/useNetworkConsumerConnection.js, mounted in App.jsx) so
    // it stays live whether or not this panel is open; this panel only
    // reflects that connection's state via useMistllm() and saves settings.

    const handleConsumerToggle = (enabled) => {
        updateSettings({ ...settings, backend: enabled ? 'mistllm' : 'http' });
        if (!enabled) {
            mistllm.disconnect();
        }
    };

    const handleRoomIdCommit = () => {
        const roomId = roomIdInput.trim();
        updateSettings({ ...settings, mistllmRoomId: roomId });
    };

    const baseUrlConfigs = getRegisteredBaseUrlConfigs(settings);
    const baseUrls = baseUrlConfigs.map((config) => config.url);
    const getBaseUrlLabel = (baseUrl) => {
        const config = baseUrlConfigs.find((item) => item.url === baseUrl);
        return config?.label || baseUrl;
    };
    const isMistllm = settings.backend === 'mistllm';
    const mistllmProviderModels = Array.isArray(mistllm.providerModels) ? mistllm.providerModels : [];
    // Adapt the app's flat useMistllm() state to the library's ConsumerStatus
    // discriminated union consumed by the shared status components.
    const consumerStatus = mistllm.status === 'connected'
        ? { phase: 'connected', providerId: mistllm.providerId || '', models: mistllmProviderModels }
        : mistllm.status === 'error'
            // codeがあれば共有コンポーネント側でカタログ文言に整えられる（messageはフォールバック）。
            ? { phase: 'error', message: mistllm.errorMessage || '', code: mistllm.errorCode || undefined }
            : { phase: mistllm.status };
    const currentBaseUrlModels = availableModelsByBaseUrl[settings.baseUrl] || [];

    const renderApiTab = () => (
        <>
            {isMistllm && !settings.networkProviderEnabled && (
                <p className="hint">
                    現在はLLMネットワーク（コンシューマ）を利用中のため、この設定は使われません。プロバイダとしてAIを提供する場合や、ネットワークをオフにした場合に使用されます。
                </p>
            )}
            <div className="form-group">
                <label htmlFor="new-ai-base-url">Base URLs</label>
                <div className="base-url-add-row">
                    <input
                        id="new-ai-base-url-label"
                        name="new-ai-base-url-label"
                        value={newBaseUrlLabel}
                        onInput={(event) => setNewBaseUrlLabel(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') handleAddBaseUrl();
                        }}
                        placeholder="ラベル"
                        autoComplete="off"
                    />
                    <input
                        id="new-ai-base-url"
                        name="new-ai-base-url"
                        value={newBaseUrl}
                        onInput={(event) => setNewBaseUrl(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') handleAddBaseUrl();
                        }}
                        placeholder="https://..."
                        autoComplete="off"
                    />
                    <input
                        id="new-ai-base-url-api-key"
                        name="new-ai-base-url-api-key"
                        type="password"
                        value={newBaseUrlApiKey}
                        onInput={(event) => setNewBaseUrlApiKey(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') handleAddBaseUrl();
                        }}
                        placeholder="API Key（ローカルLLMでは省略可）"
                        autoComplete="off"
                    />
                    <button className="icon-form-btn" onClick={handleAddBaseUrl} title="Base URLを追加">
                        <Plus size={14} />
                    </button>
                </div>
                <div className="base-url-list">
                    {baseUrlConfigs.map((config) => (
                        <div key={config.url} className="base-url-item">
                            <input
                                value={config.label}
                                onInput={(event) => handleUpdateBaseUrlLabel(config.url, event.target.value)}
                                placeholder="ラベル"
                                autoComplete="off"
                            />
                            <input
                                value={config.url}
                                title={config.url}
                                onBlur={(event) => handleUpdateBaseUrlUrl(config.url, event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') event.target.blur();
                                }}
                                placeholder="https://..."
                                autoComplete="off"
                            />
                            <input
                                type="password"
                                value={config.apiKey || ''}
                                onInput={(event) => handleUpdateBaseUrlApiKey(config.url, event.target.value)}
                                placeholder="API Key"
                                autoComplete="off"
                            />
                            <button
                                className="icon-form-btn is-danger"
                                onClick={() => handleRemoveBaseUrl(config.url)}
                                disabled={baseUrls.length <= 1}
                                title="Base URLを削除"
                            >
                                <Trash2 size={13} />
                            </button>
                        </div>
                    ))}
                </div>
            </div>
            <div className="form-group">
                <button className="save-btn" onClick={handleTestConnection} disabled={isTestingConnection}>
                    <RefreshCw size={14} className={isTestingConnection ? 'spinning' : ''} />
                    API接続テスト
                </button>
                {(connectionStatus || connectionError) && (
                    <div className="settings-test-result">
                        <span className={connectionError ? 'error' : ''}>{connectionError || connectionStatus}</span>
                    </div>
                )}
            </div>
        </>
    );

    const renderModelsTab = () => (
        <div className="form-group">
            <div className="model-header">
                <label>タスク別モデル</label>
                {!isMistllm && (
                    <button
                        className="refresh-btn"
                        onClick={() => fetchModels(settings.baseUrl)}
                        disabled={Boolean(loadingModelsForBaseUrl)}
                        title="モデル一覧を再取得"
                    >
                        <RefreshCw size={12} className={loadingModelsForBaseUrl ? 'spinning' : ''} />
                    </button>
                )}
            </div>
            {isMistllm ? (
                <p className="hint">
                    {mistllmProviderModels.length > 0
                        ? `プロバイダから${mistllmProviderModels.length}件のモデルを取得済みです。一覧から選択してください（接続先の選択は不要です）。`
                        : 'プロバイダに接続するとモデル一覧を取得できます。未取得の間はモデル名を直接入力してください（接続先の選択は不要です）。'}
                </p>
            ) : (
                <p className="model-status">
                    {loadingModelsForBaseUrl
                        ? 'モデル一覧を取得中…'
                        : currentBaseUrlModels.length > 0
                            ? `${currentBaseUrlModels.length}件のモデルを取得済み`
                            : 'モデル一覧が未取得です。「API接続」タブで接続テストするか、更新ボタンを押してください。'}
                </p>
            )}
            {MODEL_TASKS.map((task) => {
                const currentModel = settings.models?.[task.key] || '';
                const selectedBaseUrl = settings.modelBaseUrls?.[task.key] || settings.baseUrl;
                const selectedReasoningEffort = settings.modelReasoningEfforts?.[task.key] || settings.reasoningEffort || 'none';
                const modelOptions = Array.from(new Set([
                    ...DEFAULT_MODELS,
                    ...(availableModelsByBaseUrl[selectedBaseUrl] || []),
                    currentModel,
                ].filter(Boolean))).sort();
                const selectedModel = modelOptions.includes(currentModel) ? currentModel : '';
                const mistllmModelOptions = Array.from(new Set(
                    [...mistllmProviderModels, currentModel].filter(Boolean)
                ));

                return (
                    <div key={task.key} className="task-model-item">
                        <span>{task.label}</span>
                        <div className="task-model-fields">
                            {!isMistllm && (
                                <div className="task-model-field">
                                    <label htmlFor={`select-base-url-${task.key}`}>接続先</label>
                                    <select
                                        id={`select-base-url-${task.key}`}
                                        name={`select-base-url-${task.key}`}
                                        value={selectedBaseUrl}
                                        onChange={(event) => {
                                            const baseUrl = event.target.value;
                                            updateSettings({
                                                ...settings,
                                                modelBaseUrls: { ...settings.modelBaseUrls, [task.key]: baseUrl },
                                            });
                                            if (!availableModelsByBaseUrl[baseUrl]) fetchModels(baseUrl);
                                        }}
                                        autoComplete="off"
                                    >
                                        {baseUrlConfigs.map((config) => (
                                            <option key={config.url} value={config.url}>{getBaseUrlLabel(config.url)}</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                            <div className="task-model-field">
                                <label htmlFor={`select-model-${task.key}`}>モデル</label>
                                {isMistllm ? (
                                    mistllmModelOptions.length > 0 ? (
                                        <select
                                            id={`select-model-${task.key}`}
                                            name={`select-model-${task.key}`}
                                            value={currentModel}
                                            onChange={(event) => {
                                                updateSettings({
                                                    ...settings,
                                                    models: { ...settings.models, [task.key]: event.target.value },
                                                });
                                            }}
                                            autoComplete="off"
                                        >
                                            <option value="">(選択...)</option>
                                            {mistllmModelOptions.map((model) => (
                                                <option key={model} value={model}>{model}</option>
                                            ))}
                                        </select>
                                    ) : (
                                        <input
                                            id={`select-model-${task.key}`}
                                            name={`select-model-${task.key}`}
                                            value={currentModel}
                                            onInput={(event) => {
                                                updateSettings({
                                                    ...settings,
                                                    models: { ...settings.models, [task.key]: event.target.value },
                                                });
                                            }}
                                            placeholder="モデル名を入力"
                                            autoComplete="off"
                                        />
                                    )
                                ) : (
                                    <select
                                        id={`select-model-${task.key}`}
                                        name={`select-model-${task.key}`}
                                        value={selectedModel}
                                        onChange={(event) => {
                                            updateSettings({
                                                ...settings,
                                                models: { ...settings.models, [task.key]: event.target.value },
                                            });
                                        }}
                                        autoComplete="off"
                                    >
                                        <option value="">(選択...)</option>
                                        {modelOptions.map((model) => (
                                            <option key={model} value={model}>{model}</option>
                                        ))}
                                    </select>
                                )}
                            </div>
                            <div className="task-model-field">
                                <label htmlFor={`select-reasoning-effort-${task.key}`}>reasoning</label>
                                <select
                                    id={`select-reasoning-effort-${task.key}`}
                                    name={`select-reasoning-effort-${task.key}`}
                                    value={selectedReasoningEffort}
                                    onChange={(event) => {
                                        updateSettings({
                                            ...settings,
                                            modelReasoningEfforts: {
                                                ...settings.modelReasoningEfforts,
                                                [task.key]: event.target.value,
                                            },
                                        });
                                    }}
                                    autoComplete="off"
                                >
                                    {REASONING_EFFORT_OPTIONS.map((effort) => (
                                        <option key={effort} value={effort}>{effort}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );

    const renderNetworkTab = () => (
        <>
            <p className="hint">
                Mist LLMネットワーク（P2P）では、同じRoom IDに参加したデバイス同士でLLMを共有できます。
            </p>
            <div className="form-group">
                <label htmlFor="mistllm-room-id">Room ID</label>
                <input
                    id="mistllm-room-id"
                    name="mistllm-room-id"
                    value={roomIdInput}
                    onInput={(event) => setRoomIdInput(event.target.value)}
                    onBlur={handleRoomIdCommit}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') event.target.blur();
                    }}
                    placeholder="room-id"
                    autoComplete="off"
                />
            </div>
            <div className="settings-role-card">
                <label className="settings-role-head">
                    <input
                        type="checkbox"
                        checked={isMistllm}
                        onChange={(event) => handleConsumerToggle(event.target.checked)}
                    />
                    <span className="settings-role-title">
                        <strong>ネットワークのAIを利用する（コンシューマ）</strong>
                        <span className="hint">AI解説・翻訳・チャット・OCRの処理を、ネットワーク上のプロバイダに依頼します。</span>
                    </span>
                </label>
                {isMistllm && (
                    <div className="settings-role-body">
                        <ConsumerStatusIndicator
                            status={consumerStatus}
                            updatedAt={mistllm.updatedAt}
                            variant="detailed"
                            messages={MESSAGES_JA}
                        />
                    </div>
                )}
            </div>
            <NetworkProviderCard settings={settings} updateSettings={updateSettings} />
        </>
    );

    return (
        <div className="settings-section">
            <h3>AI 設定</h3>
            <div className="settings-tab-bar" role="tablist">
                {SETTINGS_TABS.map((tab) => (
                    <button
                        key={tab.key}
                        type="button"
                        role="tab"
                        aria-selected={activeTab === tab.key}
                        className={`settings-tab ${activeTab === tab.key ? 'active' : ''}`}
                        onClick={() => setActiveTab(tab.key)}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
            <div className="settings-tab-panel" role="tabpanel">
                {activeTab === 'api' && renderApiTab()}
                {activeTab === 'models' && renderModelsTab()}
                {activeTab === 'network' && renderNetworkTab()}
            </div>
        </div>
    );
}
