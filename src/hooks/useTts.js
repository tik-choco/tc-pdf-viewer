import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { subscribeLlmConfig } from '../services/llmConfig';
import {
    getTtsSettings,
    guessSpeechLang,
    isBrowserTtsSupported,
    pickBrowserVoice,
    synthesizeSpeech,
} from '../services/tts';

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
            audioRef.current?.pause();
            if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        };
    }, []);

    const stop = useCallback(() => {
        generationRef.current += 1;
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
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = lang;
        const voice = pickBrowserVoice(lang);
        if (voice) utterance.voice = voice;
        if (typeof speed === 'number' && Number.isFinite(speed)) utterance.rate = speed;
        utterance.onend = () => setSpeakingId((current) => (current === id ? null : current));
        utterance.onerror = () => setSpeakingId((current) => (current === id ? null : current));

        window.speechSynthesis.speak(utterance);
        setSpeakingId(id);
    }, []);

    const speak = useCallback(
        (text, id) => {
            const input = (text || '').trim();
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
            setLoadingId(id);

            void (async () => {
                try {
                    const blob = await synthesizeSpeech(input, { settings: current });
                    if (generation !== generationRef.current) return; // superseded by stop()/another speak()

                    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
                    const url = URL.createObjectURL(blob);
                    objectUrlRef.current = url;

                    const audio = new Audio(url);
                    audioRef.current = audio;
                    audio.onended = () => setSpeakingId((c) => (c === id ? null : c));
                    audio.onerror = () => setSpeakingId((c) => (c === id ? null : c));
                    if (typeof current.speed === 'number' && Number.isFinite(current.speed)) {
                        audio.playbackRate = current.speed;
                    }

                    setLoadingId(null);
                    setSpeakingId(id);
                    await audio.play();
                } catch (err) {
                    if (generation !== generationRef.current) return; // superseded; don't resurrect the error
                    setLoadingId(null);
                    if (browserSupported) {
                        // The detail is worth showing (a room with no "tts"
                        // provider and an endpoint that rejected the request
                        // look identical otherwise), but sound still comes out.
                        console.warn('[useTts] synthesis failed; falling back to the browser voice.', err);
                        setError(`音声合成に失敗したためブラウザ音声で再生します。（${err?.message || err}）`);
                        speakWithBrowser(input, id, current.speed);
                        return;
                    }
                    setError(err?.message || '音声の再生に失敗しました。');
                    setSpeakingId(null);
                }
            })();
        },
        [browserSupported, loadingId, speakWithBrowser, speakingId, stop],
    );

    return { supported, engine: settings.engine, speakingId, loadingId, error, speak, stop };
}
