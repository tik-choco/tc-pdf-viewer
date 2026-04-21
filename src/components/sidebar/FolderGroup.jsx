import { ChevronDown, ChevronRight, Folder, Plus, Trash2 } from 'lucide-preact';
import { FileRow } from './FileRow';
import { DEFAULT_FOLDER, getFileFolder } from './sidebarUtils';

export function FolderGroup({
    folder,
    files,
    currentPdfName,
    expandedFolders,
    editingFile,
    newName,
    activeMenu,
    menuRef,
    onToggleFolder,
    onUpload,
    onDeleteFolder,
    onSelectPdf,
    onStartRename,
    onRenameInput,
    onCommitRename,
    onCancelRename,
    onDeleteFile,
    onToggleMenu,
    onCloseMenu,
    onFolderDrop,
    onFileDrop,
}) {
    const isExpanded = expandedFolders.includes(folder);
    const folderFiles = files.filter((file) => getFileFolder(file) === folder);

    return (
        <div
            className="folder-group"
            onDragEnter={(event) => event.preventDefault()}
            onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(event) => {
                event.preventDefault();
                const fileName = event.dataTransfer.getData('fileName') || event.dataTransfer.getData('text/plain');
                onFolderDrop(fileName, folder);
            }}
        >
            <div className="folder-header">
                <div className="folder-info" onClick={() => onToggleFolder(folder)}>
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <Folder size={14} />
                    <span>{folder}</span>
                    <span className="count">{folderFiles.length}</span>
                </div>
                <div className="folder-actions-direct">
                    <label className="icon-action-btn" title="アップロード">
                        <Plus size={16} />
                        <input type="file" accept="application/pdf" onChange={(event) => onUpload(event, folder)} hidden />
                    </label>
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
                    {folderFiles.map((file) => (
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
                        />
                    ))}
                </ul>
            )}
        </div>
    );
}
