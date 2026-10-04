import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import * as mistai from '@tik-choco/mistai';
import * as llmConfig from '@tik-choco/mistai/llm-config';
import * as settings from '../src/services/aiSettings.js';
import * as i18n from '../src/i18n/ai.js';

// Run with: node --experimental-vm-modules --test scripts/*.test.mjs
// Link the app module with an in-memory room transport instead of browser WASM.
globalThis.window = new EventTarget();
globalThis.CustomEvent ??= class extends Event {
    constructor(name, options) { super(name); this.detail = options?.detail; }
};
const values = new Map();
globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
};

const source = await readFile(new URL('../src/services/ai.js', import.meta.url), 'utf8');

async function loadAi(rooms, baseUrl = 'mist-network://team') {
    values.clear();
    const config = llmConfig.emptyLlmConfig();
    config.providers = [{ id: 'chosen', label: 'Chosen', baseUrl, apiKey: 'test-key' }];
    config.defaultModel = { providerId: 'chosen', model: 'test-model' };
    values.set(llmConfig.LLM_CONFIG_KEY, JSON.stringify(config));
    values.set(settings.AI_SETTINGS_KEY, JSON.stringify({
        tasks: Object.fromEntries(Object.entries({ chat: 'none', explain: 'high', translate: 'xhigh', ocr: 'max' })
            .map(([task, reasoningEffort]) => [task, { ref: config.defaultModel, reasoningEffort }])),
    }));
    const imports = {
        '@tik-choco/mistai': mistai,
        '@tik-choco/mistai/llm-config': llmConfig,
        './storage': { getExplanation: async () => null, saveExplanation: async () => {} },
        './mistllm': { rooms },
        '../i18n/ai.js': i18n,
        './aiSettings': settings,
    };
    const module = new SourceTextModule(source);
    await module.link(specifier => {
        const exports = imports[specifier];
        assert.ok(exports, `Unexpected import: ${specifier}`);
        return new SyntheticModule(Object.keys(exports), function () {
            for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        });
    });
    await module.evaluate();
    return module.namespace;
}

for (const [task, effort] of Object.entries({ chat: 'none', explain: 'high', translate: 'xhigh', ocr: 'max' })) {
    test(`room ${task} sends task effort on llm_request and streams before completion`, async t => {
        const requests = [];
        const calls = [];
        const upstreamEfforts = [];
        let release;
        const pending = new Promise(resolve => { release = resolve; });
        let firstDelta;
        const streaming = new Promise(resolve => { firstDelta = resolve; });
        const provider = new mistai.ProviderService((_to, message) => consumer.handleMessage(message),
            async (_messages, _model, onDelta, reasoningEffort) => {
                upstreamEfforts.push(reasoningEffort);
                onDelta('Hello ');
                await pending;
                onDelta('world');
                return 'Hello world';
            }, { reasoningEffort: 'low' });
        const consumer = new mistai.ConsumerService((_to, message) => {
            requests.push(message);
            void provider.handleMessage('consumer', message);
        });
        // Exercise mistai's actual scoped requestRoomChat and wire serializer.
        const rooms = mistai.createRoomConsumers(() => { throw new Error('Unexpected real transport'); });
        rooms.roomConsumer = roomId => ({ requestChat: (room, messages, options) => {
            calls.push({ roomId, room, messages, options });
            return consumer.request('provider', messages, options);
        } });
        rooms.requestRoomOpenAi = () => { throw new Error('Text chat must not use the tunnel'); };
        const ai = await loadAi(rooms);
        const messages = [{ role: 'user', content: 'Hello' }];
        const deltas = [];
        let completed = false;
        t.after(() => release());
        const answer = ai.chatAi(messages, task, { onDelta: (delta, full) => {
            deltas.push([delta, full]);
            firstDelta();
        } }).then(value => { completed = true; return value; });
        await streaming;
        assert.equal(completed, false);
        assert.deepEqual(deltas, [['Hello ', 'Hello ']]);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].roomId, 'team');
        assert.equal(calls[0].room, 'team');
        assert.deepEqual(calls[0].messages, messages);
        assert.equal(calls[0].options.model, 'test-model');
        assert.equal(calls[0].options.reasoningEffort, effort);
        assert.equal(typeof calls[0].options.onDelta, 'function');
        assert.equal(requests[0].type, 'llm_request');
        assert.equal(requests[0].reasoning_effort, effort);
        assert.equal('temperature' in requests[0], false);
        assert.deepEqual(upstreamEfforts, [effort]);
        release();
        assert.equal(await answer, 'Hello world');
        assert.deepEqual(deltas, [['Hello ', 'Hello '], ['world', 'Hello world']]);
    });
}

test('text content parts use room chat without a UI delta callback', async () => {
    const ai = await loadAi({
        requestRoomChat: async (room, messages, options) => {
            assert.equal(room, 'team');
            assert.deepEqual(messages, [{ role: 'user', content: 'One\nTwo' }]);
            assert.equal(options.reasoningEffort, 'xhigh');
            assert.equal(options.onDelta, undefined);
            return ' translated ';
        },
        requestRoomOpenAi: () => { throw new Error('Text parts must not use the tunnel'); },
    });
    assert.equal(await ai.chatAi([{ role: 'user', content: [
        { type: 'text', text: 'One' }, { type: 'text', text: 'Two' },
    ] }], 'translate'), 'translated');
});

test('vision/OCR retains image parts and task effort through the OpenAI tunnel', async () => {
    const calls = [];
    const ai = await loadAi({
        requestRoomChat: () => { throw new Error('Images must use the tunnel'); },
        requestRoomOpenAi: async (room, request) => {
            calls.push({ room, request });
            return { status: 200, body: JSON.stringify({ choices: [{ message: { content: '# OCR' } }] }) };
        },
    });
    const dataUrl = 'data:image/png;base64,AAAA';
    assert.equal(await ai.ocrImagesToMarkdown([{ pageNumber: 1, dataUrl }]), '# OCR');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].room, 'team');
    assert.equal(calls[0].request.path, '/chat/completions');
    const body = JSON.parse(calls[0].request.body);
    assert.equal(body.model, 'test-model');
    assert.equal(body.reasoning_effort, 'max');
    assert.equal(body.stream, false);
    assert.equal('temperature' in body, false);
    assert.deepEqual(body.messages[0].content.at(-1), {
        type: 'image_url', image_url: { url: dataUrl, detail: 'high' },
    });
});

test('HTTP chat still sends reasoning_effort without temperature and streams deltas', async t => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push({ url, init });
        return new Response('data: {"choices":[{"delta":{"content":"HTTP answer"}}]}\n\ndata: [DONE]\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
        });
    });
    const ai = await loadAi({}, 'https://endpoint.test/v1');
    const deltas = [];
    assert.equal(await ai.chatAi([{ role: 'user', content: 'Hello' }], 'explain', {
        onDelta: (delta, full) => deltas.push([delta, full]),
    }), 'HTTP answer');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://endpoint.test/v1/chat/completions');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.reasoning_effort, 'high');
    assert.equal('temperature' in body, false);
    assert.deepEqual(deltas, [['HTTP answer', 'HTTP answer']]);
});

test('cancelled room chat rejects promptly and ignores later deltas', async t => {
    let finish;
    let onDelta;
    const ai = await loadAi({ requestRoomChat: (_room, _messages, options) => {
        onDelta = options.onDelta;
        return new Promise(resolve => { finish = resolve; });
    } });
    t.mock.method(console, 'error', () => {});
    const controller = new AbortController();
    const deltas = [];
    const answer = ai.chatAi([{ role: 'user', content: 'Hello' }], 'chat', {
        signal: controller.signal, onDelta: delta => deltas.push(delta),
    });
    controller.abort();
    await assert.rejects(answer, { name: 'AbortError' });
    onDelta('late', 'late');
    finish('late');
    assert.deepEqual(deltas, []);
});
