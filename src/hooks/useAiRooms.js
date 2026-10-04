import { useEffect, useState } from 'preact/hooks';
import { useLlmConfig, useRoomProviders } from '@tik-choco/mistai/preact';
import { getAiSettings, subscribeAiSettings } from '../services/aiSettings.js';
import { rooms } from '../services/mistllm.js';

// Keep this mounted in the shell, independent of settings and onboarding.
export function useAiRooms() {
    const { config } = useLlmConfig();
    const [local, setLocal] = useState(getAiSettings);
    const [settingsOpen, setSettingsOpen] = useState(false);
    useEffect(() => subscribeAiSettings(() => setLocal(getAiSettings())), []);
    useEffect(() => {
        const onOpen = event => setSettingsOpen(event.detail);
        window.addEventListener('pdf-viewer-ai-settings-open', onOpen);
        return () => window.removeEventListener('pdf-viewer-ai-settings-open', onOpen);
    }, []);
    useRoomProviders({
        config, roomProvide: local.roomProvide, consumers: rooms,
        taskRefs: Object.values(local.tasks).map(task => task.ref), settingsOpen,
        reasoningEffort: local.tasks.chat.reasoningEffort,
    });
}
