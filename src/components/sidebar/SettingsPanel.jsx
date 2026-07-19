import { useEffect, useRef, useState } from 'preact/hooks';
import { Plus, Sparkles, X } from 'lucide-preact';
import {
    AI_TASKS,
    REASONING_EFFORT_OPTIONS,
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
    getTaskReasoningEffort,
    setTaskReasoningEffort,
} from '../../services/ai';
import { isNetworkProviderBaseUrl } from '../../services/networkModels';
import { requestOnboarding } from '../../services/onboarding';
import { MESSAGES_JA } from '@tik-choco/mistai';
import { ConsumerStatusIndicator, ProviderStatusPanel } from '@tik-choco/mistai/preact';
import { useMistllm } from '../../hooks/useMistllm';
import { useNetworkProvider } from '../../hooks/useNetworkProvider';

// 4-tab layout (see tc-docs/drafts/llm-settings-common-v1.md §3): AI接続 /
// AI Network / タスク / はじめに. AI Network was briefly folded into AI接続
// as a 接続方式 toggle; it's now its own tab again (mirroring tc-translate's
// SettingsModal), with the toggle relocated inside it as a role-card row.
const SETTINGS_TABS = [
    { key: 'connection', label: 'AI接続' },
    { key: 'network', label: 'AI Network' },
    { key: 'tasks', label: 'タスク' },
    { key: 'intro', label: 'はじめに' },
];

// The old 4-tab layout's 'providers'/'presets' keys were merged into a single
// 'connection' tab; this maps any stale tab key (e.g. from a future
// persisted-tab feature, or a stale reference held across that merge) onto
// its replacement so the panel never lands on a tab that no longer exists.
// 'network' is intentionally absent now - it's a real tab again, so it maps
// to itself.
const LEGACY_TAB_FALLBACK = { providers: 'connection', presets: 'connection' };
const normalizeTabKey = (key) => LEGACY_TAB_FALLBACK[key] || key;

// Kept to one word each (see spec §3.2) - task rows carry their fuller
// description in a hover tooltip (data-tip) instead of the label itself.
const TASK_LABELS = {
    explain: '説明',
    translate: '翻訳',
    chat: 'チャット',
    ocr: 'OCR',
};

const TASK_TIPS = {
    explain: 'ホバー/選択したテキストの解説に使うモデルです。',
    translate: '用語やMarkdownの翻訳に使うモデルです。',
    chat: 'AIチャットと要約に使うモデルです。',
    ocr: 'ページ画像からのテキスト抽出（Vision）に使うモデルです。',
};

// getAvailableModels()は失敗を内部で握りつぶして空配列を返す実装のため、
// 成功/失敗を区別できず「0件=取得失敗」で近似している（複数箇所で使う
// フォールバック文言を共通化）。
const MODEL_FETCH_ERROR_MESSAGE = 'モデル一覧を取得できませんでした。手入力してください。';

function getHostLabel(baseUrl) {
    try {
        return new URL(baseUrl).host || baseUrl;
    } catch {
        return baseUrl;
    }
}

// networkProviderPresetIds is threaded through to useNetworkProvider so the
// hello re-send effect advertises exactly the checked-to-share presets (spec
// §2.3/§3.3/§4.3) - a provider with an empty share list advertises no models
// at all rather than falling back to every model it happens to have.
// eligiblePresets/onToggleShareModel/getProviderLabel back the share
// checklist rendered here while ON (spec §3.3 共有モデルチェックリスト).
function NetworkProviderCard({
    networkProviderEnabled,
    roomId,
    networkProviderPresetIds,
    eligiblePresets,
    onToggleShareModel,
    getProviderLabel,
    onToggle,
}) {
    const provider = useNetworkProvider({ networkProviderEnabled, roomId, networkProviderPresetIds });

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
                    <div className="network-share-models">
                        <label>共有するモデル</label>
                        {eligiblePresets.length === 0 ? (
                            <p className="hint">共有できるモデルがありません。「AI接続」タブでモデルを追加してください。</p>
                        ) : (
                            <div className="network-share-list">
                                {eligiblePresets.map((preset) => (
                                    <label className="network-share-item" key={preset.id}>
                                        <input
                                            type="checkbox"
                                            checked={networkProviderPresetIds.includes(preset.id)}
                                            onChange={(event) => onToggleShareModel(preset.id, event.target.checked)}
                                        />
                                        <span className="network-share-item-label">{preset.label || preset.model}</span>
                                        <span className="network-share-item-model">
                                            {preset.model} · {getProviderLabel(preset.providerId)}
                                        </span>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>
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

    // providerId -> models[]（モデルのselect用にキャッシュ。編集/追加行の
    // 接続先セレクトで対象providerが選ばれた時に未取得ならfetchし、baseUrl/
    // APIキーのblur確定時や接続先切替時はキャッシュを無効化して再取得する。
    // これが接続確認も兼ねるため、別途の「接続テスト」ボタンは持たない）。
    const [modelsByProviderId, setModelsByProviderId] = useState({});
    const [loadingProviderId, setLoadingProviderId] = useState('');
    // providerId -> エラーメッセージ（モデル一覧取得0件=失敗とみなした時の文言）
    const [providerModelErrors, setProviderModelErrors] = useState({});

    // --- 接続先セクション（Provider）: モデルセクションとは独立したフラットな
    // 一覧。階層関係にはしない。 ---
    // 行クリックで開くインライン編集。同時に1つだけアクティブ。
    const [editingProviderId, setEditingProviderId] = useState('');
    // 「+ 接続先を追加」インライン追加行（モデルは含めない単独のprovider作成）。
    const [addingProvider, setAddingProvider] = useState(false);
    const [npLabel, setNpLabel] = useState('');
    const [npBaseUrl, setNpBaseUrl] = useState('');
    const [npApiKey, setNpApiKey] = useState('');

    // --- モデルセクション（Preset）: 接続先セクションとは独立したフラットな
    // 一覧（providerでグルーピングしない）。 ---
    // 「+ モデルを追加」インライン追加行。接続先セレクトを含む。
    const [addingModel, setAddingModel] = useState(false);
    const [amLabel, setAmLabel] = useState('');
    const [amProviderId, setAmProviderId] = useState('');
    const [amModel, setAmModel] = useState('');

    // モデル行（preset）のインライン編集。同時に1つだけアクティブ。接続先も
    // ここで変更できる（providerId変更で別のproviderへ付け替え可能）。
    const [editingPresetId, setEditingPresetId] = useState('');
    const [epLabel, setEpLabel] = useState('');
    const [epProviderId, setEpProviderId] = useState('');
    const [epModel, setEpModel] = useState('');

    const [roomIdInput, setRoomIdInput] = useState(sharedConfig.network.roomId || '');
    const mistllm = useMistllm();

    // providerId -> 最新のfetchProviderModels()呼び出しの世代番号。接続先の
    // 切替や、展開/編集中のbaseUrl・APIキー変更で再fetchが競合したとき
    // （例: 旧接続先へのfetchが進行中に別の接続先へ切り替えると新fetchが
    // 走る）、後から返ってきた古い応答が新しい結果を上書きしないようにする
    // ための単調増加カウンタ。再レンダー不要なのでuseStateではなくuseRef。
    const providerFetchGenerationRef = useRef(new Map());

    const refreshSharedConfig = () => setSharedConfig(getSharedLlmConfig());

    // 接続先/モデルどちらのセクションのインライン編集・追加行も同時に1つだけ
    // アクティブ（片方を開いたらもう片方は閉じる）。行を開くハンドラは全員
    // ここから呼んで既存の行を閉じてから自分を開く。
    const closeAllInlineRows = () => {
        setEditingProviderId('');
        setAddingProvider(false);
        setEditingPresetId('');
        setAddingModel(false);
    };

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

    // 編集対象（接続先行編集・プリセット行編集）が、他タブでの削除などで
    // 消えたら該当のインラインUIを閉じる。
    useEffect(() => {
        if (editingProviderId && !sharedConfig.providers.some((p) => p.id === editingProviderId)) {
            setEditingProviderId('');
        }
        if (editingPresetId && !sharedConfig.presets.some((p) => p.id === editingPresetId)) {
            setEditingPresetId('');
        }
    }, [sharedConfig, editingProviderId, editingPresetId]);

    // 接続先/モデルどちらの編集行・追加行も「選択=決定」（モデルselectの
    // 変更が即確定）なので、明示的な確定ボタンを持たない。ラベルだけ直して
    // 離脱するようなケースのために、行の外側をクリックしたら開いている行を
    // 閉じる（Escapeキーでも閉じる）。4つの状態は同時に1つだけしか開かない
    // ので、実際にDOMに存在する行にこのrefを付ける（各render関数側）。
    // ここではdocument付きのclickリスナーを使うため、フォーカス移動に伴う
    // inputのblur（ラベル/モデル手入力の確定処理）はブラウザの仕様上、外側
    // 要素のclickイベントより先に発火することが保証されている（blurは新しい
    // 要素へのフォーカス移動時に、その要素のclick/mousedown系イベントより
    // 前に同期的に発生するため）。よって「blur確定→行を閉じる」の順序は
    // 自然に守られる。
    //
    // 注意: click イベントの target は mousedown/mouseup 両方の位置から
    // ブラウザが決める共通の祖先要素になる。ラベル入力内でテキストを
    // マウスドラッグ選択し、行の外までカーソルが出た状態でボタンを離すと、
    // mousedown は行内で始まっているにも関わらず click の target が行外に
    // なり、テキスト選択のつもりが「外側クリック」と誤判定されて行が
    // 閉じてしまう（selectstart→mouseup→click の一連の操作で、target が
    // mouseup 位置寄りになるため）。これを防ぐため、mousedown の発生位置も
    // 記録し、mousedown が行内で始まっていれば click は無視する。
    const activeRowRef = useRef(null);
    const mouseDownInsideRef = useRef(false);
    useEffect(() => {
        if (!editingProviderId && !addingProvider && !editingPresetId && !addingModel) return undefined;

        const handleDocumentMouseDown = (event) => {
            mouseDownInsideRef.current = Boolean(
                activeRowRef.current && activeRowRef.current.contains(event.target)
            );
        };
        const handleDocumentClick = (event) => {
            if (activeRowRef.current && activeRowRef.current.contains(event.target)) return;
            if (mouseDownInsideRef.current) return;
            closeAllInlineRows();
        };
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') closeAllInlineRows();
        };

        document.addEventListener('mousedown', handleDocumentMouseDown);
        document.addEventListener('click', handleDocumentClick);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handleDocumentMouseDown);
            document.removeEventListener('click', handleDocumentClick);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [editingProviderId, addingProvider, editingPresetId, addingModel]);

    const updateSettings = (nextSettings) => {
        setSettings(nextSettings);
        saveAiSettings(nextSettings);
        window.dispatchEvent(new CustomEvent('sync-data-updated'));
    };

    // providerId単位でのモデル一覧取得。モデルセクションの編集/追加行で接続先
    // セレクトが選ばれた時（未取得の場合のみ、または接続先切替時は強制）と、
    // 接続先行のbaseUrl/APIキー確定時（キャッシュ無効化後）に自動で呼ばれる。
    // 0件は取得失敗とみなし、そのproviderのモデルUI向けにエラーメッセージを
    // 用意する。この自動fetchの成否が接続確認を兼ねるため、別途の「接続
    // テスト」操作は持たない。
    const fetchProviderModels = async (provider) => {
        if (!provider) return [];
        const generations = providerFetchGenerationRef.current;
        const myGeneration = (generations.get(provider.id) || 0) + 1;
        generations.set(provider.id, myGeneration);
        const isStale = () => generations.get(provider.id) !== myGeneration;

        setLoadingProviderId(provider.id);
        setProviderModelErrors((current) => ({ ...current, [provider.id]: '' }));
        const models = await getAvailableModels({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
        // 待っている間に同じproviderへの新しいfetchが割り込んでいたら、この
        // 古い応答でstateを上書きせず黙って破棄する。
        if (isStale()) return models;
        setModelsByProviderId((current) => ({ ...current, [provider.id]: models }));
        if (models.length === 0) {
            setProviderModelErrors((current) => ({ ...current, [provider.id]: MODEL_FETCH_ERROR_MESSAGE }));
        }
        setLoadingProviderId((current) => (current === provider.id ? '' : current));
        return models;
    };

    // 接続先セレクトで対象providerが決まった時に呼ぶ共通ヘルパー。force指定
    // 時は必ず再fetchする（接続先の切替時: baseUrl/apiKeyが変わりうるので
    // キャッシュを信用しない）。force無しは未取得の時だけfetchする（行を
    // 開いた直後、既存presetの現在の接続先に対する初回表示はキャッシュを
    // 再利用してよい）。
    // mist-network:// providers (see services/networkModels.js) have no HTTP
    // model list to fetch - getAvailableModels already returns [] for them,
    // but skipping the call here also avoids setting a misleading "取得
    // できませんでした" error for a provider that was never supposed to have
    // one (spec llm-settings-common-v1.md §3.1: no model fetch / connection
    // test for these rows).
    const ensureProviderModelsFetched = (providerId, { force = false } = {}) => {
        if (!providerId) return;
        if (!force && modelsByProviderId[providerId] !== undefined) return;
        const provider = sharedConfig.providers.find((p) => p.id === providerId);
        if (!provider || isNetworkProviderBaseUrl(provider.baseUrl)) return;
        fetchProviderModels(provider);
    };

    // fetchProviderModels()がまだ動いている/未取得の間はselect表示のまま
    // 「取得中…」を出し、0件で確定したら手入力にフォールバックする
    // （手動での「手入力に切り替え」操作は廃止し、fetch結果から自動導出する）。
    const getModelSelectionState = (providerId) => {
        const isLoading = loadingProviderId === providerId;
        const models = modelsByProviderId[providerId] || [];
        return { isLoading, models, mode: isLoading || models.length > 0 ? 'select' : 'manual' };
    };

    // ★の全廃に伴い、defaultPresetIdは「タスク未割当時の最終フォールバック」
    // としてデータ上残るが、UIから明示的に選ぶ手段はない。プリセット/接続先
    // の削除操作の後に呼び、defaultPresetIdが存在しないpresetを指す/空に
    // なっていたら先頭presetへ自動的に付け替える（宙に浮かせない）。
    const reassignDefaultPresetIfMissing = () => {
        const config = getSharedLlmConfig();
        const stillValid = config.presets.some((p) => p.id === config.defaultPresetId);
        if (!stillValid) {
            setDefaultLlmPresetId(config.presets[0]?.id || '');
        }
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

    // --- 接続先セクション（Provider） --------------------------------------------
    // モデルセクションとは独立したフラットな一覧。行を開いてもモデル一覧は
    // 出さない（階層関係にはしない）。

    const handleOpenEditProvider = (provider) => {
        closeAllInlineRows();
        setEditingProviderId(provider.id);
    };

    // 決定ボタンは無し。ラベル/Base URL/APIキーはblur確定のみ（行は閉じない
    // — ラベルだけ直して離脱するケース等のため、閉じるのは外側クリック/
    // Escapeに委ねる。前ラウンドのモデル編集行と同じ方針）。
    const handleUpdateProviderField = (id, field, value) => {
        if (field === 'baseUrl' && !value.trim()) return;
        updateLlmProvider(id, { [field]: value });
        const nextConfig = getSharedLlmConfig();
        setSharedConfig(nextConfig);
        // 接続情報（baseUrl/APIキー）が変わったらモデル一覧も変わりうるため、
        // キャッシュを無効化して自動的に再取得する。
        if (field === 'baseUrl' || field === 'apiKey') {
            setModelsByProviderId((current) => {
                const next = { ...current };
                delete next[id];
                return next;
            });
            const provider = nextConfig.providers.find((p) => p.id === id);
            if (provider && !isNetworkProviderBaseUrl(provider.baseUrl)) fetchProviderModels(provider);
        }
    };

    const handleOpenAddProvider = () => {
        closeAllInlineRows();
        setAddingProvider(true);
        setNpLabel('');
        setNpBaseUrl('');
        setNpApiKey('');
    };

    const handleCancelAddProvider = () => setAddingProvider(false);

    // 接続先セクションの追加は自由入力の複合フォーム（ラベル/Base URL/API
    // キー）で「選択」に相当する離散イベントが無いため、モデル行と違って
    // 明示的な[追加]ボタンを残す（前ラウンドの複合フォームと同じ判断）。
    // 契約安全: モデルを同時作成しない単独provider作成は addLlmProvider() の
    // みを経由する（旧addConnectionのprovider+preset同時作成は使わない）。
    const handleSaveNewProvider = () => {
        const baseUrl = npBaseUrl.trim().replace(/\/$/, '');
        if (!baseUrl) return;
        addLlmProvider({ label: npLabel.trim(), baseUrl, apiKey: npApiKey });
        setAddingProvider(false);
        refreshSharedConfig();
    };

    // ×削除: 紐づくpresetがあれば件数を明示してconfirmし、removeLlmProvider
    // のカスケード（参照presetもまとめて削除）に一括で乗せる。紐づくpresetが
    // 無ければ単純なconfirmのみ。
    const handleRemoveProviderRow = (provider) => {
        const linkedPresetCount = sharedConfig.presets.filter((p) => p.providerId === provider.id).length;
        const confirmMessage =
            linkedPresetCount > 0
                ? `この接続先を削除すると、紐づく${linkedPresetCount}件のモデルも削除されます。よろしいですか？`
                : 'この接続先を削除しますか？';
        if (!confirm(confirmMessage)) return;
        removeLlmProvider(provider.id);
        reassignDefaultPresetIfMissing();
        clearOrphanedTaskPresetIds();
        setModelsByProviderId((current) => {
            const next = { ...current };
            delete next[provider.id];
            return next;
        });
        setProviderModelErrors((current) => {
            const next = { ...current };
            delete next[provider.id];
            return next;
        });
        if (editingProviderId === provider.id) setEditingProviderId('');
        // モデル追加/編集ドラフトが、たった今削除したこの接続先をまだ参照した
        // ままだと、閉じずに放置された場合に孤立preset作成（handleSaveAddModel
        // 側の存在チェックで最終的にはブロックされるが、行を開いたままにする
        // 意味が無い）や無意味な再fetchにつながる。ここで能動的に閉じる。
        if (amProviderId === provider.id) {
            setAddingModel(false);
            setAmProviderId('');
            setAmModel('');
        }
        if (epProviderId === provider.id && editingPresetId) {
            setEditingPresetId('');
        }
    };

    // --- モデルセクション（Preset） -----------------------------------------------
    // 接続先セクションとは独立したフラットな一覧（providerでグルーピングしない）。

    const handleOpenAddModel = () => {
        closeAllInlineRows();
        setAddingModel(true);
        setAmLabel('');
        setAmProviderId('');
        setAmModel('');
    };

    const handleCancelAddModel = () => setAddingModel(false);

    // 追加行の接続先セレクトが変わったら、選んだ接続先のモデル一覧を必ず
    // 再fetchする（キャッシュに古いproviderの結果が残っていても信用しない）
    // とともに、モデル選択をリセットする。
    const handleAmProviderChange = (providerId) => {
        setAmProviderId(providerId);
        setAmModel('');
        ensureProviderModelsFetched(providerId, { force: true });
    };

    // 契約安全: 既存provider配下への追加はaddLlmPreset()（内部でensurePreset）
    // を経由する。providerは新規作成しない。
    // 選択=決定: [追加]ボタンは持たないので、select変更時/手入力のblur時に
    // 直接ここへ来て追加し行を閉じる。modelOverrideは select の onChange から
    // 呼ぶ場合に使う — setAmModel(value)は非同期なので、change直後に
    // amModel stateを読むとまだ古い値のままになるため、選択値をそのまま渡す。
    const handleSaveAddModel = (modelOverride) => {
        const model = (modelOverride ?? amModel).trim();
        if (!amProviderId || !model) return;
        // 最終防御: 追加行を開いたまま対象の接続先が削除された場合（同一タブ
        // ではhandleRemoveProviderRowが行を閉じるので通常到達しないが、他タブ
        // での削除など経路が漏れた場合）、存在しないproviderIdを参照する孤立
        // presetを作らないよう保存自体をブロックする。
        if (!sharedConfig.providers.some((p) => p.id === amProviderId)) {
            setProviderModelErrors((current) => ({
                ...current,
                [amProviderId]: 'この接続先は削除されました。接続先を選び直してください。',
            }));
            return;
        }
        addLlmPreset({ label: amLabel.trim() || model, providerId: amProviderId, model });
        setAddingModel(false);
        refreshSharedConfig();
    };

    const handleAmModelSelectChange = (value) => {
        setAmModel(value);
        handleSaveAddModel(value);
    };

    // モデル行本体クリックでインライン編集を開く。現在の接続先のモデル一覧が
    // 未取得ならここでfetchする（キャッシュ済みなら再fetchしない）。
    const handleOpenEditPreset = (preset) => {
        closeAllInlineRows();
        setEditingPresetId(preset.id);
        setEpLabel(preset.label);
        setEpProviderId(preset.providerId);
        setEpModel(preset.model);
        ensureProviderModelsFetched(preset.providerId);
    };

    const handleUpdatePreset = (id, patch) => {
        updateLlmPreset(id, patch);
        refreshSharedConfig();
    };

    // ラベルはEnter/blurしても行を閉じない: ラベルだけ直して他フィールドへ
    // 移る/外側をクリックして終える運用を想定しているため（外側クリックで
    // 閉じるのは前段のuseEffect側が担当する）。
    const handleEpLabelBlur = (preset) => {
        const label = epLabel.trim() || preset.model;
        if (label !== preset.label) handleUpdatePreset(preset.id, { label });
    };

    // 接続先セレクトの変更は即 updateLlmPreset(id, {providerId}) で反映する
    // （選択=決定）。ただしモデル名は旧接続先のものが残っているとミスマッチ
    // になるため、モデル選択はリセットし、新しい接続先のモデル一覧を必ず
    // 再fetchする。行は閉じない（続けてモデルを選ぶまで開いたままにする）。
    const handleEpProviderChange = (preset, providerId) => {
        setEpProviderId(providerId);
        setEpModel('');
        handleUpdatePreset(preset.id, { providerId });
        ensureProviderModelsFetched(providerId, { force: true });
    };

    // 選択=決定: モデルselectのchangeは即確定として扱い、行を閉じる。
    // 念のための防御: epProviderIdが指す接続先が既に無ければ（通常はこの行
    // 自体をhandleRemoveProviderRow側が閉じるので到達しないが、念のため）
    // 更新はスキップして行だけ閉じる。
    const handleEpModelSelectChange = (preset, value) => {
        setEpModel(value);
        if (sharedConfig.providers.some((p) => p.id === epProviderId)) {
            handleUpdatePreset(preset.id, { model: value });
        }
        setEditingPresetId('');
    };

    // 手入力フォールバック時もblur/Enter（Enterはonキーで手動blur）で確定し、
    // 行を閉じる。同様にepProviderIdの存在チェックを念のため行う。
    const handleEpModelManualBlur = (preset) => {
        const model = epModel.trim();
        if (model && model !== preset.model && sharedConfig.providers.some((p) => p.id === epProviderId)) {
            handleUpdatePreset(preset.id, { model });
        }
        setEditingPresetId('');
    };

    // ×削除: removeLlmPresetのみ（providerは削除しない — 接続先セクションと
    // 完全に独立させるため、モデル側の削除で接続先が連鎖して消えることは
    // ない。接続先を消したい場合は接続先セクションの×から行う）。
    const handleRemovePresetRow = (id) => {
        if (!confirm('このモデルを削除しますか？')) return;
        removeLlmPreset(id);
        reassignDefaultPresetIfMissing();
        const nextTaskPresetIds = Object.fromEntries(
            AI_TASKS.map((task) => [task, settings.taskPresetIds[task] === id ? '' : settings.taskPresetIds[task]])
        );
        updateSettings({ ...settings, taskPresetIds: nextTaskPresetIds });
        if (editingPresetId === id) setEditingPresetId('');
    };

    // settings.taskPresetIdsの逆引き: そのpresetIdが「明示的に」割り当てら
    // れているタスクキー一覧を返す（chat経由/既定経由の暗黙フォールバックは
    // 含まない — taskPresetIds[task]が空文字列のタスクはここには出てこない）。
    const getExplicitTasksForPreset = (presetId) =>
        AI_TASKS.filter((task) => settings.taskPresetIds[task] === presetId);

    // True when `providerId` resolves to the mist-network:// pseudo-provider
    // (a model discovered via the AI Network room), as opposed to a regular
    // HTTP connection the user configured directly (spec §2.2).
    const isNetworkPresetProvider = (providerId) => {
        const provider = sharedConfig.providers.find((p) => p.id === providerId);
        return provider ? isNetworkProviderBaseUrl(provider.baseUrl) : false;
    };

    // Badges shown on a preset card: 既定 / explicit task assignments /
    // Network由来 / 共有中 (spec §3.1).
    const getPresetBadges = (preset) => {
        const badges = [];
        if (sharedConfig.defaultPresetId === preset.id) badges.push('既定');
        getExplicitTasksForPreset(preset.id).forEach((task) => badges.push(TASK_LABELS[task]));
        if (isNetworkPresetProvider(preset.providerId)) badges.push('Network由来');
        if (settings.networkProviderPresetIds.includes(preset.id)) badges.push('共有中');
        return badges;
    };

    // --- Tasks -----------------------------------------------------------------

    const handleTaskPresetChange = (task, presetId) => {
        updateSettings({ ...settings, taskPresetIds: { ...settings.taskPresetIds, [task]: presetId } });
    };

    // setTaskReasoningEffort persists directly (it doesn't go through this
    // component's updateSettings/saveAiSettings round-trip), so refresh local
    // state and notify other listeners (e.g. the app-level network hooks)
    // the same way updateSettings does for every other ai-settings write.
    const handleTaskReasoningEffortChange = (task, effort) => {
        setTaskReasoningEffort(task, effort);
        setSettings(getAiSettings());
        window.dispatchEvent(new CustomEvent('sync-data-updated'));
    };

    // --- Network -----------------------------------------------------------

    const handleConsumerToggle = (enabled) => {
        updateSettings({ ...settings, backend: enabled ? 'mistllm' : 'http' });
        if (!enabled) {
            mistllm.disconnect();
        }
    };

    // Toggles a preset's membership in the set of presets advertised to the
    // AI Network room (settings.networkProviderPresetIds), preserving order.
    const handleToggleShareModel = (presetId, checked) => {
        const current = settings.networkProviderPresetIds;
        const next = checked ? [...current, presetId] : current.filter((id) => id !== presetId);
        updateSettings({ ...settings, networkProviderPresetIds: next });
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

    // --- 接続先セクション（Provider）の行描画 -------------------------------------
    // モデルセクションとネストしない、独立したフラットな行リスト。

    const renderProviderRow = (provider) => {
        const isEditing = editingProviderId === provider.id;
        const isNetworkProvider = isNetworkProviderBaseUrl(provider.baseUrl);
        const hostLabel = getHostLabel(provider.baseUrl);
        // The raw `mist-network://<room>` URL is meaningless to a user - show
        // a note instead (spec §3.1), same idea as the model-row-network
        // accent applied below.
        const secondLine = isNetworkProvider ? 'LLM Network ルーム' : hostLabel;

        if (isEditing) {
            // 決定ボタンは無し。各フィールドはblur確定のみで行は閉じない
            // （外側クリック/Escapeで閉じる）。エラー表示は、blur確定時に
            // 自動fetchされるモデル一覧の成否＝簡易的な接続確認を兼ねる
            // （モデルセクション側と同じ providerModelErrors キャッシュを
            // 参照するので、モデル行編集で既に取得済みならここにも反映される）。
            return (
                <div className="model-row model-row-editing" key={provider.id} ref={activeRowRef}>
                    <div className="model-row-edit-fields">
                        <input
                            value={provider.label}
                            onBlur={(event) => handleUpdateProviderField(provider.id, 'label', event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') event.target.blur();
                            }}
                            placeholder="ラベル（省略可）"
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
                            placeholder="API Key（ローカルLLMでは省略可）"
                            autoComplete="off"
                        />
                        {providerModelErrors[provider.id] && (
                            <p className="hint connection-form-warning">{providerModelErrors[provider.id]}</p>
                        )}
                    </div>
                </div>
            );
        }

        return (
            <div className={`model-row${isNetworkProvider ? ' model-row-network' : ''}`} key={provider.id}>
                <button type="button" className="model-row-main" onClick={() => handleOpenEditProvider(provider)}>
                    <span className="model-row-label">{provider.label || hostLabel}</span>
                    <span className="model-row-model">{secondLine}</span>
                </button>
                <span
                    className="preset-chip-remove model-row-remove"
                    role="button"
                    tabIndex={0}
                    title="接続先を削除"
                    onClick={(event) => {
                        event.stopPropagation();
                        handleRemoveProviderRow(provider);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            event.stopPropagation();
                            handleRemoveProviderRow(provider);
                        }
                    }}
                >
                    <X size={13} />
                </span>
            </div>
        );
    };

    // グリッド末尾に置く「接続先を追加」タイル。追加行が開いていなければ
    // 破線枠のプレースホルダタイル、開いていればそのままrenderAddProviderRow()
    // の展開フォームに差し替わる（同じグリッド位置に留まる。展開時は
    // .model-row-editingのgrid-column: 1/-1がグリッド全幅にする）。
    const renderAddProviderTile = () => {
        if (addingProvider) return renderAddProviderRow();
        return (
            <button type="button" className="grid-add-tile" onClick={handleOpenAddProvider}>
                <Plus size={16} />
                <span>接続先を追加</span>
            </button>
        );
    };

    // 接続先セクションの追加は自由入力の複合フォームなので明示的な[追加]/
    // [キャンセル]を持つ（モデルの追加/編集行と違い「選択」に相当する離散
    // イベントが無いため）。
    const renderAddProviderRow = () => (
        <div className="model-row model-row-editing model-row-add" ref={activeRowRef}>
            <div className="model-row-edit-fields">
                <input
                    value={npLabel}
                    onInput={(event) => setNpLabel(event.target.value)}
                    placeholder="ラベル（省略可）"
                    autoComplete="off"
                />
                <input
                    value={npBaseUrl}
                    onInput={(event) => setNpBaseUrl(event.target.value)}
                    placeholder="https://..."
                    autoComplete="off"
                />
                <input
                    type="password"
                    value={npApiKey}
                    onInput={(event) => setNpApiKey(event.target.value)}
                    placeholder="API Key（ローカルLLMでは省略可）"
                    autoComplete="off"
                />
            </div>
            <div className="model-row-add-actions">
                <button
                    type="button"
                    className="connection-form-btn connection-form-btn-primary"
                    onClick={handleSaveNewProvider}
                    disabled={!npBaseUrl.trim()}
                >
                    <Plus size={13} />
                    追加
                </button>
                <button type="button" className="connection-form-btn" onClick={handleCancelAddProvider}>
                    キャンセル
                </button>
            </div>
        </div>
    );

    // --- モデルセクション（Preset）の行描画 ---------------------------------------
    // 接続先セクションとネストしない、独立したフラットな行リスト（provider
    // でグルーピングしない）。

    // 選択=決定: selectで選択した瞬間/手入力のblur・Enterで確定して行を閉じる
    // ため、[追加]ボタンは持たない。[キャンセル]だけ誤って開いたときの明示的
    // な閉じ口として残す。外側クリック/Escapeでも閉じる（activeRowRefで判定）。
    const renderAddModelRow = () => {
        const { mode: amMode, isLoading: amLoading, models: providerModels } = getModelSelectionState(amProviderId);
        const modelError = amProviderId ? providerModelErrors[amProviderId] : '';
        return (
            <div className="model-row model-row-editing model-row-add" ref={activeRowRef}>
                <div className="model-row-edit-fields">
                    <input
                        value={amLabel}
                        onInput={(event) => setAmLabel(event.target.value)}
                        placeholder="ラベル（省略可）"
                        autoComplete="off"
                    />
                    <select value={amProviderId} onChange={(event) => handleAmProviderChange(event.target.value)}>
                        <option value="" disabled>接続先を選択...</option>
                        {sharedConfig.providers.map((provider) => (
                            <option key={provider.id} value={provider.id}>
                                {provider.label || getHostLabel(provider.baseUrl)}
                            </option>
                        ))}
                    </select>
                    <div className="connection-form-model-field">
                        {!amProviderId ? (
                            <select value="" disabled>
                                <option value="">先に接続先を選んでください</option>
                            </select>
                        ) : amMode === 'select' ? (
                            <select value={amModel} onChange={(event) => handleAmModelSelectChange(event.target.value)}>
                                <option value="" disabled>
                                    {amLoading
                                        ? '取得中…'
                                        : providerModels.length
                                            ? 'モデルを選択...'
                                            : 'モデル一覧を取得してください'}
                                </option>
                                {providerModels.map((model) => (
                                    <option key={model} value={model}>{model}</option>
                                ))}
                            </select>
                        ) : (
                            <input
                                value={amModel}
                                onInput={(event) => setAmModel(event.target.value)}
                                onBlur={() => handleSaveAddModel()}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') event.target.blur();
                                }}
                                placeholder="モデル名"
                                autoComplete="off"
                            />
                        )}
                    </div>
                    {modelError && <p className="hint connection-form-warning">{modelError}</p>}
                </div>
                <div className="model-row-add-actions">
                    <button type="button" className="connection-form-btn" onClick={handleCancelAddModel}>
                        キャンセル
                    </button>
                </div>
            </div>
        );
    };

    // グリッド末尾に置く「モデルを追加」タイル。接続先が1件も無ければ無効化
    // したタイルを出す（現状の挙動＝ヘッダーボタンのdisabled+titleを踏襲）。
    // それ以外はrenderAddProviderTileと同じ考え方（プレースホルダ⇄展開フォーム）。
    const renderAddModelTile = () => {
        if (sharedConfig.providers.length === 0) {
            return (
                <button type="button" className="grid-add-tile" disabled title="先に接続先を追加してください">
                    <Plus size={16} />
                    <span>モデルを追加</span>
                </button>
            );
        }
        if (addingModel) return renderAddModelRow();
        return (
            <button type="button" className="grid-add-tile" onClick={handleOpenAddModel}>
                <Plus size={16} />
                <span>モデルを追加</span>
            </button>
        );
    };

    const renderModelRow = (preset) => {
        const isEditing = editingPresetId === preset.id;

        if (isEditing) {
            const { mode: epMode, isLoading: epLoading, models: providerModels } = getModelSelectionState(epProviderId);
            const modelError = epProviderId ? providerModelErrors[epProviderId] : '';
            return (
                <div className="model-row model-row-editing" key={preset.id} ref={activeRowRef}>
                    <div className="model-row-edit-fields">
                        <input
                            value={epLabel}
                            onInput={(event) => setEpLabel(event.target.value)}
                            onBlur={() => handleEpLabelBlur(preset)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') event.target.blur();
                            }}
                            placeholder="ラベル"
                            autoComplete="off"
                        />
                        <select
                            value={epProviderId}
                            onChange={(event) => handleEpProviderChange(preset, event.target.value)}
                        >
                            {sharedConfig.providers.map((provider) => (
                                <option key={provider.id} value={provider.id}>
                                    {provider.label || getHostLabel(provider.baseUrl)}
                                </option>
                            ))}
                        </select>
                        <div className="connection-form-model-field">
                            {epMode === 'select' ? (
                                <select value={epModel} onChange={(event) => handleEpModelSelectChange(preset, event.target.value)}>
                                    <option value="" disabled>
                                        {epLoading
                                            ? '取得中…'
                                            : providerModels.length
                                                ? 'モデルを選択...'
                                                : 'モデル一覧を取得してください'}
                                    </option>
                                    {epModel && !providerModels.includes(epModel) && (
                                        <option value={epModel}>{epModel}</option>
                                    )}
                                    {providerModels.map((model) => (
                                        <option key={model} value={model}>{model}</option>
                                    ))}
                                </select>
                            ) : (
                                <input
                                    value={epModel}
                                    onInput={(event) => setEpModel(event.target.value)}
                                    onBlur={() => handleEpModelManualBlur(preset)}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter') event.target.blur();
                                    }}
                                    placeholder="モデル名"
                                    autoComplete="off"
                                />
                            )}
                        </div>
                        {modelError && <p className="hint connection-form-warning">{modelError}</p>}
                    </div>
                </div>
            );
        }

        const badges = getPresetBadges(preset);
        const isNetworkPreset = isNetworkPresetProvider(preset.providerId);
        return (
            <div className={`model-row${isNetworkPreset ? ' model-row-network' : ''}`} key={preset.id}>
                <button type="button" className="model-row-main" onClick={() => handleOpenEditPreset(preset)}>
                    <span className="model-row-label">{preset.label}</span>
                    <span className="model-row-model">{preset.model}</span>
                    <span className="model-row-provider">{getProviderLabel(preset.providerId)}</span>
                </button>
                {badges.length > 0 && (
                    <span className="model-row-badges">
                        {badges.map((badge) => (
                            <span key={badge} className="task-badge">{badge}</span>
                        ))}
                    </span>
                )}
                <span
                    className="preset-chip-remove model-row-remove"
                    role="button"
                    tabIndex={0}
                    title="モデルを削除"
                    onClick={(event) => {
                        event.stopPropagation();
                        handleRemovePresetRow(preset.id);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            event.stopPropagation();
                            handleRemovePresetRow(preset.id);
                        }
                    }}
                >
                    <X size={13} />
                </span>
            </div>
        );
    };

    // 接続先セクションとモデルセクションは見出しとグリッドのみで互いに独立
    // （階層関係にはしない）。追加の入口はヘッダーボタンではなく、グリッド
    // 末尾の破線タイル（renderAddProviderTile/renderAddModelTile）。背景色の
    // ゾーニングは前ラウンドの配色パターン（接続先=--primary-soft寄り/
    // モデル=--surface-3寄り）をカード単位に流用する（CSS側、.model-row-list
    // .model-rowへの適用）。
    const renderDirectApiSection = () => (
        <>
            <div className="server-list-header">
                <label>接続先</label>
            </div>
            <div className="settings-flat-section settings-flat-section-connection">
                {sharedConfig.providers.length === 0 && !addingProvider && (
                    <p className="hint">まだ接続先がありません。「+ 接続先を追加」から追加してください。</p>
                )}
                <div className="model-row-list">
                    {sharedConfig.providers.map((provider) => renderProviderRow(provider))}
                    {renderAddProviderTile()}
                </div>
            </div>

            <div className="server-list-header">
                <label>モデル</label>
            </div>
            <div className="settings-flat-section settings-flat-section-models">
                {sharedConfig.providers.length === 0 && (
                    <p className="hint">先に接続先を追加してください。</p>
                )}
                {sharedConfig.providers.length > 0 && sharedConfig.presets.length === 0 && !addingModel && (
                    <p className="hint">まだモデルがありません。「+ モデルを追加」から追加してください。</p>
                )}
                <div className="model-row-list">
                    {sharedConfig.presets.map((preset) => renderModelRow(preset))}
                    {renderAddModelTile()}
                </div>
            </div>
        </>
    );

    // AI接続タブはもう接続方式トグルを持たない — 直接APIのprovider/preset
    // CRUDのみのフラットなセクション（mist-network://由来の行もここに並ぶ。
    // 削除はできるが、fetchや接続テストの対象からは除外される — 前段の
    // ensureProviderModelsFetched/handleUpdateProviderFieldのガード参照）。
    const renderConnectionTab = () => (
        <>
            <p className="hint">
                接続（Base URL・APIキー）とプリセットは同一オリジンの他アプリ（tc-note、tc-translateなど）とも共有されます。一度設定すれば他アプリでも再利用できます。
            </p>
            {renderDirectApiSection()}
        </>
    );

    // Presets shareable to the AI Network room: must resolve to a real HTTP
    // provider - a preset whose provider is itself the mist-network://
    // pseudo-provider (i.e. imported from the room) can't be re-shared
    // (spec §3.3/§4.2 - re-advertising it would loop traffic back into the
    // room it came from).
    const eligiblePresets = sharedConfig.presets.filter((preset) => !isNetworkPresetProvider(preset.providerId));

    // AI Networkタブ: Room ID / 「ネットワークのLLMを使う」トグル（旧・接続
    // 方式トグルをここへ移設）+ 接続状況 / 「providerとして参加」トグル + 共有
    // モデルチェックリスト + 状態パネル（spec §3.3）。
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

            <div className="settings-role-group">
                <div className="settings-role-card">
                    <label className="settings-role-head">
                        <input
                            type="checkbox"
                            checked={isMistllm}
                            onChange={(event) => handleConsumerToggle(event.target.checked)}
                        />
                        <span className="settings-role-title">
                            <strong>ネットワークのLLMを使う</strong>
                            <span className="hint">オンにすると、この端末のAI機能はRoom内のプロバイダが提供するモデルを使うようになります。</span>
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
                            <p className="hint">Roomで見つかったモデルは自動的に「AI接続」タブのモデル一覧へ取り込まれます。</p>
                        </div>
                    )}
                </div>

                <NetworkProviderCard
                    networkProviderEnabled={settings.networkProviderEnabled}
                    roomId={sharedConfig.network.roomId}
                    networkProviderPresetIds={settings.networkProviderPresetIds}
                    eligiblePresets={eligiblePresets}
                    onToggleShareModel={handleToggleShareModel}
                    getProviderLabel={getProviderLabel}
                    onToggle={(enabled) => updateSettings({ ...settings, networkProviderEnabled: enabled })}
                />
            </div>
        </>
    );

    const renderIntroTab = () => (
        <div className="form-group">
            <p className="hint">初回セットアップのガイドをもう一度開けます。</p>
            <button className="save-btn" onClick={requestOnboarding}>
                <Sparkles size={14} />
                セットアップガイドを開く
            </button>
        </div>
    );

    // reasoning_effort select（5段階）: 各タスク行の2つ目のフィールド。値は
    // getTaskReasoningEffort/setTaskReasoningEffort（services/ai.js）で読み書き。
    const renderReasoningEffortSelect = (task) => (
        <div className="task-model-field">
            <select
                value={getTaskReasoningEffort(task)}
                onChange={(event) => handleTaskReasoningEffortChange(task, event.target.value)}
                aria-label={`${TASK_LABELS[task]}のreasoning_effort`}
                title="reasoning_effort"
            >
                {REASONING_EFFORT_OPTIONS.map((effort) => (
                    <option key={effort} value={effort}>{effort}</option>
                ))}
            </select>
        </div>
    );

    // タスクタブ: 常時表示のヒント段落は置かず、各行ラベルのhoverツールチップ
    // （data-tip、CSS側はindex.cssの `.task-model-item > span[data-tip]`）に
    // 説明を持たせる（spec §3.2/§4）。preset selectの選択肢は共有presets全部
    // （Network由来カード含む — 選べばそのタスクの経路もnetworkになる）。
    const renderTasksTab = () => (
        <div className="form-group">
            {AI_TASKS.map((task) => (
                <div key={task} className="task-model-item">
                    <span data-tip={TASK_TIPS[task]}>{TASK_LABELS[task]}</span>
                    <div className="task-model-fields">
                        <div className="task-model-field">
                            <select
                                id={`select-preset-${task}`}
                                name={`select-preset-${task}`}
                                aria-label={`${TASK_LABELS[task]}のモデル`}
                                value={settings.taskPresetIds[task] || ''}
                                onChange={(event) => handleTaskPresetChange(task, event.target.value)}
                                autoComplete="off"
                            >
                                <option value="">既定と同じ</option>
                                {sharedConfig.presets.map((preset) => (
                                    <option key={preset.id} value={preset.id}>
                                        {preset.label}（{getProviderLabel(preset.providerId)}）
                                    </option>
                                ))}
                            </select>
                        </div>
                        {renderReasoningEffortSelect(task)}
                    </div>
                </div>
            ))}
        </div>
    );

    return (
        <div className="settings-section">
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
                {activeTab === 'intro' && renderIntroTab()}
                {activeTab === 'connection' && renderConnectionTab()}
                {activeTab === 'network' && renderNetworkTab()}
                {activeTab === 'tasks' && renderTasksTab()}
            </div>
        </div>
    );
}
