import { useEffect, useState } from 'preact/hooks';
import { Check, Network, Plus, RefreshCw, Server, Sparkles, Star, Trash2, X } from 'lucide-preact';
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
    addConnection,
    resolveDefaultLlmTarget,
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
    { key: 'connection', label: 'AI接続' },
    { key: 'tasks', label: 'タスク' },
];

// Old 4-tab layout ('providers'/'presets') was merged into a single
// 'connection' tab, and the old 'network' tab's content was folded into
// 'connection' as the "AI Network" mode of its 接続方式 toggle; this maps
// any stale tab key (e.g. from a future persisted-tab feature, or a stale
// reference held across these merges) onto its replacement so the panel
// never lands on a tab that no longer exists.
const LEGACY_TAB_FALLBACK = { providers: 'connection', presets: 'connection', network: 'connection' };
const normalizeTabKey = (key) => LEGACY_TAB_FALLBACK[key] || key;

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
                                提供するには「AI接続」タブで接続を追加し、「タスク」タブでチャット用に割り当てるか既定プリセットに設定してください。
                            </p>
                        ) : null}
                    />
                </div>
            )}
        </div>
    );
}

export function SettingsPanel() {
    const [activeTab, setActiveTab] = useState(() => normalizeTabKey('connection'));
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

    // Unified "接続を追加"/"プリセットを編集" form (AI接続 tab) — in 'add' mode
    // creates a provider + preset together via services/ai.js#addConnection;
    // in 'edit' mode (entered by clicking an existing preset chip) updates
    // that preset's provider/preset in place via updateLlmProvider/
    // updateLlmPreset. connEditPresetId identifies which preset is being
    // edited; the fields below are just a local draft until saved.
    const [connMode, setConnMode] = useState('add');
    const [connEditPresetId, setConnEditPresetId] = useState('');
    const [connLabel, setConnLabel] = useState('');
    const [connBaseUrl, setConnBaseUrl] = useState('');
    const [connApiKey, setConnApiKey] = useState('');
    const [connModel, setConnModel] = useState('');
    const [connModelOptions, setConnModelOptions] = useState([]);
    const [connFetchingModels, setConnFetchingModels] = useState(false);
    const [connModelFetchError, setConnModelFetchError] = useState('');
    // 'select' = 取得済み一覧から選ぶ（既定）。'manual' = 自由入力（/v1/models非対応や
    // 取得失敗時のフォールバック、ユーザーによる明示切替の両方で使う）。
    const [connModelInputMode, setConnModelInputMode] = useState('select');
    const [connTestState, setConnTestState] = useState(null);

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

    // 編集中のプリセットが（チップの×や詳細編集からの削除、他タブでの削除などで）
    // 消えたら、統合フォームを追加モードに戻す。
    useEffect(() => {
        if (connMode === 'edit' && connEditPresetId && !sharedConfig.presets.some((p) => p.id === connEditPresetId)) {
            resetConnDraftToAdd();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sharedConfig, connMode, connEditPresetId]);

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

    // プリセットチップのクリックは常に既定プリセットに設定する（トグルしない）。
    // 加えて、下の統合フォームをそのプリセットの編集モードに切り替える。
    const handleSelectPresetChip = (preset) => {
        setDefaultLlmPresetId(preset.id);
        refreshSharedConfig();
        loadConnDraftFromPreset(preset);
    };

    const handleRemovePresetChip = (id, event) => {
        event.stopPropagation();
        if (!confirm('このプリセットを削除しますか？')) return;
        handleRemovePreset(id);
        // sharedConfig更新後、上のuseEffectが編集対象消失を検知して追加モードに
        // 戻すが、refreshSharedConfigが非同期に反映されるまでの間も含めて
        // 明示的にここでもリセットしておく。
        if (connEditPresetId === id) resetConnDraftToAdd();
    };

    // --- 接続を追加／編集（統合フォーム） ---------------------------------------

    // フォームを「追加モード」（空欄）にリセットする。「+ 新規追加」チップ、
    // 編集中プリセットの削除、追加成功後などから呼ばれる。
    const resetConnDraftToAdd = () => {
        setConnMode('add');
        setConnEditPresetId('');
        setConnLabel('');
        setConnBaseUrl('');
        setConnApiKey('');
        setConnModel('');
        setConnModelOptions([]);
        setConnModelInputMode('select');
        setConnModelFetchError('');
        setConnTestState(null);
    };

    // フォームを指定プリセット（とその接続）の「編集モード」にする。既存の
    // draftは破棄して読み込み直す（確認ダイアログ不要）。baseUrlがあれば
    // モデル一覧も自動取得する。
    const loadConnDraftFromPreset = (preset) => {
        const provider = sharedConfig.providers.find((p) => p.id === preset.providerId);
        setConnMode('edit');
        setConnEditPresetId(preset.id);
        setConnLabel(preset.label || '');
        setConnBaseUrl(provider?.baseUrl || '');
        setConnApiKey(provider?.apiKey || '');
        setConnModel(preset.model || '');
        setConnModelOptions([]);
        setConnModelInputMode('select');
        setConnModelFetchError('');
        setConnTestState(null);
        if (provider?.baseUrl) {
            fetchConnModelOptions(provider.baseUrl, provider.apiKey || '');
        }
    };

    // baseUrl/apiKeyを明示的に受け取ってモデル一覧を取得する（呼び出し直後の
    // stateにまだ反映されていない値を使いたい場面 — baseUrlのonBlurや編集
    // モード開始時の自動取得 — のため、connBaseUrl/connApiKeyのstateには
    // 依存しない）。取得0件時は取得失敗とみなし、手入力モードへフォールバック
    // する（getAvailableModelsは内部で失敗を握りつぶしてただの空配列を返す
    // ため、成功/失敗を区別できず「0件=失敗扱い」で近似している）。
    const fetchConnModelOptions = async (baseUrl, apiKey) => {
        const trimmedBaseUrl = (baseUrl || '').trim();
        if (!trimmedBaseUrl) return;
        setConnFetchingModels(true);
        setConnModelFetchError('');
        const models = await getAvailableModels({ baseUrl: trimmedBaseUrl, apiKey: apiKey || '' });
        setConnModelOptions(models);
        if (models.length === 0) {
            setConnModelFetchError('モデル一覧を取得できませんでした。手入力してください。');
            setConnModelInputMode('manual');
        } else {
            setConnModelInputMode('select');
        }
        setConnFetchingModels(false);
    };

    const handleFetchConnModels = () => fetchConnModelOptions(connBaseUrl, connApiKey);

    const handleConnBaseUrlBlur = (event) => {
        const value = event.target.value.trim();
        if (value) fetchConnModelOptions(value, connApiKey);
    };

    const handleTestConn = async () => {
        const baseUrl = connBaseUrl.trim();
        if (!baseUrl) return;
        setConnTestState({ status: 'busy', message: '' });
        try {
            const result = await testAiConnection({ baseUrl, apiKey: connApiKey });
            setConnTestState({ status: 'ok', message: `接続できました（${result.modelCount}モデル）` });
        } catch (err) {
            setConnTestState({ status: 'error', message: err.message || String(err) });
        }
    };

    const handleAddConnection = () => {
        const baseUrl = connBaseUrl.trim().replace(/\/$/, '');
        const model = connModel.trim();
        if (!baseUrl || !model) return;
        addConnection({ label: connLabel.trim(), baseUrl, apiKey: connApiKey, model });
        resetConnDraftToAdd();
        refreshSharedConfig();
    };

    // 編集モード（既存プリセットチップから入った）での保存: 新規provider/preset
    // は作らず、既存のupdateLlmProvider/updateLlmPreset（読込→変更→保存の共有
    // 設定更新経路）でin-place更新する。baseUrlの変更は同じproviderを使う他の
    // プリセットにも影響する（フォーム側にその旨の注意書きを表示）。
    const handleSaveConnectionEdit = () => {
        const preset = sharedConfig.presets.find((p) => p.id === connEditPresetId);
        if (!preset) {
            resetConnDraftToAdd();
            return;
        }
        const baseUrl = connBaseUrl.trim().replace(/\/$/, '');
        const model = connModel.trim();
        if (!baseUrl || !model) return;
        updateLlmProvider(preset.providerId, { baseUrl, apiKey: connApiKey });
        updateLlmPreset(preset.id, { label: connLabel.trim() || model, model });
        setConnTestState(null);
        refreshSharedConfig();
    };

    const handleSubmitConnection = () => {
        if (connMode === 'edit') {
            handleSaveConnectionEdit();
        } else {
            handleAddConnection();
        }
    };

    // --- Tasks -----------------------------------------------------------------

    const handleTaskPresetChange = (task, presetId) => {
        updateSettings({ ...settings, taskPresetIds: { ...settings.taskPresetIds, [task]: presetId } });
    };

    // 「未設定」を選んだ場合に実際に使われるプリセットを解決する
    // (services/ai.js の resolveTaskTarget と同じフォールバック規則:
    // task固有 → chatタスクのpreset → defaultPreset。ここではUI表示用に
    // 「未設定を選んだ場合」の解決結果、つまりtask固有をスキップした結果を返す)。
    const resolveTaskFallbackPreset = (task) => {
        if (task === 'chat') {
            return sharedConfig.presets.find((p) => p.id === sharedConfig.defaultPresetId) || null;
        }
        const chatPresetId = settings.taskPresetIds.chat;
        const chatPreset = chatPresetId ? sharedConfig.presets.find((p) => p.id === chatPresetId) : null;
        return chatPreset || sharedConfig.presets.find((p) => p.id === sharedConfig.defaultPresetId) || null;
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

    const renderConnectionTab = () => {
        const currentTarget = resolveDefaultLlmTarget(sharedConfig);
        const currentTargetProviderLabel = currentTarget ? getProviderLabel(currentTarget.providerId) : '';
        const editingPreset = connMode === 'edit'
            ? sharedConfig.presets.find((p) => p.id === connEditPresetId)
            : null;
        const editingProviderSharedCount = editingPreset
            ? sharedConfig.presets.filter((p) => p.providerId === editingPreset.providerId).length
            : 0;

        return (
            <>
                <p className="hint">
                    接続（Base URL・APIキー）とプリセットは同一オリジンの他アプリ（tc-note、tc-translateなど）とも共有されます。一度設定すれば他アプリでも再利用できます。
                </p>

                <div className="connection-mode-toggle" role="radiogroup" aria-label="接続方式">
                    <button
                        type="button"
                        role="radio"
                        aria-checked={!isMistllm}
                        className={`connection-mode-button ${!isMistllm ? 'connection-mode-button-active' : ''}`}
                        onClick={() => handleConsumerToggle(false)}
                    >
                        <Server size={14} />
                        直接API接続
                    </button>
                    <button
                        type="button"
                        role="radio"
                        aria-checked={isMistllm}
                        className={`connection-mode-button ${isMistllm ? 'connection-mode-button-active' : ''}`}
                        onClick={() => handleConsumerToggle(true)}
                    >
                        <Network size={14} />
                        AI Network
                    </button>
                </div>

                {isMistllm ? (
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
                        <div className="form-group">
                            <label>接続状況</label>
                            <ConsumerStatusIndicator
                                status={consumerStatus}
                                updatedAt={mistllm.updatedAt}
                                variant="detailed"
                                messages={MESSAGES_JA}
                            />
                        </div>

                        <hr className="settings-section-divider" />

                        <p className="hint">
                            プロバイダ役は、この端末の直接API接続（チャットタスクのプリセット）を使って、同じRoomの他端末にAIを提供します。接続方式の選択とは独立して動作します。
                        </p>
                        <NetworkProviderCard
                            networkProviderEnabled={settings.networkProviderEnabled}
                            roomId={sharedConfig.network.roomId}
                            onToggle={(enabled) => updateSettings({ ...settings, networkProviderEnabled: enabled })}
                        />
                    </>
                ) : (
                    <>
                        <p className={`current-connection-line ${currentTarget ? 'is-set' : 'is-unset'}`}>
                            現在の接続先: {currentTarget
                                ? `${currentTarget.label} / ${currentTarget.model}（${currentTargetProviderLabel}）`
                                : '未設定'}
                        </p>

                        <div className="form-group">
                            <label>プリセット</label>
                            {sharedConfig.presets.length === 0 && (
                                <p className="hint">プリセットがまだありません。「+ 新規追加」または下のフォームから接続を追加してください。</p>
                            )}
                            <div className="preset-chip-list">
                                {sharedConfig.presets.map((preset) => {
                                    const isDefault = sharedConfig.defaultPresetId === preset.id;
                                    const isEditing = connMode === 'edit' && connEditPresetId === preset.id;
                                    return (
                                        <button
                                            key={preset.id}
                                            type="button"
                                            className={`preset-chip ${isDefault ? 'is-default' : ''} ${isEditing ? 'is-editing' : ''}`}
                                            onClick={() => handleSelectPresetChip(preset)}
                                            title={getProviderLabel(preset.providerId)}
                                        >
                                            {isDefault && <Star size={12} className="preset-chip-star" />}
                                            <span className="preset-chip-label">{preset.label}</span>
                                            <span className="preset-chip-model">{preset.model}</span>
                                            <span
                                                className="preset-chip-remove"
                                                role="button"
                                                tabIndex={0}
                                                title="プリセットを削除"
                                                onClick={(event) => handleRemovePresetChip(preset.id, event)}
                                                onKeyDown={(event) => {
                                                    if (event.key === 'Enter' || event.key === ' ') {
                                                        event.preventDefault();
                                                        handleRemovePresetChip(preset.id, event);
                                                    }
                                                }}
                                            >
                                                <X size={11} />
                                            </span>
                                        </button>
                                    );
                                })}
                                <button
                                    type="button"
                                    className={`preset-chip preset-chip-add ${connMode === 'add' ? 'is-active' : ''}`}
                                    onClick={resetConnDraftToAdd}
                                >
                                    <Plus size={12} />
                                    <span className="preset-chip-label">新規追加</span>
                                </button>
                            </div>
                        </div>

                        <div className="form-group">
                            <label>{connMode === 'edit' ? `プリセットを編集: ${editingPreset?.label || ''}` : '接続を追加'}</label>
                            <p className="hint">
                                {connMode === 'edit'
                                    ? '既存の接続とプリセットを直接編集します（新しい接続やプリセットは作成されません）。'
                                    : 'Base URLとモデル名を入力すると、接続とプリセットをまとめて作成します。APIキーはローカルLLMなど不要な場合は空欄のままで構いません。'}
                            </p>
                            {connMode === 'edit' && editingProviderSharedCount > 1 && (
                                <p className="hint connection-form-warning">
                                    この接続（Base URL・APIキー）は他に{editingProviderSharedCount - 1}件のプリセットからも使われています。変更するとそれらにも影響します。
                                </p>
                            )}
                            <div className="connection-form">
                                <div className="connection-form-grid">
                                    <input
                                        value={connLabel}
                                        onInput={(event) => setConnLabel(event.target.value)}
                                        placeholder="ラベル（省略可）"
                                        autoComplete="off"
                                    />
                                    <input
                                        value={connBaseUrl}
                                        onInput={(event) => setConnBaseUrl(event.target.value)}
                                        onBlur={handleConnBaseUrlBlur}
                                        placeholder="Base URL（https://...）"
                                        autoComplete="off"
                                    />
                                    <input
                                        type="password"
                                        value={connApiKey}
                                        onInput={(event) => setConnApiKey(event.target.value)}
                                        placeholder="API Key（ローカルLLMでは省略可）"
                                        autoComplete="off"
                                    />
                                    <div className="connection-form-model-field">
                                        {connModelInputMode === 'select' ? (
                                            <select
                                                value={connModel}
                                                onChange={(event) => setConnModel(event.target.value)}
                                            >
                                                <option value="" disabled>
                                                    {connFetchingModels
                                                        ? '取得中…'
                                                        : connModelOptions.length
                                                            ? 'モデルを選択...'
                                                            : 'モデル一覧を取得してください'}
                                                </option>
                                                {connModel && !connModelOptions.includes(connModel) && (
                                                    <option value={connModel}>{connModel}</option>
                                                )}
                                                {connModelOptions.map((model) => (
                                                    <option key={model} value={model}>{model}</option>
                                                ))}
                                            </select>
                                        ) : (
                                            <input
                                                value={connModel}
                                                onInput={(event) => setConnModel(event.target.value)}
                                                placeholder="モデル名"
                                                autoComplete="off"
                                                list="connection-add-model-options"
                                            />
                                        )}
                                        <button
                                            type="button"
                                            className="connection-form-mode-toggle"
                                            onClick={() => setConnModelInputMode((mode) => (mode === 'select' ? 'manual' : 'select'))}
                                        >
                                            {connModelInputMode === 'select' ? '手入力に切り替え' : '一覧から選ぶ'}
                                        </button>
                                    </div>
                                    <datalist id="connection-add-model-options">
                                        {connModelOptions.map((model) => (
                                            <option key={model} value={model} />
                                        ))}
                                    </datalist>
                                    {connModelFetchError && (
                                        <p className="hint connection-form-warning">{connModelFetchError}</p>
                                    )}
                                </div>
                                <div className="connection-form-actions">
                                    <button
                                        type="button"
                                        className="connection-form-btn"
                                        onClick={handleFetchConnModels}
                                        disabled={connFetchingModels || !connBaseUrl.trim()}
                                    >
                                        <RefreshCw size={13} className={connFetchingModels ? 'spinning' : ''} />
                                        {connFetchingModels ? '取得中…' : 'モデル一覧を取得'}
                                    </button>
                                    <button
                                        type="button"
                                        className="connection-form-btn"
                                        onClick={handleTestConn}
                                        disabled={connTestState?.status === 'busy' || !connBaseUrl.trim()}
                                    >
                                        <RefreshCw size={13} className={connTestState?.status === 'busy' ? 'spinning' : ''} />
                                        接続テスト
                                    </button>
                                    <button
                                        type="button"
                                        className="connection-form-btn connection-form-btn-primary"
                                        onClick={handleSubmitConnection}
                                        disabled={!connBaseUrl.trim() || !connModel.trim()}
                                    >
                                        {connMode === 'edit' ? <Check size={13} /> : <Plus size={13} />}
                                        {connMode === 'edit' ? '保存' : '追加'}
                                    </button>
                                </div>
                                {connTestState && (
                                    <div className="settings-test-result">
                                        <span className={connTestState.status === 'error' ? 'error' : ''}>{connTestState.message}</span>
                                    </div>
                                )}
                            </div>
                        </div>

                        <details className="settings-advanced">
                            <summary>詳細編集</summary>
                            <div className="settings-advanced-body">
                                <div className="form-group">
                                    <label htmlFor="new-provider-base-url">接続（Provider）一覧</label>
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
                                                            onBlur={(event) => handleUpdateProviderField(provider.id, 'label', event.target.value)}
                                                            onKeyDown={(event) => {
                                                                if (event.key === 'Enter') event.target.blur();
                                                            }}
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
                                                            onBlur={(event) => handleUpdateProviderField(provider.id, 'apiKey', event.target.value)}
                                                            onKeyDown={(event) => {
                                                                if (event.key === 'Enter') event.target.blur();
                                                            }}
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

                                <div className="form-group">
                                    <label>プリセット一覧（呼び方＋接続先）</label>
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
                                                        onBlur={(event) => handleUpdatePreset(preset.id, { label: event.target.value })}
                                                        onKeyDown={(event) => {
                                                            if (event.key === 'Enter') event.target.blur();
                                                        }}
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
                                                        onBlur={(event) => handleUpdatePreset(preset.id, { model: event.target.value })}
                                                        onKeyDown={(event) => {
                                                            if (event.key === 'Enter') event.target.blur();
                                                        }}
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
                            </div>
                        </details>
                    </>
                )}
            </>
        );
    };

    const renderTasksTab = () => (
        <div className="form-group">
            <label>タスク別プリセット</label>
            <p className="hint">未設定のタスクは、チャット用のプリセット、それも未設定なら既定プリセットを使います。未設定のままでも動作します。</p>
            {AI_TASKS.map((task) => {
                const fallbackPreset = resolveTaskFallbackPreset(task);
                return (
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
                                    <option value="">
                                        {fallbackPreset ? `既定を使用（${fallbackPreset.label}）` : '既定を使用（未設定）'}
                                    </option>
                                    {sharedConfig.presets.map((preset) => (
                                        <option key={preset.id} value={preset.id}>
                                            {preset.label}（{getProviderLabel(preset.providerId)}）
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
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
                        onClick={() => setActiveTab(normalizeTabKey(tab.key))}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
            <div className="settings-tab-panel" role="tabpanel">
                {activeTab === 'connection' && renderConnectionTab()}
                {activeTab === 'tasks' && renderTasksTab()}
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
