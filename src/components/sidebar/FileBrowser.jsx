import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, FolderPlus } from 'lucide-preact';
import {
    deletePdf,
    getPdfList,
    renamePdf,
    savePdf,
    updatePdfFolder,
    updatePdfList,
} from '../../services/storage';
import { FolderGroup } from './FolderGroup';
import {
    DEFAULT_FOLDER,
    getAllFolders,
    moveFileToFolder,
    persistCustomFolders,
    reorderFileBefore,
} from './sidebarUtils';

export function FileBrowser({
    currentPdfName,
    onSelectPdf,
    pdfs,
    setPdfs,
    customFolders,
    setCustomFolders,
}) {
    const [isUploading, setIsUploading] = useState(false);
    const [expandedFolders, setExpandedFolders] = useState([DEFAULT_FOLDER]);
    const [editingFile, setEditingFile] = useState(null);
    const [newName, setNewName] = useState('');
    const [isAddingFolder, setIsAddingFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [activeMenu, setActiveMenu] = useState(null);
    const menuRef = useRef(null);

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (menuRef.current && !menuRef.current.contains(event.target)) {
                setActiveMenu(null);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        if (!currentPdfName || pdfs.length === 0) return;
        const fileExists = pdfs.some((file) => file.name === currentPdfName);
        if (!fileExists) loadFiles();
    }, [currentPdfName]);

    const loadFiles = async () => {
        setPdfs(await getPdfList());
    };

    const handleUpload = async (event, folderName) => {
        const file = event.target.files[0];
        if (!file) return;

        setIsUploading(true);
        try {
            const buffer = await file.arrayBuffer();
            await savePdf(file.name, new Uint8Array(buffer));
            await updatePdfFolder(file.name, folderName);
            await loadFiles();
            onSelectPdf(file.name);
        } catch (err) {
            alert('アップロードに失敗しました。');
        } finally {
            event.target.value = '';
            setIsUploading(false);
        }
    };

    const handleAddFolder = () => {
        const trimmedName = newFolderName.trim();
        if (!trimmedName) {
            setIsAddingFolder(false);
            return;
        }

        const nextFolders = customFolders.includes(trimmedName)
            ? customFolders
            : [...customFolders, trimmedName];

        setCustomFolders(nextFolders);
        persistCustomFolders(nextFolders);
        setExpandedFolders((folders) => folders.includes(trimmedName) ? folders : [...folders, trimmedName]);
        setNewFolderName('');
        setIsAddingFolder(false);
    };

    const handleDeleteFolder = async (folder) => {
        if (!confirm(`「${folder}」を削除しますか？\n中のファイルはDefaultに移動します。`)) return;

        const nextFolders = customFolders.filter((item) => item !== folder);
        setCustomFolders(nextFolders);
        persistCustomFolders(nextFolders);

        const nextPdfs = pdfs.map((file) => (
            file.folder === folder ? { ...file, folder: DEFAULT_FOLDER } : file
        ));
        setPdfs(nextPdfs);
        await updatePdfList(nextPdfs);
    };

    const handleRename = async (oldName) => {
        const trimmedName = newName.trim();
        if (!trimmedName || trimmedName === oldName) {
            setEditingFile(null);
            return;
        }

        await renamePdf(oldName, trimmedName);
        await loadFiles();
        setEditingFile(null);
    };

    const handleDelete = async (name) => {
        if (!confirm(`削除しますか？\n${name}`)) return;
        await deletePdf(name);
        await loadFiles();
    };

    const handleFolderDrop = async (fileName, folder) => {
        if (!fileName) return;
        const nextPdfs = moveFileToFolder(pdfs, fileName, folder);
        if (nextPdfs === pdfs) return;

        setPdfs(nextPdfs);
        await updatePdfList(nextPdfs);
    };

    const handleFileDrop = async (draggedFileName, targetFileName) => {
        const nextPdfs = reorderFileBefore(pdfs, draggedFileName, targetFileName);
        if (nextPdfs === pdfs) return;

        setPdfs(nextPdfs);
        await updatePdfList(nextPdfs);
    };

    const toggleFolder = (folder) => {
        setExpandedFolders((folders) => (
            folders.includes(folder)
                ? folders.filter((item) => item !== folder)
                : [...folders, folder]
        ));
    };

    const startRename = (name) => {
        setEditingFile(name);
        setNewName(name);
    };

    const allFolders = getAllFolders(customFolders, pdfs);

    return (
        <div className="file-section" aria-busy={isUploading}>
            <div className="folder-list">
                {allFolders.map((folder) => (
                    <FolderGroup
                        key={folder}
                        folder={folder}
                        files={pdfs}
                        currentPdfName={currentPdfName}
                        expandedFolders={expandedFolders}
                        editingFile={editingFile}
                        newName={newName}
                        activeMenu={activeMenu}
                        menuRef={menuRef}
                        onToggleFolder={toggleFolder}
                        onUpload={handleUpload}
                        onDeleteFolder={handleDeleteFolder}
                        onSelectPdf={onSelectPdf}
                        onStartRename={startRename}
                        onRenameInput={setNewName}
                        onCommitRename={handleRename}
                        onCancelRename={() => setEditingFile(null)}
                        onDeleteFile={handleDelete}
                        onToggleMenu={(name) => setActiveMenu(activeMenu === name ? null : name)}
                        onCloseMenu={() => setActiveMenu(null)}
                        onFolderDrop={handleFolderDrop}
                        onFileDrop={handleFileDrop}
                    />
                ))}
            </div>

            <div className="file-bottom-bar">
                <button className="new-folder-top-btn" onClick={() => setIsAddingFolder(true)} style={{ width: '100%' }}>
                    <FolderPlus size={14} /> <span>新規フォルダ</span>
                </button>
            </div>

            {isAddingFolder && (
                <div className="inline-add-folder">
                    <input
                        className="folder-name-input"
                        placeholder="名前..."
                        value={newFolderName}
                        onInput={(event) => setNewFolderName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') handleAddFolder();
                            if (event.key === 'Escape') setIsAddingFolder(false);
                        }}
                        autoFocus
                    />
                    <button onClick={handleAddFolder}><Check size={14} /></button>
                </div>
            )}
        </div>
    );
}
