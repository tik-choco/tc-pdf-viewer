import test from 'node:test';
import assert from 'node:assert/strict';
import { getAiSettings, AI_SETTINGS_KEY, saveAiSettings } from '../src/services/aiSettings.js';
import { LLM_CONFIG_KEY, resolveModel, loadLlmConfig } from '@tik-choco/mistai/llm-config';

globalThis.window = new EventTarget();
globalThis.CustomEvent ??= class extends Event {
    constructor(name, options) { super(name); this.detail = options?.detail; }
};
const values = new Map();
let writes = 0;
globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { writes++; values.set(key, value); },
    removeItem: key => values.delete(key),
};

test('legacy task ids and room sharing migrate once, preserving shared legacy data and task effort', () => {
    values.clear();
    const config = {
        v: 1, updatedAt: '', network: { roomId: 'team' }, defaultPresetId: 'main',
        providers: [
            { id: 'http', label: 'Endpoint', baseUrl: 'https://endpoint.test/v1', apiKey: '', models: Array.from({ length: 300 }, (_, i) => `model-${i}`) },
            { id: 'disabled', label: 'Disabled', baseUrl: 'https://disabled.test/v1', apiKey: '', enabled: false },
            { id: 'room', label: 'Room', baseUrl: 'mist-network://team', apiKey: '' },
        ],
        presets: [
            { id: 'main', label: 'Old label', providerId: 'http', model: 'model-42', temperature: 0.7, reasoningEffort: 'high' },
            { id: 'off', label: 'Off', providerId: 'disabled', model: 'off-model' },
            { id: 'mirror', label: 'Mirror', providerId: 'room', model: 'remote-model' },
        ],
    };
    values.set(LLM_CONFIG_KEY, JSON.stringify(config));
    values.set(AI_SETTINGS_KEY, JSON.stringify({ taskPresetIds: { chat: 'main', ocr: 'off', explain: 'mirror', translate: 'main' }, taskReasoningEfforts: { translate: 'xhigh' }, networkProviderEnabled: true, networkProviderPresetIds: ['main', 'mirror'] }));
    const settings = getAiSettings();
    assert.deepEqual(settings.tasks.chat, { ref: { providerId: 'http', model: 'model-42' }, reasoningEffort: 'high' });
    assert.equal(settings.tasks.translate.reasoningEffort, 'xhigh');
    assert.equal(settings.tasks.explain.ref, undefined);
    assert.deepEqual(settings.tasks.ocr.ref, { providerId: 'disabled', model: 'off-model' });
    assert.deepEqual(settings.roomProvide.room, { enabled: true, shared: [{ providerId: 'http', model: 'model-42' }] });
    const migrated = loadLlmConfig();
    assert.deepEqual(migrated.presets, config.presets);
    assert.equal(migrated.defaultPresetId, config.defaultPresetId);
    assert.deepEqual(migrated.network, config.network);
    assert.equal(migrated.providers[0].models.length, 300);
    assert.equal(resolveModel(migrated, settings.tasks.ocr.ref).model, 'model-42');
    const savedLocal = values.get(AI_SETTINGS_KEY), savedShared = values.get(LLM_CONFIG_KEY), afterMigration = writes;
    getAiSettings();
    getAiSettings();
    assert.equal(writes, afterMigration);
    assert.equal(values.get(AI_SETTINGS_KEY), savedLocal);
    assert.equal(values.get(LLM_CONFIG_KEY), savedShared);
    saveAiSettings({ ...settings, tasks: { ...settings.tasks, chat: { reasoningEffort: 'max', ref: { providerId: 'gone', model: 'keep-me' } } } });
    assert.deepEqual(getAiSettings().tasks.chat.ref, { providerId: 'gone', model: 'keep-me' });
});

test('endpoint-era settings import directly into refs without writing legacy shared fields', () => {
    values.clear();
    values.set('ai_settings', JSON.stringify({ baseUrl: 'https://old.test/v1', model: 'chosen-model', modelReasoningEfforts: { chat: 'medium' }, mistllmRoomId: 'old-team', networkProviderEnabled: true }));
    const settings = getAiSettings();
    const shared = loadLlmConfig();
    assert.equal(settings.tasks.chat.ref.model, 'chosen-model');
    assert.equal(settings.tasks.chat.reasoningEffort, 'medium');
    assert.equal(shared.presets.length, 0);
    assert.equal(shared.defaultPresetId, '');
    assert.equal(shared.network.roomId, '');
    assert.equal(shared.providers.length, 2);
    assert.equal(shared.defaultModel.model, 'chosen-model');
    assert.equal(values.has('ai_settings'), false);
    const afterMigration = writes;
    getAiSettings();
    assert.equal(writes, afterMigration);
});
