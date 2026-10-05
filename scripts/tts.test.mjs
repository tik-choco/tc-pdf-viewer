import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import * as mistai from '@tik-choco/mistai';
import * as llmConfig from '@tik-choco/mistai/llm-config';

// Run with: node --experimental-vm-modules --test scripts/*.test.mjs
// Keep the browser WASM transport out of unit tests; exercise mistai's real room helper and wire services.
globalThis.window = new EventTarget();
const values = new Map();
globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
};

async function linkSource(url, imports) {
    const module = new SourceTextModule(await readFile(url, 'utf8'));
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

async function loadTts(baseUrl = 'https://speech.test/v1', speed = 1.4) {
    values.clear();
    const config = llmConfig.emptyLlmConfig();
    config.providers = [{ id: 'voice', label: 'Voice', baseUrl, apiKey: 'test-key', enabled: true }];
    config.defaultModel = { providerId: 'voice', model: 'chat-model' };
    config.tts = { providerId: 'voice', model: 'speech-model', voice: 'alloy', speed };
    values.set(llmConfig.LLM_CONFIG_KEY, JSON.stringify(config));
    const requests = [], upstream = [];
    const consumer = new mistai.VoiceConsumerService((_to, msg) => {
        requests.push(msg);
        void provider.handleMessage('consumer', msg);
    });
    const provider = new mistai.VoiceProviderService((_to, msg) => consumer.handleMessage(msg),
        async (_text, _model, _voice, _lang, options) => {
            upstream.push(options);
            return { blob: new Blob(['actual audio']), mime: 'audio/ogg' };
        }, async () => '');
    const rooms = mistai.createRoomConsumers(() => { throw new Error('Unexpected real transport'); });
    rooms.roomConsumer = room => ({ requestTts: (id, params) => {
        assert.equal(room, 'team');
        assert.equal(id, 'team');
        return consumer.requestTts('provider', params);
    } });
    const tts = await linkSource(new URL('../src/services/tts.js', import.meta.url), {
        '@tik-choco/mistai': mistai,
        '@tik-choco/mistai/llm-config': llmConfig,
        './mistllm': { rooms },
        './aiSettings': { getSharedLlmConfig: () => llmConfig.loadLlmConfig() },
    });
    return { tts, config, requests, upstream };
}

function mockSpeechApi(t) {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        return new Response('actual audio', { headers: { 'Content-Type': 'audio/ogg' } });
    });
    return calls;
}

test('direct HTTP TTS uses shared resolved speed once and omits an unrequested format', async t => {
    const calls = mockSpeechApi(t);
    const { tts } = await loadTts();
    const audio = await tts.synthesizeSpeech('Hello');
    assert.equal(calls[0].url, 'https://speech.test/v1/audio/speech');
    assert.equal(calls[0].body.speed, 1.4);
    assert.equal('response_format' in calls[0].body, false);
    assert.equal(audio.type, 'audio/ogg');
});

test('HTTP caller speed wins over shared speed; requested format never overrides actual MIME', async t => {
    const calls = mockSpeechApi(t);
    const { tts } = await loadTts();
    const audio = await tts.synthesizeSpeech('Hello', { speed: 0.75, responseFormat: 'wav' });
    assert.equal(calls[0].body.speed, 0.75);
    assert.equal(calls[0].body.response_format, 'wav');
    assert.equal(audio.type, 'audio/ogg');
});

test('room TTS uses mistai shared speed and forwards caller hints on the wire with real MIME', async () => {
    const { tts, requests, upstream } = await loadTts('mist-network://team');
    assert.equal((await tts.synthesizeSpeech('Hello')).type, 'audio/ogg');
    assert.equal(requests[0].type, 'tts_request');
    assert.equal(requests[0].speed, 1.4);
    assert.equal('response_format' in requests[0], false);
    const audio = await tts.synthesizeSpeech('Hello', { speed: 0.75, responseFormat: 'wav' });
    assert.equal(requests[1].speed, 0.75);
    assert.equal(requests[1].response_format, 'wav');
    assert.deepEqual(upstream[1], { speed: 0.75, responseFormat: 'wav' });
    assert.equal(audio.type, 'audio/ogg');
});

test('HTTP and room routes independently ignore invalid speed and format hints', async t => {
    const calls = mockSpeechApi(t);
    for (const baseUrl of ['https://speech.test/v1', 'mist-network://team']) {
        const { tts, requests } = await loadTts(baseUrl);
        for (const speed of [0.24, 4.01, NaN, Infinity, '2']) {
            await tts.synthesizeSpeech('Hello', { speed, responseFormat: 'wav' });
            const request = baseUrl.startsWith('https') ? calls.at(-1).body : requests.at(-1);
            assert.equal('speed' in request, false);
            assert.equal(request.response_format, 'wav');
        }
        await tts.synthesizeSpeech('Hello', { speed: 4, responseFormat: 'invalid' });
        const request = baseUrl.startsWith('https') ? calls.at(-1).body : requests.at(-1);
        assert.equal(request.speed, 4);
        assert.equal('response_format' in request, false);
    }
});

const hooks = {
    useCallback: fn => fn, useEffect: () => {}, useRef: value => ({ current: value }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
};
async function loadHook(tts) {
    return await linkSource(new URL('../src/hooks/useTts.js', import.meta.url), {
        'preact/hooks': hooks, '@tik-choco/mistai/llm-config': llmConfig, '../services/tts': tts,
    });
}

test('synthesized audio plays at native rate instead of applying shared speed a second time', async t => {
    mockSpeechApi(t);
    const { tts } = await loadTts();
    let played;
    const done = new Promise(resolve => { played = resolve; });
    const previousAudio = globalThis.Audio;
    globalThis.Audio = class {
        playbackRate = 1;
        play() { played(this); queueMicrotask(() => this.onended()); return Promise.resolve(); }
        pause() {}
    };
    t.after(() => { globalThis.Audio = previousAudio; });
    const { useTts } = await loadHook(tts);
    useTts().speak('Hello', 'selection');
    assert.equal((await done).playbackRate, 1);
});

test('browser voice retains shared speed in its utterance rate', async t => {
    const { tts, config } = await loadTts();
    config.tts.model = '';
    values.set(llmConfig.LLM_CONFIG_KEY, JSON.stringify(config));
    const utterances = [];
    const previousUtterance = globalThis.SpeechSynthesisUtterance;
    window.speechSynthesis = { cancel() {}, getVoices: () => [], speak: utterance => utterances.push(utterance) };
    globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    t.after(() => { delete window.speechSynthesis; globalThis.SpeechSynthesisUtterance = previousUtterance; });
    const { useTts } = await loadHook(tts);
    useTts().speak('Hello', 'selection');
    assert.equal(utterances[0].rate, 1.4);
});
