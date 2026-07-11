import { ChevronDown, ChevronRight, Download, Edit3, Folder, Plus, RefreshCw, Trash2 } from 'lucide-preact';
import { FileRow } from './FileRow';
import { DEFAULT_FOLDER, getFileFolder } from './sidebarUtils';

export function FolderGroup({
    folder,
    files,
    folderFiles,
    currentPdfName,
    expandedFolders,
    editingFolder,
    folderRenameValue,
    editingFile,
    newName,
    activeMenu,
    menuRef,
    onToggleFolder,
    onUpload,
    onDeleteFolder,
    onStartFolderRename,
    onFolderRenameInput,
    onCommitFolderRename,
    onCancelFolderRename,
    onFolderReorder,
    onSelectPdf,
    onStartRename,
    onRenameInput,
    onCommitRename,
    onCancelRename,
    onDeleteFile,
    onToggleMenu,
    onCloseMenu,
    onFolderDrop,
    onDropUpload,
    onFileDrop,
    dragOver,
    dragging,
    onSetDragOver,
    onSetDragging,
    ocrMarkdownIndex,
    onDownloadFolderZip,
    zippingFolder,
}) {
    const isExpanded = expandedFolders.includes(folder);
    const isEditingFolder = editingFolder === folder;
    const visibleFiles = folderFiles ?? files.filter((file) => getFileFolder(file) === folder);
    const isZipping = zippingFolder === folder;
    const hasExternalFiles = (event) => (
        event.dataTransfer.files?.length > 0 || Array.from(event.dataTransfer.types).includes('Files')
    );

    const isFolderDropTarget = dragOver?.kind === 'folder' && dragOver.folder === folder;
    const isFolderReorderTarget = dragOver?.kind === 'folderReorder' && dragOver.folder === folder;
    const isDraggingThisFolder = dragging?.kind === 'folder' && dragging.folder === folder;

    return (
        <div
            className={`folder-group${isFolderDropTarget ? ' drop-target' : ''}`}
            onDragEnter={(event) => event.preventDefault()}
            onDragOver={(event) => {
                if (Array.from(event.dataTransfer.types).includes('folderName')) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = hasExternalFiles(event) ? 'copy' : 'move';
                onSetDragOver({ kind: 'folder', folder });
            }}
            onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (hasExternalFiles(event)) {
                    onDropUpload(event.dataTransfer.files, folder);
                    return;
                }
                const fileName = event.dataTransfer.getData('fileName') || event.dataTransfer.getData('text/plain');
                onFolderDrop(fileName, folder);
            }}
        >
            <div
                className={`folder-header${isFolderReorderTarget ? ' folder-drop-target' : ''}${isDraggingThisFolder ? ' dragging' : ''}`}
                draggable={!isEditingFolder}
                onDragStart={(event) => {
                    event.dataTransfer.setData('folderName', folder);
                    event.dataTransfer.effectAllowed = 'move';
                    onSetDragging({ kind: 'folder', folder });
                }}
                onDragOver={(event) => {
                    if (!Array.from(event.dataTransfer.types).includes('folderName')) return;
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = 'move';
                    if (!isDraggingThisFolder) onSetDragOver({ kind: 'folderReorder', folder });
                }}
                onDrop={(event) => {
                    const folderName = event.dataTransfer.getData('folderName');
                    if (!folderName) return;
                    event.preventDefault();
                    event.stopPropagation();
                    onFolderReorder(folderName, folder);
                }}
            >
                <div className="folder-info" onClick={() => onToggleFolder(folder)}>
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <Folder size={14} />
                    {isEditingFolder ? (
                        <input
                            className="folder-rename-input"
                            value={folderRenameValue}
                            onClick={(event) => event.stopPropagation()}
                            onInput={(event) => onFolderRenameInput(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') onCommitFolderRename(folder);
                                if (event.key === 'Escape') onCancelFolderRename();
                            }}
                            onBlur={() => onCommitFolderRename(folder)}
                            autoFocus
                        />
                    ) : (
                        <span>{folder}</span>
                    )}
                    <span className="count">{visibleFiles.length}</span>
                </div>
                <div className="folder-actions-direct">
                    <label className="icon-action-btn" title="アップロード">
                        <Plus size={16} />
                        <input type="file" accept="application/pdf" multiple onChange={(event) => onUpload(event, folder)} hidden />
                    </label>
                    {visibleFiles.length > 0 && (
                        <button
                            className="icon-action-btn"
                            title="フォルダをZIPでダウンロード"
                            disabled={isZipping}
                            onClick={(event) => {
                                event.stopPropagation();
                                onDownloadFolderZip(folder);
                            }}
                        >
                            {isZipping ? <RefreshCw size={14} className="spinning" /> : <Download size={14} />}
                        </button>
                    )}
                    {folder !== DEFAULT_FOLDER && (
                        <button
                            className="icon-action-btn"
                            title="フォルダ名を変更"
                            onClick={(event) => {
                                event.stopPropagation();
                                onStartFolderRename(folder);
                            }}
                        >
                            <Edit3 size={12} />
                        </button>
                    )}
                    {folder !== DEFAULT_FOLDER && (
                        <button
                            className="icon-action-btn delete"
                            title="フォルダ削除"
                            onClick={(event) => {
                                event.stopPropagation();
                                onDeleteFolder(folder);
                            }}
                        >
                            <Trash2 size={12} />
                        </button>
                    )}
                </div>
            </div>
            {isExpanded && (
                <ul className="file-list">
                    {visibleFiles.map((file) => (
                        <FileRow
                            key={file.name}
                            file={file}
                            isActive={currentPdfName === file.name}
                            isEditing={editingFile === file.name}
                            newName={newName}
                            activeMenu={activeMenu}
                            menuRef={menuRef}
                            onSelect={onSelectPdf}
                            onStartRename={onStartRename}
                            onRenameInput={onRenameInput}
                            onCommitRename={onCommitRename}
                            onCancelRename={onCancelRename}
                            onDelete={onDeleteFile}
                            onToggleMenu={onToggleMenu}
                            onCloseMenu={onCloseMenu}
                            onFileDrop={onFileDrop}
                            dragOver={dragOver}
                            dragging={dragging}
                            onSetDragOver={onSetDragOver}
                            onSetDragging={onSetDragging}
                            summary={ocrMarkdownIndex?.[file.name]?.summary || ''}
                        />
                    ))}
                </ul>
            )}
        </div>
    );
}
