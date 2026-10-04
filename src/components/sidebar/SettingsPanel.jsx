import { useEffect, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { LlmSettings } from '@tik-choco/mistai/preact';
import { MistBuildBanner } from '../MistBuildBanner.jsx';
import { AI_TASKS, getAiSettings, llmLocalSettings, saveAiSettings, subscribeAiSettings } from '../../services/aiSettings.js';
import { requestOnboarding } from '../../services/onboarding';
import { aiMessages } from '../../i18n/ai.js';

export function SettingsPanel({ onClose, showGuide = true }) {
    const [local, setLocal] = useState(getAiSettings);
    useEffect(() => subscribeAiSettings(() => setLocal(getAiSettings())), []);
    useEffect(() => {
        window.dispatchEvent(new CustomEvent('pdf-viewer-ai-settings-open', { detail: true }));
        return () => window.dispatchEvent(new CustomEvent('pdf-viewer-ai-settings-open', { detail: false }));
    }, []);
    const messages = aiMessages(local.locale);
    const panel = <LlmSettings
        className="pdf-ai-settings"
        title={messages.settingsTitle}
        locale={local.locale}
        tasks={AI_TASKS.map(id => ({ id, label: messages[id], tip: messages[id + 'Tip'], reasoning: true }))}
        localSettings={llmLocalSettings}
        voice={{ tts: {} }}
        onClose={onClose}
        headerSection={<div className="pdf-ai-settings-tools">
            <label>{messages.language}
                <select value={local.locale} onChange={event => saveAiSettings({ ...getAiSettings(), locale: event.currentTarget.value })}>
                    <option value="ja">{ '日本語' }</option>
                    <option value="en">English</option>
                    <option value="zh-CN">{ '简体中文' }</option>
                    <option value="zh-TW">{ '繁體中文' }</option>
                </select>
            </label>
            {showGuide && <button type="button" onClick={() => { onClose?.(); requestOnboarding(); }}>{messages.guide}</button>}
        </div>}
        extraSections={<footer className="pdf-ai-settings-footer"><MistBuildBanner view="settings" /></footer>}
    />;
    return onClose ? createPortal(panel, document.body) : panel;
}
