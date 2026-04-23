import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Check, Columns2, Copy, Download, Edit3, Eye, FileText, Languages, RefreshCw, Save, Type, ZoomIn, ZoomOut } from 'lucide-preact';
import { renderMarkdown } from '../utils/markdown';

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
    const [fontScale, setFontScale] = useState(100);
    const [selectedLanguage, setSelectedLanguage] = useState(targetLanguage);
    const bodyRef = useRef(null);
    const html = useMemo(() => renderMarkdown(markdown), [markdown]);
    const translatedHtml = useMemo(() => renderMarkdown(translatedMarkdown), [translatedMarkdown]);
    const busy = isRunning || isTranslating;
    const viewerStyle = {
        '--markdown-document-font-size': `${0.95 * (fontScale / 100)}rem`,
        '--markdown-editor-font-size': `${0.88 * (fontScale / 100)}rem`,
        '--markdown-table-font-size': `${0.75 * (fontScale / 100)}rem`,
    };
    const documentStyle = { fontSize: `${0.95 * (fontScale / 100)}rem` };
    const editorStyle = { fontSize: `${0.88 * (fontScale / 100)}rem` };

    const changeFontScale = (delta) => {
        setFontScale(current => Math.min(180, Math.max(70, current + delta)));
    };

    useEffect(() => {
        const body = bodyRef.current;
        if (!body) return;

        const handleWheel = (event) => {
            if (!event.ctrlKey || !body.contains(document.activeElement)) return;
            event.preventDefault();
            setFontScale(current => {
                const delta = event.deltaY < 0 ? 10 : -10;
                return Math.min(180, Math.max(70, current + delta));
            });
        };

        body.addEventListener('wheel', handleWheel, { passive: false });
        return () => body.removeEventListener('wheel', handleWheel);
    }, []);

    const handleBodyMouseDown = (event) => {
        if (event.target.closest('a, button, input, select, textarea')) return;
        bodyRef.current?.focus({ preventScroll: true });
    };

    const handleTranslate = () => {
        setMode('translation');
        onTranslate?.(selectedLanguage);
    };

    const handleRegenerateTranslation = () => {
        setMode('translation');
        onTranslate?.(selectedLanguage, { force: true });
    };

    return (
        <div className="markdown-viewer-container" style={viewerStyle}>
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
                            className={mode === 'translation' ? 'active' : ''}
                            onClick={() => setMode('translation')}
                            title="Translation"
                            disabled={!markdown}
                        >
                            <Languages size={15} />
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
                            <Columns2 size={15} />
                        </button>
                    </div>

                    <div className="markdown-zoom-controls" title="Markdown text size">
                        <Type size={14} />
                        <button
                            className="toolbar-btn"
                            onClick={() => changeFontScale(-10)}
                            disabled={fontScale <= 70}
                            title="Smaller text"
                        >
                            <ZoomOut size={14} />
                        </button>
                        <button
                            className="markdown-zoom-value"
                            onClick={() => setFontScale(100)}
                            title="Reset text size"
                        >
                            {fontScale}%
                        </button>
                        <button
                            className="toolbar-btn"
                            onClick={() => changeFontScale(10)}
                            disabled={fontScale >= 180}
                            title="Larger text"
                        >
                            <ZoomIn size={14} />
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

            <div
                ref={bodyRef}
                className="markdown-viewer-body"
                tabIndex={0}
                onMouseDown={handleBodyMouseDown}
            >
                {mode === 'source' ? (
                    <textarea
                        className="markdown-source-editor"
                        style={editorStyle}
                        value={markdown}
                        onInput={e => onChange(e.target.value)}
                        placeholder={isRunning ? 'Generating OCR Markdown...' : 'Markdown will appear here after OCR.'}
                        readOnly={busy}
                    />
                ) : mode === 'translation' && markdown ? (
                    translatedMarkdown ? (
                        <div
                            className="markdown-document markdown-body"
                            style={documentStyle}
                            dangerouslySetInnerHTML={{ __html: translatedHtml }}
                        />
                    ) : (
                        <div className="markdown-empty-state">
                            <Languages size={36} />
                            <p>{isTranslating ? 'Translating Markdown...' : 'Translate to show the translated Markdown here.'}</p>
                            <button className="primary" onClick={handleTranslate} disabled={!markdown || busy}>
                                {isTranslating ? <RefreshCw size={16} className="spinning" /> : <Languages size={16} />}
                                Translate
                            </button>
                        </div>
                    )
                ) : mode === 'compare' && markdown ? (
                    <div className="markdown-compare">
                        <section className="markdown-compare-pane">
                            <div className="markdown-compare-heading">Original</div>
                            <div
                                className="markdown-document markdown-body"
                                style={documentStyle}
                                dangerouslySetInnerHTML={{ __html: html }}
                            />
                        </section>
                        <section className="markdown-compare-pane">
                            <div className="markdown-compare-heading">Translation</div>
                            {translatedMarkdown ? (
                                <div
                                    className="markdown-document markdown-body"
                                    style={documentStyle}
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
                        style={documentStyle}
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
