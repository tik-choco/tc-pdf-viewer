import { useEffect, useState } from 'preact/hooks';
import { getMistllmProvider } from '../services/mistllm';
import { streamUpstreamChatCompletion, getAiSettings, getAvailableModels } from '../services/ai';
import { getOrCreateMistllmNodeId } from '../utils/mist';

/**
 * Owns the "participate as an LLM network provider" lifecycle: joins the
 * shared mistllm room, forwards llm_request traffic to the user's configured
 * upstream HTTP AI backend, and surfaces connection/peer/request-log state
 * for SettingsPanel. Independent of `settings.backend` — provider mode can
 * run alongside this device using its own HTTP backend, or even while this
 * device also consumes from the same room.
 *
 * Ported from tc-translate's src/hooks/useNetworkProvider.ts.
 */
export function useNetworkProvider({ networkProviderEnabled, mistllmRoomId }) {
    const provider = getMistllmProvider();
    const [state, setState] = useState(provider.getState());
    const [ownNodeId] = useState(() => getOrCreateMistllmNodeId());

    useEffect(() => {
        const unsubscribe = provider.subscribe(setState);
        return unsubscribe;
    }, [provider]);

    const roomId = (mistllmRoomId || '').trim();
    const settings = getAiSettings();
    const upstreamConfigured = Boolean(
        (settings.models?.chat || '').trim() && (settings.baseUrl || '').trim()
    );

    useEffect(() => {
        if (!networkProviderEnabled || !roomId || !upstreamConfigured) {
            provider.stop();
            return;
        }

        let cancelled = false;
        // Fetched once per start (not on every provider_hello) and handed to
        // MistllmProvider.start() to advertise alongside provider_hello, so
        // consumers can offer a model picker instead of free text.
        getAvailableModels(settings).then((models) => {
            if (cancelled) return;
            provider.start(roomId, streamUpstreamChatCompletion, models).catch((err) => {
                console.error('LLMネットワーク提供の開始に失敗しました:', err);
            });
        });

        return () => {
            cancelled = true;
            // Intentionally not stopping here: MistllmProvider.start() is
            // idempotent for the same roomId (see mistllm.js), and stopping on
            // every unrelated settings render would thrash the connection.
            // Stopping happens explicitly above when disabled/misconfigured.
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [networkProviderEnabled, roomId, upstreamConfigured]);

    return {
        status: state.status,
        statusUpdatedAt: state.statusUpdatedAt,
        errorMessage: state.errorMessage,
        peers: state.peers,
        peerCount: state.peers.length,
        consumerCount: state.consumerCount,
        logs: state.logs,
        ownNodeId,
        roomId,
        upstreamConfigured,
    };
}
