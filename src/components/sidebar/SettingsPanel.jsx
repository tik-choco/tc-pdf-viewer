import { useEffect, useState } from 'preact/hooks';
import { Plus, RefreshCw, Trash2 } from 'lucide-preact';
import {
    DEFAULT_MODELS,
    getAiSettings,
    getRegisteredBaseUrlConfigs,
    getAvailableModels,
    saveAiSettings,
    testAiConnection,
} from '../../services/ai';

const MODEL_TASKS = [
    { key: 'explain', label: 'AI解説' },
    { key: 'translate', label: 'AI翻訳' },
    { key: 'chat', label: 'チャット' },
    { key: 'ocr', label: 'OCR' },
];

export function SettingsPanel() {
    const [settings, setSettings] = useState(getAiSettings());
    const [availableModelsByBaseUrl, setAvailableModelsByBaseUrl] = useState({});
    const [loadingModelsForBaseUrl, setLoadingModelsForBaseUrl] = useState('');
    const [newBaseUrlLabel, setNewBaseUrlLabel] = useState('');
    const [newBaseUrl, setNewBaseUrl] = useState('');
    const [newBaseUrlApiKey, setNewBaseUrlApiKey] = useState('');
    const [connectionStatus, setConnectionStatus] = useState('');
    const [connectionError, setConnectionError] = useState('');
    const [isTestingConnection, setIsTestingConnection] = useState(false);

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

    const baseUrlConfigs = getRegisteredBaseUrlConfigs(settings);
    const baseUrls = baseUrlConfigs.map((config) => config.url);
    const getBaseUrlLabel = (baseUrl) => {
        const config = baseUrlConfigs.find((item) => item.url === baseUrl);
        return config?.label || baseUrl;
    };

    return (
        <div className="settings-section">
            <h3>AI 設定</h3>
            <div className="form-group">
                <label htmlFor="ai-base-url">Base URLs</label>
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
                        placeholder="API Key"
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
                            <span title={config.url}>{config.url}</span>
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
            <div className="form-group">
                <div className="model-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <label>モデル設定</label>
                    <button className="refresh-btn" onClick={() => fetchModels(settings.baseUrl)} disabled={Boolean(loadingModelsForBaseUrl)}>
                        <RefreshCw size={12} className={loadingModelsForBaseUrl ? 'spinning' : ''} />
                    </button>
                </div>

                {MODEL_TASKS.map((task) => {
                    const currentModel = settings.models?.[task.key] || '';
                    const selectedBaseUrl = settings.modelBaseUrls?.[task.key] || settings.baseUrl;
                    const modelOptions = Array.from(new Set([
                        ...DEFAULT_MODELS,
                        ...(availableModelsByBaseUrl[selectedBaseUrl] || []),
                        currentModel,
                    ].filter(Boolean))).sort();
                    const selectedModel = modelOptions.includes(currentModel) ? currentModel : '';

                    return (
                        <div key={task.key} className="task-model-item">
                            <span>{task.label}</span>
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
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
