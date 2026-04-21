import { useMemo, useState } from 'preact/hooks';
import { Check, Copy, Download, Edit3, Eye, FileText, RefreshCw, Save } from 'lucide-preact';
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
}) {
    const [mode, setMode] = useState('preview');
    const html = useMemo(() => marked.parse(markdown || ''), [markdown]);

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
                    </div>

                    <button className="toolbar-btn" onClick={onRunOcr} disabled={!hasPdf || isRunning} title="Re-run OCR">
                        <RefreshCw size={15} className={isRunning ? 'spinning' : ''} />
                    </button>
                    <button className="toolbar-btn" onClick={onSave} disabled={!markdown || isRunning} title="Save">
                        <Save size={15} />
                    </button>
                    <button className="toolbar-btn" onClick={onCopy} disabled={!markdown || isRunning} title="Copy">
                        <Copy size={15} />
                    </button>
                    <button className="toolbar-btn" onClick={onDownload} disabled={!markdown || isRunning} title="Download">
                        <Download size={15} />
                    </button>
                </div>
            </div>

            <div className="markdown-status-bar">
                <span className={error ? 'error' : ''}>
                    {error || status || (markdown ? 'Ready' : 'No Markdown yet')}
                </span>
                {markdown && !error && <Check size={14} />}
            </div>

            <div className="markdown-viewer-body">
                {mode === 'source' ? (
                    <textarea
                        className="markdown-source-editor"
                        value={markdown}
                        onInput={e => onChange(e.target.value)}
                        placeholder={isRunning ? 'Generating OCR Markdown...' : 'Markdown will appear here after OCR.'}
                        readOnly={isRunning}
                    />
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
