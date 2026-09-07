import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { subscribeLlmConfig } from '../services/llmConfig';
import {
    SPEECH_CHUNK_CHARS,
    SPEECH_CHUNK_MIN_CHARS,
    SPEECH_FIRST_CHUNK_CHARS,
    getTtsSettings,
    guessSpeechLang,
    isBrowserTtsSupported,
    normalizeSpeechText,
    pickBrowserVoice,
    splitTextForSpeech,
    synthesizeSpeech,
} from '../services/tts';

/**
 * How many chunks are kept in flight ahead of the one that is playing. Two is
 * enough to hide a typical synthesis round trip behind ~140 characters of
 * audio without hammering the provider for a text the user may stop after the
 * first sentence.
 */
const SYNTHESIS_LOOKAHEAD = 2;

/**
 * Playback state machine for the selection TTS, ported from tc-translate's
 * src/hooks/useSpeech.ts.
 *
 * Callers identify an utterance by an arbitrary `id` (the tooltip uses
 * 'selection' / 'result'), so the same hook can drive several buttons and
 * each one knows whether IT is the thing currently loading or speaking.
 * Calling speak() with the id that's already playing toggles it off.
 *
 * API/AI Network synthesis falls back to the browser voice on any failure:
 * the point of the feature is hearing the word, so a misconfigured endpoint
 * should still produce sound rather than nothing.
 */
export function useTts() {
    const [settings, setSettings] = useState(() => getTtsSettings());
    const [speakingId, setSpeakingId] = useState(null);
    const [loadingId, setLoadingId] = useState(null);
    const [error, setError] = useState('');

    const audioRef = useRef(null);
    const objectUrlRef = useRef(null);
    // Bumped on every stop()/speak() so a slow (network) synthesis that
    // resolves after the user moved on can't resurrect playback they already
    // dismissed.
    const generationRef = useRef(0);
    // Aborts the in-flight chunk syntheses of the current utterance (the API
    // route honours it; the network route is covered by generationRef).
    const abortRef = useRef(null);

    const browserSupported = isBrowserTtsSupported();
    const supported = browserSupported || settings.engine !== 'browser';

    useEffect(() => {
        // The shared llm config is co-owned by every tik-choco app on this
        // origin, so the engine can change under us from another tab.
        const refresh = () => setSettings(getTtsSettings());
        refresh();
        const unsubscribe = subscribeLlmConfig(refresh);
        return unsubscribe;
    }, []);

    useEffect(() => {
        // Chromium populates the voice list asynchronously; touching it once
        // (and again on 'voiceschanged') means pickBrowserVoice has something
        // to match against by the time the user clicks.
        if (!browserSupported) return;
        const warm = () => window.speechSynthesis.getVoices();
        warm();
        window.speechSynthesis.addEventListener?.('voiceschanged', warm);
        return () => window.speechSynthesis.removeEventListener?.('voiceschanged', warm);
    }, [browserSupported]);

    useEffect(() => {
        return () => {
            if (isBrowserTtsSupported()) window.speechSynthesis.cancel();
            abortRef.current?.abort();
            audioRef.current?.pause();
            if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        };
    }, []);

    const stop = useCallback(() => {
        generationRef.current += 1;
        abortRef.current?.abort();
        abortRef.current = null;
        if (isBrowserTtsSupported()) window.speechSynthesis.cancel();
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
        }
        setSpeakingId(null);
        setLoadingId(null);
    }, []);

    const speakWithBrowser = useCallback((text, id, speed) => {
        if (!isBrowserTtsSupported()) return;
        window.speechSynthesis.cancel();

        const lang = guessSpeechLang(text);
        const voice = pickBrowserVoice(lang);
        // Chrome silently drops a long utterance partway through, so a long
        // text goes in as a queue of sentence-sized utterances; only the last
        // one clears the speaking state.
        const chunks = text.length > SPEECH_CHUNK_MIN_CHARS ? splitTextForSpeech(text) : [text];

        chunks.forEach((chunk, index) => {
            const utterance = new SpeechSynthesisUtterance(chunk);
            utterance.lang = lang;
            if (voice) utterance.voice = voice;
            if (typeof speed === 'number' && Number.isFinite(speed)) utterance.rate = speed;
            if (index === chunks.length - 1) {
                utterance.onend = () => setSpeakingId((current) => (current === id ? null : current));
            }
            utterance.onerror = () => setSpeakingId((current) => (current === id ? null : current));
            window.speechSynthesis.speak(utterance);
        });

        setSpeakingId(id);
    }, []);

    /**
     * Plays one synthesized chunk, resolving when it finishes (or when the
     * utterance it belongs to has been superseded).
     */
    const playBlob = useCallback((blob, speed, generation) => {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(blob);
            if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = url;

            const audio = new Audio(url);
            audioRef.current = audio;
            if (typeof speed === 'number' && Number.isFinite(speed)) audio.playbackRate = speed;
            audio.onended = () => resolve();
            // stop() pauses the current chunk; resolving here lets the queue
            // loop wake up and bail out on its generation check instead of
            // staying suspended forever. A pause that isn't a stop (the OS
            // taking audio focus, say) must NOT advance the queue.
            audio.onpause = () => {
                if (generation !== generationRef.current) resolve();
            };
            audio.onerror = () => reject(new Error('音声の再生に失敗しました。'));
            audio.play().catch(reject);
        });
    }, []);

    const speak = useCallback(
        (text, id) => {
            // Selections come out of a PDF hard-wrapped wherever the column
            // ended, so the line breaks are un-wrapped before anything else:
            // a newline inside a sentence is read as a full stop by every
            // engine here, chunked or not.
            const input = normalizeSpeechText(text).trim();
            if (!input) return;

            if (speakingId === id || loadingId === id) {
                stop();
                return;
            }
            stop();

            const current = getTtsSettings();
            setSettings(current);
            setError('');

            if (current.engine === 'browser') {
                if (!browserSupported) {
                    setError('このブラウザは音声読み上げに対応していません。');
                    return;
                }
                speakWithBrowser(input, id, current.speed);
                return;
            }

            const generation = generationRef.current;
            const controller = new AbortController();
            abortRef.current = controller;
            setLoadingId(id);

            // A long text is synthesized chunk by chunk with a small
            // look-ahead: the first sentence starts playing while the rest is
            // still being generated, so the wait before any sound is the cost
            // of ~140 characters rather than of the whole passage.
            const chunks =
                input.length > SPEECH_CHUNK_MIN_CHARS
                    ? splitTextForSpeech(input, SPEECH_CHUNK_CHARS, SPEECH_FIRST_CHUNK_CHARS)
                    : [input];

            void (async () => {
                const pending = new Map();
                const synthesize = (index) => {
                    if (index >= chunks.length) return undefined;
                    if (!pending.has(index)) {
                        const request = synthesizeSpeech(chunks[index], {
                            settings: current,
                            signal: controller.signal,
                        });
                        // A look-ahead request can reject long before its turn
                        // comes (or never be awaited at all after a stop());
                        // this keeps that from surfacing as an unhandled
                        // rejection. The error is still thrown at its `await`.
                        request.catch(() => {});
                        pending.set(index, request);
                    }
                    return pending.get(index);
                };

                for (let i = 0; i < SYNTHESIS_LOOKAHEAD; i += 1) synthesize(i);

                for (let index = 0; index < chunks.length; index += 1) {
                    let blob;
                    try {
                        blob = await synthesize(index);
                    } catch (err) {
                        if (generation !== generationRef.current) return; // superseded; don't resurrect the error
                        setLoadingId(null);
                        const remaining = chunks.slice(index).join(' ');
                        if (browserSupported) {
                            // The detail is worth showing (a room with no "tts"
                            // provider and an endpoint that rejected the request
                            // look identical otherwise), but sound still comes out.
                            console.warn('[useTts] synthesis failed; falling back to the browser voice.', err);
                            setError(`音声合成に失敗したためブラウザ音声で再生します。（${err?.message || err}）`);
                            speakWithBrowser(remaining, id, current.speed);
                            return;
                        }
                        setError(err?.message || '音声の再生に失敗しました。');
                        setSpeakingId(null);
                        return;
                    }
                    if (generation !== generationRef.current) return; // superseded by stop()/another speak()

                    pending.delete(index);
                    // Keep the pipeline primed before blocking on playback.
                    for (let ahead = 1; ahead <= SYNTHESIS_LOOKAHEAD; ahead += 1) synthesize(index + ahead);

                    if (index === 0) {
                        setLoadingId(null);
                        setSpeakingId(id);
                    }

                    try {
                        await playBlob(blob, current.speed, generation);
                    } catch (err) {
                        if (generation !== generationRef.current) return;
                        console.warn('[useTts] playback failed.', err);
                        setError(err?.message || '音声の再生に失敗しました。');
                        setSpeakingId((c) => (c === id ? null : c));
                        return;
                    }
                    if (generation !== generationRef.current) return;
                }

                setSpeakingId((c) => (c === id ? null : c));
            })();
        },
        [browserSupported, loadingId, playBlob, speakWithBrowser, speakingId, stop],
    );

    return { supported, engine: settings.engine, speakingId, loadingId, error, speak, stop };
}
