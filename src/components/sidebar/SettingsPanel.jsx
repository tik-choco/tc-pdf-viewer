import { useEffect, useState } from 'preact/hooks';
import { Plus, RefreshCw, Sparkles, Star, Trash2 } from 'lucide-preact';
import {
    REASONING_EFFORT_OPTIONS,
    AI_TASKS,
    getAiSettings,
    saveAiSettings,
    getSharedLlmConfig,
    subscribeLlmConfig,
    addLlmProvider,
    updateLlmProvider,
    removeLlmProvider,
    addLlmPreset,
    updateLlmPreset,
    removeLlmPreset,
    setDefaultLlmPresetId,
    setNetworkRoomId,
    getAvailableModels,
    testAiConnection,
} from '../../services/ai';
import { requestOnboarding } from '../../services/onboarding';
import { MESSAGES_JA } from '@tik-choco/mistai';
import { ConsumerStatusIndicator, ProviderStatusPanel } from '@tik-choco/mistai/preact';
import { useMistllm } from '../../hooks/useMistllm';
import { useNetworkProvider } from '../../hooks/useNetworkProvider';

const SETTINGS_TABS = [
    { key: 'providers', label: '接続' },
    { key: 'presets', label: 'プリセット' },
    { key: 'tasks', label: 'タスク' },
    { key: 'network', label: 'ネットワーク' },
];

const TASK_LABELS = {
    explain: 'AI解説',
    translate: 'AI翻訳',
    chat: 'チャット',
    ocr: 'OCR',
};

function NetworkProviderCard({ networkProviderEnabled, roomId, onToggle }) {
    const provider = useNetworkProvider({ networkProviderEnabled, roomId });

    return (
        <div className="settings-role-card">
            <label className="settings-role-head">
                <input
                    type="checkbox"
                    checked={Boolean(networkProviderEnabled)}
                    onChange={(event) => onToggle(event.target.checked)}
                />
                <span className="settings-role-title">
                    <strong>AIを提供する（プロバイダ）</strong>
                    <span className="hint">このデバイスの接続設定を使って、ネットワーク上の他デバイスからのLLMリクエストを処理します。</span>
                </span>
            </label>
            {networkProviderEnabled && (
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
                                提供するには「プリセット」タブでプリセットを作成し、「タスク」タブでチャット用に割り当てるか既定プリセットに設定してください。
                            </p>
                        ) : null}
                    />
                </div>
            )}
        </div>
    );
}

export function SettingsPanel() {
    const [activeTab, setActiveTab] = useState('providers');
    const [settings, setSettings] = useState(getAiSettings());
    const [sharedConfig, setSharedConfig] = useState(getSharedLlmConfig());
    const [modelsByProviderId, setModelsByProviderId] = useState({});
    const [loadingProviderId, setLoadingProviderId] = useState('');
    const [providerTestState, setProviderTestState] = useState({});

    const [newProviderLabel, setNewProviderLabel] = useState('');
    const [newProviderBaseUrl, setNewProviderBaseUrl] = useState('');
    const [newProviderApiKey, setNewProviderApiKey] = useState('');

    const [newPresetLabel, setNewPresetLabel] = useState('');
    const [newPresetProviderId, setNewPresetProviderId] = useState('');
    const [newPresetModel, setNewPresetModel] = useState('');
    const [newPresetReasoningEffort, setNewPresetReasoningEffort] = useState('none');

    const [roomIdInput, setRoomIdInput] = useState(sharedConfig.network.roomId || '');
    const mistllm = useMistllm();

    const refreshSharedConfig = () => setSharedConfig(getSharedLlmConfig());

    useEffect(() => {
        const handleSyncUpdate = () => setSettings(getAiSettings());
        window.addEventListener('sync-data-updated', handleSyncUpdate);
        // 他アプリ/他タブでの共有LLM設定変更(providers/presets/roomIdなど)を反映する。
        const unsubscribe = subscribeLlmConfig(() => {
            const next = getSharedLlmConfig();
            setSharedConfig(next);
            setRoomIdInput(next.network.roomId || '');
        });

        return () => {
            window.removeEventListener('sync-data-updated', handleSyncUpdate);
            unsubscribe();
        };
    }, []);

    const updateSettings = (nextSettings) => {
        setSettings(nextSettings);
        saveAiSettings(nextSettings);
        window.dispatchEvent(new CustomEvent('sync-data-updated'));
    };

    const fetchProviderModels = async (provider) => {
        if (!provider) return;
        setLoadingProviderId(provider.id);
        const models = await getAvailableModels({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
        setModelsByProviderId((current) => ({ ...current, [provider.id]: models }));
        setLoadingProviderId('');
        return models;
    };

    // --- Providers ---------------------------------------------------------

    const handleAddProvider = () => {
        const baseUrl = newProviderBaseUrl.trim().replace(/\/$/, '');
        if (!baseUrl) return;
        addLlmProvider({ label: newProviderLabel.trim() || baseUrl, baseUrl, apiKey: newProviderApiKey });
        setNewProviderLabel('');
        setNewProviderBaseUrl('');
        setNewProviderApiKey('');
        refreshSharedConfig();
    };

    const handleUpdateProviderField = (id, field, value) => {
        if (field === 'baseUrl' && !value.trim()) return;
        updateLlmProvider(id, { [field]: value });
        refreshSharedConfig();
    };

    const clearOrphanedTaskPresetIds = () => {
        const validPresetIds = new Set(getSharedLlmConfig().presets.map((p) => p.id));
        const nextTaskPresetIds = Object.fromEntries(
            AI_TASKS.map((task) => [
                task,
                validPresetIds.has(settings.taskPresetIds[task]) ? settings.taskPresetIds[task] : '',
            ])
        );
        updateSettings({ ...settings, taskPresetIds: nextTaskPresetIds });
    };

    const handleRemoveProvider = (id) => {
        if (sharedConfig.providers.length <= 1) return;
        if (!confirm('この接続と、これを使うプリセットを削除しますか？')) return;
        removeLlmProvider(id);
        refreshSharedConfig();
        clearOrphanedTaskPresetIds();
    };

    const handleTestProvider = async (provider) => {
        setProviderTestState((current) => ({ ...current, [provider.id]: { status: 'busy', message: '' } }));
        try {
            const result = await testAiConnection({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
            setProviderTestState((current) => ({
                ...current,
                [provider.id]: { status: 'ok', message: `接続できました（${result.modelCount}モデル）` },
            }));
            fetchProviderModels(provider);
        } catch (err) {
            setProviderTestState((current) => ({
                ...current,
                [provider.id]: { status: 'error', message: err.message || String(err) },
            }));
        }
    };

    // --- Presets -------------------------------------------------------------

    const handleAddPreset = () => {
        const model = newPresetModel.trim();
        if (!newPresetProviderId || !model) return;
        addLlmPreset({
            label: newPresetLabel.trim() || model,
            providerId: newPresetProviderId,
            model,
            reasoningEffort: newPresetReasoningEffort !== 'none' ? newPresetReasoningEffort : undefined,
        });
        setNewPresetLabel('');
        setNewPresetModel('');
        setNewPresetReasoningEffort('none');
        refreshSharedConfig();
    };

    const handleUpdatePreset = (id, patch) => {
        updateLlmPreset(id, patch);
        refreshSharedConfig();
    };

    const handleRemovePreset = (id) => {
        removeLlmPreset(id);
        refreshSharedConfig();
        const nextTaskPresetIds = Object.fromEntries(
            AI_TASKS.map((task) => [task, settings.taskPresetIds[task] === id ? '' : settings.taskPresetIds[task]])
        );
        updateSettings({ ...settings, taskPresetIds: nextTaskPresetIds });
    };

    const handleSetDefaultPreset = (id) => {
        setDefaultLlmPresetId(sharedConfig.defaultPresetId === id ? '' : id);
        refreshSharedConfig();
    };

    // --- Tasks -----------------------------------------------------------------

    const handleTaskPresetChange = (task, presetId) => {
        updateSettings({ ...settings, taskPresetIds: { ...settings.taskPresetIds, [task]: presetId } });
    };

    // --- Network -----------------------------------------------------------

    const handleConsumerToggle = (enabled) => {
        updateSettings({ ...settings, backend: enabled ? 'mistllm' : 'http' });
        if (!enabled) {
            mistllm.disconnect();
        }
    };

    const handleRoomIdCommit = () => {
        setNetworkRoomId(roomIdInput);
        refreshSharedConfig();
    };

    // The mistllm consumer connection itself is maintained eagerly at the app
    // level (see hooks/useNetworkConsumerConnection.js, mounted in App.jsx) so
    // it stays live whether or not this panel is open; this panel only
    // reflects that connection's state via useMistllm() and saves settings.

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

    const getProviderLabel = (providerId) => {
        const provider = sharedConfig.providers.find((p) => p.id === providerId);
        return provider?.label || provider?.baseUrl || '(不明な接続)';
    };

    const renderProvidersTab = () => (
        <>
            {isMistllm && !settings.networkProviderEnabled && (
                <p className="hint">
                    現在はLLMネットワーク（コンシューマ）を利用中のため、この接続設定は使われません。プロバイダとしてAIを提供する場合や、ネットワークをオフにした場合に使用されます。
                </p>
            )}
            <p className="hint">
                接続（Base URL・APIキー）は同一オリジンの他アプリ（tc-note、tc-translateなど）とも共有されます。一度設定すれば他アプリでも再利用できます。
            </p>
            <div className="form-group">
                <label htmlFor="new-provider-base-url">接続を追加</label>
                <div className="base-url-add-row">
                    <input
                        id="new-provider-label"
                        name="new-provider-label"
                        value={newProviderLabel}
                        onInput={(event) => setNewProviderLabel(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') handleAddProvider();
                        }}
                        placeholder="ラベル"
                        autoComplete="off"
                    />
                    <input
                        id="new-provider-base-url"
                        name="new-provider-base-url"
                        value={newProviderBaseUrl}
                        onInput={(event) => setNewProviderBaseUrl(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') handleAddProvider();
                        }}
                        placeholder="https://..."
                        autoComplete="off"
                    />
                    <input
                        id="new-provider-api-key"
                        name="new-provider-api-key"
                        type="password"
                        value={newProviderApiKey}
                        onInput={(event) => setNewProviderApiKey(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') handleAddProvider();
                        }}
                        placeholder="API Key（ローカルLLMでは省略可）"
                        autoComplete="off"
                    />
                    <button className="icon-form-btn" onClick={handleAddProvider} title="接続を追加">
                        <Plus size={14} />
                    </button>
                </div>
                <div className="base-url-list">
                    {sharedConfig.providers.map((provider) => {
                        const testState = providerTestState[provider.id];
                        return (
                            <div key={provider.id} className="base-url-item-wrapper">
                                <div className="base-url-item">
                                    <input
                                        value={provider.label}
                                        onInput={(event) => handleUpdateProviderField(provider.id, 'label', event.target.value)}
                                        placeholder="ラベル"
                                        autoComplete="off"
                                    />
                                    <input
                                        value={provider.baseUrl}
                                        title={provider.baseUrl}
                                        onBlur={(event) => handleUpdateProviderField(provider.id, 'baseUrl', event.target.value)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter') event.target.blur();
                                        }}
                                        placeholder="https://..."
                                        autoComplete="off"
                                    />
                                    <input
                                        type="password"
                                        value={provider.apiKey || ''}
                                        onInput={(event) => handleUpdateProviderField(provider.id, 'apiKey', event.target.value)}
                                        placeholder="API Key"
                                        autoComplete="off"
                                    />
                                    <div className="base-url-actions">
                                        <button
                                            className="icon-form-btn"
                                            onClick={() => handleTestProvider(provider)}
                                            disabled={loadingProviderId === provider.id}
                                            title="接続テスト"
                                        >
                                            <RefreshCw size={13} className={testState?.status === 'busy' ? 'spinning' : ''} />
                                        </button>
                                        <button
                                            className="icon-form-btn is-danger"
                                            onClick={() => handleRemoveProvider(provider.id)}
                                            disabled={sharedConfig.providers.length <= 1}
                                            title="接続を削除"
                                        >
                                            <Trash2 size={13} />
                                        </button>
                                    </div>
                                </div>
                                {testState && (
                                    <div className="settings-test-result">
                                        <span className={testState.status === 'error' ? 'error' : ''}>{testState.message}</span>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </>
    );

    const renderPresetsTab = () => (
        <div className="form-group">
            <label>プリセット（呼び方＋接続先）</label>
            <p className="hint">
                プリセットは「どのモデルを、どの接続で、どんなreasoningで呼ぶか」の組み合わせです。★は既定プリセット（タスクに未割当のときに使われます）。
            </p>
            <div className="preset-add-row">
                <input
                    value={newPresetLabel}
                    onInput={(event) => setNewPresetLabel(event.target.value)}
                    placeholder="ラベル（省略可）"
                    autoComplete="off"
                />
                <select
                    value={newPresetProviderId}
                    onChange={(event) => setNewPresetProviderId(event.target.value)}
                >
                    <option value="">(接続を選択...)</option>
                    {sharedConfig.providers.map((provider) => (
                        <option key={provider.id} value={provider.id}>{provider.label}</option>
                    ))}
                </select>
                <input
                    value={newPresetModel}
                    onInput={(event) => setNewPresetModel(event.target.value)}
                    placeholder="モデル名"
                    autoComplete="off"
                    list="preset-add-model-options"
                />
                <datalist id="preset-add-model-options">
                    {(modelsByProviderId[newPresetProviderId] || []).map((model) => (
                        <option key={model} value={model} />
                    ))}
                </datalist>
                <select
                    value={newPresetReasoningEffort}
                    onChange={(event) => setNewPresetReasoningEffort(event.target.value)}
                >
                    {REASONING_EFFORT_OPTIONS.map((effort) => (
                        <option key={effort} value={effort}>{effort}</option>
                    ))}
                </select>
                <button className="icon-form-btn" onClick={handleAddPreset} title="プリセットを追加">
                    <Plus size={14} />
                </button>
            </div>

            <div className="preset-list">
                {sharedConfig.presets.length === 0 && (
                    <p className="hint">プリセットがまだありません。上のフォームから追加してください。</p>
                )}
                {sharedConfig.presets.map((preset) => {
                    const isDefault = sharedConfig.defaultPresetId === preset.id;
                    const providerModels = modelsByProviderId[preset.providerId] || [];
                    return (
                        <div key={preset.id} className={`preset-item ${isDefault ? 'is-default' : ''}`}>
                            <input
                                value={preset.label}
                                onInput={(event) => handleUpdatePreset(preset.id, { label: event.target.value })}
                                placeholder="ラベル"
                                autoComplete="off"
                            />
                            <select
                                value={preset.providerId}
                                onChange={(event) => handleUpdatePreset(preset.id, { providerId: event.target.value })}
                            >
                                {sharedConfig.providers.map((provider) => (
                                    <option key={provider.id} value={provider.id}>{provider.label}</option>
                                ))}
                            </select>
                            <input
                                value={preset.model}
                                onInput={(event) => handleUpdatePreset(preset.id, { model: event.target.value })}
                                placeholder="モデル名"
                                autoComplete="off"
                                list={`preset-model-options-${preset.id}`}
                            />
                            <datalist id={`preset-model-options-${preset.id}`}>
                                {providerModels.map((model) => (
                                    <option key={model} value={model} />
                                ))}
                            </datalist>
                            <select
                                value={preset.reasoningEffort || 'none'}
                                onChange={(event) => handleUpdatePreset(preset.id, {
                                    reasoningEffort: event.target.value === 'none' ? '' : event.target.value,
                                })}
                            >
                                {REASONING_EFFORT_OPTIONS.map((effort) => (
                                    <option key={effort} value={effort}>{effort}</option>
                                ))}
                            </select>
                            <div className="preset-actions">
                                <button
                                    className={`icon-form-btn preset-default-btn ${isDefault ? 'is-active' : ''}`}
                                    onClick={() => handleSetDefaultPreset(preset.id)}
                                    title="既定プリセットにする"
                                >
                                    <Star size={13} />
                                </button>
                                <button
                                    className="icon-form-btn"
                                    onClick={() => fetchProviderModels(sharedConfig.providers.find((p) => p.id === preset.providerId))}
                                    disabled={loadingProviderId === preset.providerId}
                                    title="モデル候補を取得"
                                >
                                    <RefreshCw size={13} className={loadingProviderId === preset.providerId ? 'spinning' : ''} />
                                </button>
                                <button
                                    className="icon-form-btn is-danger"
                                    onClick={() => handleRemovePreset(preset.id)}
                                    title="プリセットを削除"
                                >
                                    <Trash2 size={13} />
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );

    const renderTasksTab = () => (
        <div className="form-group">
            <label>タスク別プリセット</label>
            <p className="hint">未設定のタスクは、チャット用のプリセット、それも未設定なら既定プリセットを使います。</p>
            {AI_TASKS.map((task) => (
                <div key={task} className="task-model-item">
                    <span>{TASK_LABELS[task]}</span>
                    <div className="task-model-fields">
                        <div className="task-model-field">
                            <label htmlFor={`select-preset-${task}`}>プリセット</label>
                            <select
                                id={`select-preset-${task}`}
                                name={`select-preset-${task}`}
                                value={settings.taskPresetIds[task] || ''}
                                onChange={(event) => handleTaskPresetChange(task, event.target.value)}
                                autoComplete="off"
                            >
                                <option value="">(未設定 → 既定を使用)</option>
                                {sharedConfig.presets.map((preset) => (
                                    <option key={preset.id} value={preset.id}>
                                        {preset.label}（{getProviderLabel(preset.providerId)}）
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );

    const renderNetworkTab = () => (
        <>
            <p className="hint">
                Mist LLMネットワーク（P2P）では、同じRoom IDに参加したデバイス同士でLLMを共有できます。Room IDは同一オリジンの他アプリとも共有されます。
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
            <NetworkProviderCard
                networkProviderEnabled={settings.networkProviderEnabled}
                roomId={sharedConfig.network.roomId}
                onToggle={(enabled) => updateSettings({ ...settings, networkProviderEnabled: enabled })}
            />
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
                {activeTab === 'providers' && renderProvidersTab()}
                {activeTab === 'presets' && renderPresetsTab()}
                {activeTab === 'tasks' && renderTasksTab()}
                {activeTab === 'network' && renderNetworkTab()}
            </div>

            <h3>はじめに</h3>
            <p className="hint">初回セットアップのガイドをもう一度開けます。</p>
            <div className="form-group">
                <button className="save-btn" onClick={requestOnboarding}>
                    <Sparkles size={14} />
                    セットアップガイドを開く
                </button>
            </div>
        </div>
    );
}
