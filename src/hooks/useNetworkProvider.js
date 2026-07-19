import { useEffect, useMemo, useState } from 'preact/hooks';
import { getMistllmProvider } from '../services/mistllm';
import {
    streamNetworkProviderChatCompletion,
    resolveUpstreamProviderTarget,
    getAdvertisedNetworkModels,
    subscribeLlmConfig,
} from '../services/ai';
import { getOrCreateMistllmNodeId } from '../utils/mist';

/**
 * Owns the "participate as an LLM network provider" lifecycle: joins the
 * shared mistllm room, forwards llm_request traffic to the user's configured
 * upstream HTTP AI backend (falling back path), or - for a named request that
 * matches a checked-to-share preset - to that preset's own connection (see
 * services/ai.js streamNetworkProviderChatCompletion / spec §4.5), and
 * surfaces connection/peer/request-log state for SettingsPanel. Independent
 * of `settings.backend` — provider mode can run alongside this device using
 * its own HTTP backend, or even while this device also consumes from the
 * same room.
 *
 * Ported from tc-translate's src/hooks/useNetworkProvider.ts. One behavior
 * change from this app's original version: provider_hello.models used to be
 * this device's raw upstream HTTP model list (fetched once via
 * getAvailableModels); it's now the advertised names (see
 * advertisedModelName in services/networkModels.js) of ONLY the presets the
 * user explicitly checked to share (`networkProviderPresetIds`), matching the
 * opt-in sharing model in tc-docs/drafts/llm-settings-common-v1.md §2.3/§3.3
 * - a provider with an empty share list now advertises no models at all
 * (still answering model-less requests via the legacy default-upstream path)
 * instead of every model its own upstream happens to offer.
 *
 * @param {{networkProviderEnabled: boolean, roomId: string, networkProviderPresetIds?: string[]}} params
 */
export function useNetworkProvider({ networkProviderEnabled, roomId, networkProviderPresetIds = [] }) {
    const provider = getMistllmProvider();
    const [state, setState] = useState(provider.getState());
    const [ownNodeId] = useState(() => getOrCreateMistllmNodeId());

    useEffect(() => {
        const unsubscribe = provider.subscribe(setState);
        return unsubscribe;
    }, [provider]);

    const trimmedRoomId = (roomId || '').trim();
    // 'chat' タスクに割り当てられたプリセット(未割当なら既定プリセット)の接続先を、
    // 無名(modelなし)リクエストのアップストリームとして提供する。
    const target = resolveUpstreamProviderTarget();
    // apiKey は問わない(キーなしのローカルLLMをアップストリームにできる)。
    const upstreamConfigured = Boolean(target?.baseUrl && target?.model);

    // Recomputed whenever the share list changes, or the shared llm config
    // changes in another tab/app (subscribeLlmConfig - same-tab edits made
    // through this app's own SettingsPanel are expected to also update
    // `networkProviderPresetIds`/trigger a re-render some other way; see the
    // handoff notes for this gap). Deduped/sorted/joined into a single string
    // so the hello-resend effect below only reruns when the actual advertised
    // set changes, not on every unrelated re-render.
    const [configVersion, setConfigVersion] = useState(0);
    useEffect(() => subscribeLlmConfig(() => setConfigVersion((v) => v + 1)), []);

    const advertisedModelsKey = useMemo(
        () => getAdvertisedNetworkModels(undefined, networkProviderPresetIds).sort().join('\n'),
        [networkProviderPresetIds, configVersion],
    );
    const advertisedModels = useMemo(
        () => (advertisedModelsKey ? advertisedModelsKey.split('\n') : []),
        [advertisedModelsKey],
    );

    useEffect(() => {
        if (!networkProviderEnabled || !trimmedRoomId || !upstreamConfigured) {
            provider.stop();
            return;
        }

        provider.start(trimmedRoomId, streamNetworkProviderChatCompletion, advertisedModels).catch((err) => {
            console.error('LLMネットワーク提供の開始に失敗しました:', err);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [networkProviderEnabled, trimmedRoomId, upstreamConfigured]);

    // Hello re-send (spec §4.3): once connected, push advertised-model
    // changes to already-joined peers without leaving the room, so an
    // un/re-shared preset propagates immediately instead of waiting for the
    // next join/peer-connect. MistllmProvider.updateModels no-ops if not
    // currently connected (start() above already seeded the initial hello)
    // or if the set is unchanged.
    useEffect(() => {
        if (!networkProviderEnabled || !trimmedRoomId || !upstreamConfigured) return;
        provider.updateModels(advertisedModels);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [networkProviderEnabled, trimmedRoomId, upstreamConfigured, advertisedModelsKey]);

    return {
        status: state.status,
        statusUpdatedAt: state.statusUpdatedAt,
        errorMessage: state.errorMessage,
        peers: state.peers,
        peerCount: state.peers.length,
        consumerCount: state.consumerCount,
        logs: state.logs,
        models: state.models,
        ownNodeId,
        roomId: trimmedRoomId,
        upstreamConfigured,
    };
}
