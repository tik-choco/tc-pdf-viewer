import { useMemo, useState } from 'preact/hooks';
import { Check, Copy, Download, Edit3, Eye, FileText, Languages, RefreshCw, Save } from 'lucide-preact';
import { Marked } from 'marked';

const marked = new Marked();

export default function MarkdownViewer({
    fileName,
    markdown,
    onChange,
    status,
    error,
    isRunning,
    hasPdf,
    onRunOcr,
    onSave,
    onCopy,
    onDownload,
    translatedMarkdown = '',
    translationStatus = '',
    translationError = '',
    isTranslating = false,
    targetLanguage = '日本語',
    targetLanguages = ['日本語', 'English'],
    onTranslate,
}) {
    const [mode, setMode] = useState('preview');
    const [selectedLanguage, setSelectedLanguage] = useState(targetLanguage);
    const html = useMemo(() => marked.parse(markdown || ''), [markdown]);
    const translatedHtml = useMemo(() => marked.parse(translatedMarkdown || ''), [translatedMarkdown]);
    const busy = isRunning || isTranslating;

    const handleTranslate = () => {
        setMode('compare');
        onTranslate?.(selectedLanguage);
    };

    const handleRegenerateTranslation = () => {
        setMode('compare');
        onTranslate?.(selectedLanguage, { force: true });
    };

    return (
        <div className="markdown-viewer-container">
            <div className="viewer-toolbar markdown-toolbar">
                <div className="toolbar-left markdown-title">
                    <FileText size={16} />
                    <span>{fileName ? fileName.replace(/\.pdf$/i, '.md') : 'Markdown'}</span>
                </div>

                <div className="markdown-toolbar-actions">
                    <div className="segmented-control">
                        <button
                            className={mode === 'preview' ? 'active' : ''}
                            onClick={() => setMode('preview')}
                            title="Preview"
                        >
                            <Eye size={15} />
                        </button>
                        <button
                            className={mode === 'source' ? 'active' : ''}
                            onClick={() => setMode('source')}
                            title="Source"
                        >
                            <Edit3 size={15} />
                        </button>
                        <button
                            className={mode === 'compare' ? 'active' : ''}
                            onClick={() => setMode('compare')}
                            title="Original and translation"
                        >
                            <Languages size={15} />
                        </button>
                    </div>

                    <select
                        className="markdown-language-select"
                        value={selectedLanguage}
                        onChange={e => setSelectedLanguage(e.target.value)}
                        disabled={!markdown || busy}
                        title="Translation language"
                    >
                        {targetLanguages.map(lang => (
                            <option key={lang} value={lang}>{lang}</option>
                        ))}
                    </select>
                    <button className="toolbar-text-btn" onClick={handleTranslate} disabled={!markdown || busy} title="Translate Markdown">
                        {isTranslating ? <RefreshCw size={15} className="spinning" /> : <Languages size={15} />}
                        Translate
                    </button>
                    <button
                        className="toolbar-btn"
                        onClick={handleRegenerateTranslation}
                        disabled={!markdown || !translatedMarkdown || busy}
                        title="Regenerate translation"
                    >
                        <RefreshCw size={15} />
                    </button>

                    <button className="toolbar-btn" onClick={onRunOcr} disabled={!hasPdf || busy} title="Re-run OCR">
                        <RefreshCw size={15} className={isRunning ? 'spinning' : ''} />
                    </button>
                    <button className="toolbar-btn" onClick={onSave} disabled={!markdown || busy} title="Save">
                        <Save size={15} />
                    </button>
                    <button className="toolbar-btn" onClick={onCopy} disabled={!markdown || busy} title="Copy">
                        <Copy size={15} />
                    </button>
                    <button className="toolbar-btn" onClick={onDownload} disabled={!markdown || busy} title="Download">
                        <Download size={15} />
                    </button>
                </div>
            </div>

            <div className="markdown-status-bar">
                <span className={error || translationError ? 'error' : ''}>
                    {error || translationError || translationStatus || status || (markdown ? 'Ready' : 'No Markdown yet')}
                </span>
                {markdown && !error && !translationError && <Check size={14} />}
            </div>

            <div className="markdown-viewer-body">
                {mode === 'source' ? (
                    <textarea
                        className="markdown-source-editor"
                        value={markdown}
                        onInput={e => onChange(e.target.value)}
                        placeholder={isRunning ? 'Generating OCR Markdown...' : 'Markdown will appear here after OCR.'}
                        readOnly={busy}
                    />
                ) : mode === 'compare' && markdown ? (
                    <div className="markdown-compare">
                        <section className="markdown-compare-pane">
                            <div className="markdown-compare-heading">Original</div>
                            <div
                                className="markdown-document markdown-body"
                                dangerouslySetInnerHTML={{ __html: html }}
                            />
                        </section>
                        <section className="markdown-compare-pane">
                            <div className="markdown-compare-heading">Translation</div>
                            {translatedMarkdown ? (
                                <div
                                    className="markdown-document markdown-body"
                                    dangerouslySetInnerHTML={{ __html: translatedHtml }}
                                />
                            ) : (
                                <div className="markdown-empty-state compact">
                                    <Languages size={30} />
                                    <p>{isTranslating ? 'Translating Markdown...' : 'Translate to show the translated Markdown here.'}</p>
                                    <button className="primary" onClick={handleTranslate} disabled={!markdown || busy}>
                                        {isTranslating ? <RefreshCw size={16} className="spinning" /> : <Languages size={16} />}
                                        Translate
                                    </button>
                                </div>
                            )}
                        </section>
                    </div>
                ) : markdown ? (
                    <div
                        className="markdown-document markdown-body"
                        dangerouslySetInnerHTML={{ __html: html }}
                    />
                ) : (
                    <div className="markdown-empty-state">
                        <FileText size={36} />
                        <p>{isRunning ? 'Generating OCR Markdown...' : 'Run OCR to create Markdown for this PDF.'}</p>
                        <button className="primary" onClick={onRunOcr} disabled={!hasPdf || isRunning}>
                            <RefreshCw size={16} className={isRunning ? 'spinning' : ''} />
                            OCR Markdown
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
