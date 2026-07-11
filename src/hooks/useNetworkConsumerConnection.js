import { useEffect } from 'preact/hooks';
import { getMistllmConsumer } from '../services/mistllm';

/**
 * Eagerly (re)connects the shared MistllmConsumer whenever the 'mistllm'
 * backend is selected and a Room ID is present, instead of waiting for the
 * first chatAi() call to lazily join. Mounted at the app level (see App.jsx)
 * so the connection — and its live phase progress shown in SettingsPanel —
 * persists whether or not the settings panel is open.
 *
 * Ported from tc-translate's src/hooks/useNetworkConsumerConnection.ts.
 */
export function useNetworkConsumerConnection({ backend, roomId }) {
    const enabled = backend === 'mistllm';
    const trimmedRoomId = (roomId || '').trim();

    useEffect(() => {
        const consumer = getMistllmConsumer();

        if (!enabled || !trimmedRoomId) {
            consumer.disconnect();
            return;
        }

        // Debounce so a connection attempt isn't fired on every keystroke
        // while the user is still typing the Room ID.
        const timer = window.setTimeout(() => {
            consumer.connect(trimmedRoomId).catch((err) => {
                console.error('Mist LLM接続に失敗しました:', err);
            });
        }, 500);

        return () => {
            window.clearTimeout(timer);
            // Intentionally not disconnecting here: the consumer session is
            // keyed by roomId inside MistllmConsumer.connect(), and connecting
            // on every unrelated settings render would thrash the connection.
            // Disconnection happens explicitly above when disabled.
        };
    }, [enabled, trimmedRoomId]);
}
