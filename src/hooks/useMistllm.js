import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { getMistllmConsumer } from '../services/mistllm';

/**
 * Hook wrapping the shared MistllmConsumer singleton for a single component's
 * lifecycle. Guards against stale connects the same way useSync.js does: a
 * ref-based session token so an older connect's late callbacks can't clobber
 * a newer session's state.
 *
 * status is one of 'idle' | 'joining' | 'searching' | 'connected' | 'error'.
 */
export function useMistllm() {
    const consumer = getMistllmConsumer();
    const [state, setState] = useState(consumer.getState());
    const sessionRef = useRef(0);

    useEffect(() => {
        const unsubscribe = consumer.subscribe(setState);
        return unsubscribe;
    }, [consumer]);

    const connect = useCallback(async (roomId) => {
        sessionRef.current += 1;
        const sessionId = sessionRef.current;
        try {
            await consumer.connect(roomId);
        } catch (err) {
            if (sessionId !== sessionRef.current) return;
            throw err;
        }
    }, [consumer]);

    const disconnect = useCallback(() => {
        sessionRef.current += 1;
        consumer.disconnect();
    }, [consumer]);

    const chat = useCallback((messages, options = {}) => {
        return consumer.chat(messages, options);
    }, [consumer]);

    useEffect(() => {
        return () => {
            // The consumer is a shared singleton (ai.js chatAiViaMistllm and the
            // eager useNetworkConsumerConnection hook use it too), so do NOT
            // disconnect on unmount — just stop reacting to it. Disconnecting
            // happens only via explicit user action or the eager-connect hook.
            sessionRef.current += 1;
        };
    }, [consumer]);

    return {
        status: state.status,
        providerId: state.providerId,
        providerCount: state.providerCount,
        providerModels: state.providerModels,
        errorMessage: state.errorMessage,
        errorCode: state.errorCode,
        updatedAt: state.updatedAt,
        roomId: state.roomId,
        connect,
        disconnect,
        chat,
    };
}
