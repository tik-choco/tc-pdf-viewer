import { Download, Edit3, MoreVertical, Trash2 } from 'lucide-preact';
import { loadPdf } from '../../services/storage';

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
}) {
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

    return (
        <li
            className={isActive ? 'active' : ''}
            draggable
            onDragStart={(event) => {
                event.dataTransfer.setData('fileName', file.name);
                event.dataTransfer.setData('text/plain', file.name);
                event.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onFileDrop(event.dataTransfer.getData('fileName'), file.name);
            }}
        >
            <div className="file-item-main" onClick={() => onSelect(file.name)}>
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
