import { Download, Edit3, MoreVertical, Trash2 } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { loadPdf } from '../../services/storage';
import { renderMarkdown } from '../../utils/markdown';

function normalizeSummaryMarkdown(summary) {
    const lines = (summary || '').split('\n');
    const normalizedLines = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const nextLine = lines[i + 1] || '';
        const isTableHeader = line.trim().startsWith('|') && nextLine.trim().match(/^\|?[\s:-]+\|[\s|:-]*$/);

        if (!isTableHeader) {
            normalizedLines.push(line);
            i += 1;
            continue;
        }

        i += 2;
        while (i < lines.length && lines[i].trim().startsWith('|')) {
            const cells = lines[i]
                .trim()
                .replace(/^\|/, '')
                .replace(/\|$/, '')
                .split('|')
                .map((cell) => cell.trim())
                .filter(Boolean);

            if (cells.length >= 2) {
                normalizedLines.push(`**${cells[0].replace(/\*\*/g, '')}**`);
                normalizedLines.push(`<div class="summary-detail">${cells.slice(1).join(' ')}</div>`);
                normalizedLines.push('');
            }
            i += 1;
        }
    }

    return normalizedLines.join('\n').trim();
}

export function FileRow({
    file,
    isActive,
    isEditing,
    newName,
    activeMenu,
    menuRef,
    onSelect,
    onStartRename,
    onRenameInput,
    onCommitRename,
    onCancelRename,
    onDelete,
    onToggleMenu,
    onCloseMenu,
    onFileDrop,
    dragOver,
    dragging,
    onSetDragOver,
    onSetDragging,
    summary,
}) {
    const [summaryTop, setSummaryTop] = useState(0);
    const [isSummaryVisible, setIsSummaryVisible] = useState(false);
    const [isSummaryActive, setIsSummaryActive] = useState(false);
    const hideSummaryTimerRef = useRef(null);
    const unmountSummaryTimerRef = useRef(null);
    const summaryAnimationFrameRef = useRef(null);

    useEffect(() => () => {
        if (hideSummaryTimerRef.current) clearTimeout(hideSummaryTimerRef.current);
        if (unmountSummaryTimerRef.current) clearTimeout(unmountSummaryTimerRef.current);
        if (summaryAnimationFrameRef.current) cancelAnimationFrame(summaryAnimationFrameRef.current);
    }, []);

    const showSummary = (top = summaryTop) => {
        if (!summary) return;
        if (hideSummaryTimerRef.current) {
            clearTimeout(hideSummaryTimerRef.current);
            hideSummaryTimerRef.current = null;
        }
        if (unmountSummaryTimerRef.current) {
            clearTimeout(unmountSummaryTimerRef.current);
            unmountSummaryTimerRef.current = null;
        }
        if (summaryAnimationFrameRef.current) {
            cancelAnimationFrame(summaryAnimationFrameRef.current);
            summaryAnimationFrameRef.current = null;
        }
        setSummaryTop(top);
        setIsSummaryVisible(true);
        setIsSummaryActive(false);
        summaryAnimationFrameRef.current = requestAnimationFrame(() => {
            setIsSummaryActive(true);
            summaryAnimationFrameRef.current = null;
        });
    };

    const scheduleHideSummary = () => {
        if (hideSummaryTimerRef.current) clearTimeout(hideSummaryTimerRef.current);
        hideSummaryTimerRef.current = setTimeout(() => {
            setIsSummaryActive(false);
            hideSummaryTimerRef.current = null;
            unmountSummaryTimerRef.current = setTimeout(() => {
                setIsSummaryVisible(false);
                unmountSummaryTimerRef.current = null;
            }, 180);
        }, 220);
    };

    // Immediately tear down the popover (no fade) — used when a drag starts, so
    // the summary doesn't linger over the drag.
    const hideSummaryNow = () => {
        if (hideSummaryTimerRef.current) {
            clearTimeout(hideSummaryTimerRef.current);
            hideSummaryTimerRef.current = null;
        }
        if (unmountSummaryTimerRef.current) {
            clearTimeout(unmountSummaryTimerRef.current);
            unmountSummaryTimerRef.current = null;
        }
        if (summaryAnimationFrameRef.current) {
            cancelAnimationFrame(summaryAnimationFrameRef.current);
            summaryAnimationFrameRef.current = null;
        }
        setIsSummaryActive(false);
        setIsSummaryVisible(false);
    };

    const downloadPdf = async () => {
        const data = await loadPdf(file.name);
        const blob = new Blob([data], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = file.name;
        anchor.click();
        URL.revokeObjectURL(url);
    };

    const isDragging = dragging?.kind === 'file' && dragging.name === file.name;
    const dropPosition = dragOver?.kind === 'file' && dragOver.name === file.name
        ? dragOver.position
        : null;
    const liClass = [
        isActive ? 'active' : '',
        isDragging ? 'dragging' : '',
        dropPosition ? `drop-${dropPosition}` : '',
    ].filter(Boolean).join(' ');

    return (
        <li
            className={liClass}
            draggable
            onDragStart={(event) => {
                // Keep the row draggable even while the hover summary is up:
                // the popover opens on the very hover you need to grab the file,
                // so gating draggable on it made summarized files un-draggable.
                // Just dismiss the popover as the drag begins.
                hideSummaryNow();
                event.dataTransfer.setData('fileName', file.name);
                event.dataTransfer.setData('text/plain', file.name);
                event.dataTransfer.effectAllowed = 'move';
                onSetDragging({ kind: 'file', name: file.name });
            }}
            onDragOver={(event) => {
                // Let external files / folder drags bubble up so the folder
                // highlights as the move-into target; only file reordering is
                // handled here.
                if (!Array.from(event.dataTransfer.types).includes('fileName')) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                if (isDragging) {
                    onSetDragOver(null);
                    return;
                }
                const rect = event.currentTarget.getBoundingClientRect();
                const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                onSetDragOver({ kind: 'file', name: file.name, position });
            }}
            onDrop={(event) => {
                const draggedFileName = event.dataTransfer.getData('fileName');
                if (!draggedFileName) return;
                event.preventDefault();
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                onFileDrop(draggedFileName, file.name, position);
            }}
        >
            <div
                className="file-item-main"
                onClick={() => onSelect(file.name)}
                onMouseEnter={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    showSummary(Math.max(10, Math.min(rect.top, window.innerHeight - 300)));
                }}
                onMouseLeave={scheduleHideSummary}
            >
                {isEditing ? (
                    <input
                        className="rename-input"
                        value={newName}
                        onInput={(event) => onRenameInput(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') onCommitRename(file.name);
                            if (event.key === 'Escape') onCancelRename();
                        }}
                        onBlur={() => onCommitRename(file.name)}
                        autoFocus
                    />
                ) : (
                    <span className="file-name">{file.name}</span>
                )}
                {summary && isSummaryVisible && (
                    <div
                        className={`file-summary-popover markdown-body ${isSummaryActive ? 'is-active' : ''}`}
                        style={{ top: summaryTop }}
                        draggable={false}
                        onClick={(event) => event.stopPropagation()}
                        onMouseDown={(event) => event.stopPropagation()}
                        onMouseEnter={() => showSummary()}
                        onMouseLeave={scheduleHideSummary}
                    >
                        <div className="file-summary-title">{file.name}</div>
                        <div
                            className="file-summary-body"
                            dangerouslySetInnerHTML={{ __html: renderMarkdown(normalizeSummaryMarkdown(summary)) }}
                        />
                    </div>
                )}
            </div>
            <div className="file-actions">
                <div className="dropdown-container" ref={activeMenu === file.name ? menuRef : null}>
                    <button
                        className="file-menu-btn"
                        onClick={(event) => {
                            event.stopPropagation();
                            onToggleMenu(file.name);
                        }}
                    >
                        <MoreVertical size={14} />
                    </button>
                    {activeMenu === file.name && (
                        <div className="file-dropdown">
                            <button
                                className="menu-item"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onStartRename(file.name);
                                    onCloseMenu();
                                }}
                            >
                                <Edit3 size={14} /> 名前変更
                            </button>
                            <button
                                className="menu-item"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    downloadPdf();
                                    onCloseMenu();
                                }}
                            >
                                <Download size={14} /> ダウンロード
                            </button>
                            <button
                                className="menu-item delete"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onDelete(file.name);
                                    onCloseMenu();
                                }}
                            >
                                <Trash2 size={14} /> 削除
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </li>
    );
}
