import { useEffect, useState } from 'preact/hooks';
import { getMistllmConsumer } from '../services/mistllm';
import { emptyLlmConfig, ensurePreset, ensureProvider, loadLlmConfig, normalizeBaseUrl, saveLlmConfig } from '../services/llmConfig';
import { NETWORK_PROVIDER_LABEL, networkProviderBaseUrl, presetsForProvider } from '../services/networkModels';

/**
 * Mirrors the model names advertised by LLM Network room providers (their
 * preset labels, falling back to model ids - see advertisedModelName in
 * services/networkModels.js) into the shared llm config, so they show up as
 * ordinary presets - under a `mist-network://<roomId>` pseudo-provider - that
 * the user can pick as a task's preset just like one backed by a real HTTP
 * provider (see resolvePreset in services/llmConfig.js, which doesn't
 * distinguish the two).
 *
 * A mirror, not an append-only import: while connected, presets under the
 * room's pseudo-provider whose model is no longer advertised are pruned, so a
 * provider un-checking a shared model makes its card disappear here once the
 * re-broadcast provider_hello lands (see MistllmProvider.updateModels in
 * services/mistllm.js). Pruning is scoped strictly to the current room's
 * pseudo-provider - entries this sync itself created - so the shared config's
 * append-only convention for OTHER apps'/providers' entries still holds. A
 * disconnect ("searching"/error) is NOT a prune trigger: offline isn't the
 * same as un-shared, so imported cards survive reconnects (ported from
 * tc-translate's src/hooks/useNetworkModelSync.ts; see
 * tc-docs/drafts/llm-settings-common-v1.md §4.4).
 *
 * Pattern B design note: unlike tc-translate (which keeps the shared config
 * in a Preact-level `useSharedLlmConfig` state object threaded through every
 * hook), this app's services/ai.js/llmConfig.js always read/write
 * localStorage directly and don't cache the shared config in memory - so
 * there's no reactive "llmConfigState" to depend on here. Instead this hook
 * subscribes directly to the MistllmConsumer singleton (services/mistllm.js)
 * for the "is connected, what does it currently see" signal, and re-derives +
 * writes the shared config transaction (ensureProvider/ensurePreset/prune)
 * straight from services/llmConfig.js's primitives on every relevant status
 * tick, guarded by an in-sync no-op check so reconnects/re-renders don't
 * thrash localStorage or retrigger the cross-tab `storage` event needlessly.
 *
 * Only runs while actively consuming via the network transport
 * (`backend === 'mistllm'`) and connected to `roomId`. Mount this once at the
 * app level (see hooks/useNetworkConsumerConnection.js for the sibling hook
 * mounted the same way in App.jsx) - it has no return value, it's a
 * side-effect-only sync.
 *
 * @param {{backend: string, roomId: string}} params
 */
export function useNetworkModelSync({ backend, roomId }) {
    const consumer = getMistllmConsumer();
    const [state, setState] = useState(consumer.getState());

    useEffect(() => consumer.subscribe(setState), [consumer]);

    const trimmedRoomId = (roomId || '').trim();
    const enabled = backend === 'mistllm' && Boolean(trimmedRoomId);
    const connected = enabled && state.status === 'connected' && state.roomId === trimmedRoomId;
    const models = connected ? state.providerModels : undefined;
    // Deduped/sorted/joined into a single string so the effect below only
    // reruns when the actual model set changes, not on every unrelated
    // consumer state notification (e.g. peer count / log churn).
    const modelsKey = models && models.length ? [...new Set(models)].sort().join('\n') : '';

    useEffect(() => {
        if (!enabled || !connected) return;

        const baseUrl = networkProviderBaseUrl(trimmedRoomId);
        const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
        const modelList = modelsKey ? modelsKey.split('\n') : [];
        const modelSet = new Set(modelList);

        const config = loadLlmConfig() ?? emptyLlmConfig();
        const provider = config.providers.find((p) => p.baseUrl === normalizedBaseUrl && p.apiKey === '');

        // No-op check mirroring the mutation below against the current
        // config, so saveLlmConfig - which fires the cross-tab `storage`
        // event - is only called when there's actually something to add or
        // prune. The dedup keys match ensureProvider's/ensurePreset's own
        // (baseUrl+apiKey for the provider; providerId+model+temperature+
        // reasoningEffort for each preset).
        const inSync = provider === undefined
            ? modelList.length === 0
            : modelList.length === 0
                ? false // provider row lingers although nothing is advertised any more
                : config.presets.every((preset) => preset.providerId !== provider.id || modelSet.has(preset.model)) &&
                  modelList.every((model) =>
                      config.presets.some(
                          (preset) =>
                              preset.providerId === provider.id &&
                              preset.model === model &&
                              preset.temperature === undefined &&
                              preset.reasoningEffort === undefined,
                      ),
                  );
        if (inSync) return;

        if (modelList.length === 0) {
            // Connected, but the room advertises nothing (everything was
            // un-shared): drop the imported presets and the now-empty
            // pseudo-provider row itself.
            if (!provider) return;
            const removedPresetIds = presetsForProvider(config, provider.id).map((p) => p.id);
            config.presets = config.presets.filter((p) => p.providerId !== provider.id);
            config.providers = config.providers.filter((p) => p.id !== provider.id);
            if (removedPresetIds.includes(config.defaultPresetId)) config.defaultPresetId = '';
            saveLlmConfig(config);
            return;
        }

        const providerId = ensureProvider(config, { label: NETWORK_PROVIDER_LABEL, baseUrl, apiKey: '' });
        for (const model of modelList) {
            ensurePreset(config, { providerId, model, label: model });
        }
        const staleIds = presetsForProvider(config, providerId)
            .filter((p) => !modelSet.has(p.model))
            .map((p) => p.id);
        if (staleIds.length) {
            config.presets = config.presets.filter((p) => !staleIds.includes(p.id));
            if (staleIds.includes(config.defaultPresetId)) config.defaultPresetId = '';
        }
        saveLlmConfig(config);
    }, [enabled, connected, trimmedRoomId, modelsKey]);
}
