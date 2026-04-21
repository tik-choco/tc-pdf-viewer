import { useEffect, useState } from 'preact/hooks';
import { RefreshCw } from 'lucide-preact';
import {
    DEFAULT_MODELS,
    getAiSettings,
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
    const [availableModels, setAvailableModels] = useState(DEFAULT_MODELS);
    const [isLoadingModels, setIsLoadingModels] = useState(false);
    const [connectionStatus, setConnectionStatus] = useState('');
    const [connectionError, setConnectionError] = useState('');
    const [isTestingConnection, setIsTestingConnection] = useState(false);

    useEffect(() => {
        const handleSyncUpdate = () => setSettings(getAiSettings());
        window.addEventListener('sync-data-updated', handleSyncUpdate);
        fetchModels();

        return () => window.removeEventListener('sync-data-updated', handleSyncUpdate);
    }, []);

    const fetchModels = async (settingsOverride = settings) => {
        setIsLoadingModels(true);
        setAvailableModels(await getAvailableModels(settingsOverride));
        setIsLoadingModels(false);
    };

    const updateSettings = (nextSettings) => {
        setSettings(nextSettings);
        saveAiSettings(nextSettings);
        window.dispatchEvent(new CustomEvent('sync-data-updated'));
    };

    const handleTestConnection = async () => {
        setIsTestingConnection(true);
        setConnectionStatus('Testing API connection...');
        setConnectionError('');

        try {
            const result = await testAiConnection(settings);
            setConnectionStatus(`Connected. ${result.modelCount} models available.`);
            await fetchModels(settings);
        } catch (err) {
            setConnectionStatus('Connection failed');
            setConnectionError(err.message || String(err));
        } finally {
            setIsTestingConnection(false);
        }
    };

    const modelOptions = Array.from(new Set([
        ...DEFAULT_MODELS,
        ...availableModels,
    ])).sort();

    return (
        <div className="settings-section">
            <h3>AI 設定</h3>
            <div className="form-group">
                <label htmlFor="ai-base-url">Base URL</label>
                <input
                    id="ai-base-url"
                    name="ai-base-url"
                    value={settings.baseUrl}
                    onInput={(event) => updateSettings({ ...settings, baseUrl: event.target.value })}
                    placeholder="https://..."
                    autoComplete="off"
                />
            </div>
            <div className="form-group">
                <label htmlFor="ai-api-key">API Key</label>
                <input
                    id="ai-api-key"
                    name="ai-api-key"
                    type="password"
                    value={settings.apiKey}
                    onInput={(event) => updateSettings({ ...settings, apiKey: event.target.value })}
                    placeholder="sk-..."
                    autoComplete="off"
                />
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
                    <button className="refresh-btn" onClick={() => fetchModels()} disabled={isLoadingModels}>
                        <RefreshCw size={12} className={isLoadingModels ? 'spinning' : ''} />
                    </button>
                </div>

                {MODEL_TASKS.map((task) => {
                    const currentModel = settings.models?.[task.key] || '';
                    const selectedModel = modelOptions.includes(currentModel) ? currentModel : '';

                    return (
                        <div key={task.key} className="task-model-item" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', width: '50px' }}>{task.label}</span>
                            <select
                                id={`select-model-${task.key}`}
                                name={`select-model-${task.key}`}
                                style={{ flex: 1 }}
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
