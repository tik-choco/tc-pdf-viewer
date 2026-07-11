import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Check, FolderPlus } from 'lucide-preact';
import {
    deletePdf,
    getPdfList,
    loadPdf,
    renamePdf,
    savePdf,
    updatePdfList,
} from '../../services/storage';
import { FolderGroup } from './FolderGroup';
import {
    DEFAULT_FOLDER,
    getAllFolders,
    moveFileToFolder,
    persistCustomFolders,
    renameFolderInList,
    reorderFolderBefore,
    reorderFile,
} from './sidebarUtils';
import { createZip, sanitizeZipSegment } from '../../utils/zip';

export function FileBrowser({
    currentPdfName,
    onSelectPdf,
    pdfs,
    setPdfs,
    customFolders,
    setCustomFolders,
    ocrMarkdownIndex,
}) {
    const [isUploading, setIsUploading] = useState(false);
    const [expandedFolders, setExpandedFolders] = useState([DEFAULT_FOLDER]);
    const [editingFile, setEditingFile] = useState(null);
    const [newName, setNewName] = useState('');
    const [isAddingFolder, setIsAddingFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [editingFolder, setEditingFolder] = useState(null);
    const [folderRenameValue, setFolderRenameValue] = useState('');
    const [activeMenu, setActiveMenu] = useState(null);
    const [dragOver, setDragOver] = useState(null);
    const [dragging, setDragging] = useState(null);
    const [zippingFolder, setZippingFolder] = useState(null);
    const menuRef = useRef(null);

    const clearDrag = () => {
        setDragging(null);
        setDragOver(null);
    };

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

    const isPdfFile = (file) => (
        file?.type === 'application/pdf' || file?.name?.toLowerCase().endsWith('.pdf')
    );

    const hasExternalFiles = (event) => (
        event.dataTransfer.files?.length > 0 || Array.from(event.dataTransfer.types).includes('Files')
    );

    const uploadPdfFiles = async (files, folderName) => {
        const pdfFiles = Array.from(files).filter(isPdfFile);
        if (pdfFiles.length === 0) {
            alert('PDFファイルをドロップしてください。');
            return;
        }

        setIsUploading(true);
        try {
            for (const file of pdfFiles) {
                const buffer = await file.arrayBuffer();
                await savePdf(file.name, new Uint8Array(buffer), folderName);
            }
            await loadFiles();
            onSelectPdf(pdfFiles[0].name);
        } catch (err) {
            alert('アップロードに失敗しました。');
        } finally {
            setIsUploading(false);
        }
    };

    const handleUpload = async (event, folderName) => {
        const files = event.target.files;
        if (!files?.length) return;

        await uploadPdfFiles(files, folderName);
        event.target.value = '';
    };

    const handleDropUpload = async (files, folderName) => {
        clearDrag();
        await uploadPdfFiles(files, folderName);
        setExpandedFolders((folders) => folders.includes(folderName) ? folders : [...folders, folderName]);
    };

    const handleSectionDrop = async (event) => {
        clearDrag();
        if (!hasExternalFiles(event)) return;
        event.preventDefault();
        await handleDropUpload(event.dataTransfer.files, DEFAULT_FOLDER);
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

    const startFolderRename = (folder) => {
        setEditingFolder(folder);
        setFolderRenameValue(folder);
    };

    const handleRenameFolder = async (oldName) => {
        const trimmedName = folderRenameValue.trim();
        if (!trimmedName || trimmedName === oldName) {
            setEditingFolder(null);
            return;
        }

        const existingFolders = getAllFolders(customFolders, pdfs);
        if (existingFolders.includes(trimmedName)) {
            alert('同じ名前のフォルダが既にあります。');
            return;
        }

        const nextFolders = renameFolderInList(existingFolders, oldName, trimmedName);
        const nextPdfs = pdfs.map((file) => (
            file.folder === oldName ? { ...file, folder: trimmedName } : file
        ));

        setCustomFolders(nextFolders);
        persistCustomFolders(nextFolders);
        setPdfs(nextPdfs);
        setExpandedFolders((folders) => renameFolderInList(folders, oldName, trimmedName));
        setEditingFolder(null);
        await updatePdfList(nextPdfs);
    };

    const handleFolderReorder = (draggedFolder, targetFolder) => {
        clearDrag();
        const currentFolders = getAllFolders(customFolders, pdfs);
        const nextFolders = reorderFolderBefore(currentFolders, draggedFolder, targetFolder);
        if (nextFolders === currentFolders) return;

        setCustomFolders(nextFolders);
        persistCustomFolders(nextFolders);
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
        // Clear synchronously, before the setPdfs below re-renders the dragged
        // row out of its source folder's list and into this one: that unmounts
        // the original <li> (a different FolderGroup subtree) rather than
        // moving it, so its 'dragend' never fires and can't be relied on to
        // clear this state — see also handleFileDrop/handleFolderReorder.
        clearDrag();
        if (!fileName) return;
        const nextPdfs = moveFileToFolder(pdfs, fileName, folder);
        if (nextPdfs === pdfs) return;

        setPdfs(nextPdfs);
        await updatePdfList(nextPdfs);
    };

    const handleFileDrop = async (draggedFileName, targetFileName, position) => {
        clearDrag();
        const nextPdfs = reorderFile(pdfs, draggedFileName, targetFileName, position);
        if (nextPdfs === pdfs) return;

        setPdfs(nextPdfs);
        await updatePdfList(nextPdfs);
    };

    const handleDownloadFolderZip = async (folder) => {
        if (zippingFolder) return;
        const folderFiles = filesByFolder.get(folder) || [];
        if (folderFiles.length === 0) return;

        setZippingFolder(folder);
        try {
            const entries = [];
            for (const file of folderFiles) {
                const data = await loadPdf(file.name);
                entries.push({ name: sanitizeZipSegment(file.name), data });
            }
            const zipBytes = createZip(entries);
            const blob = new Blob([zipBytes], { type: 'application/zip' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `${sanitizeZipSegment(folder)}.zip`;
            anchor.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            alert('ZIPダウンロードに失敗しました。');
        } finally {
            setZippingFolder(null);
        }
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

    const allFolders = useMemo(() => getAllFolders(customFolders, pdfs), [customFolders, pdfs]);
    const filesByFolder = useMemo(() => {
        const grouped = new Map();
        for (const file of pdfs) {
            const folder = file.folder || DEFAULT_FOLDER;
            const files = grouped.get(folder) || [];
            files.push(file);
            grouped.set(folder, files);
        }
        return grouped;
    }, [pdfs]);

    return (
        <div
            className="file-section"
            aria-busy={isUploading}
            onDragOver={(event) => {
                if (!hasExternalFiles(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setDragOver(null);
            }}
            onDragEnd={clearDrag}
            onDrop={handleSectionDrop}
        >
            <div className="folder-list">
                {allFolders.map((folder) => (
                    <FolderGroup
                        key={folder}
                        folder={folder}
                        files={pdfs}
                        folderFiles={filesByFolder.get(folder) || []}
                        currentPdfName={currentPdfName}
                        expandedFolders={expandedFolders}
                        editingFolder={editingFolder}
                        folderRenameValue={folderRenameValue}
                        editingFile={editingFile}
                        newName={newName}
                        activeMenu={activeMenu}
                        menuRef={menuRef}
                        onToggleFolder={toggleFolder}
                        onUpload={handleUpload}
                        onDeleteFolder={handleDeleteFolder}
                        onStartFolderRename={startFolderRename}
                        onFolderRenameInput={setFolderRenameValue}
                        onCommitFolderRename={handleRenameFolder}
                        onCancelFolderRename={() => setEditingFolder(null)}
                        onFolderReorder={handleFolderReorder}
                        onSelectPdf={onSelectPdf}
                        onStartRename={startRename}
                        onRenameInput={setNewName}
                        onCommitRename={handleRename}
                        onCancelRename={() => setEditingFile(null)}
                        onDeleteFile={handleDelete}
                        onToggleMenu={(name) => setActiveMenu(activeMenu === name ? null : name)}
                        onCloseMenu={() => setActiveMenu(null)}
                        onFolderDrop={handleFolderDrop}
                        onDropUpload={handleDropUpload}
                        onFileDrop={handleFileDrop}
                        dragOver={dragOver}
                        dragging={dragging}
                        onSetDragOver={setDragOver}
                        onSetDragging={setDragging}
                        ocrMarkdownIndex={ocrMarkdownIndex}
                        onDownloadFolderZip={handleDownloadFolderZip}
                        zippingFolder={zippingFolder}
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
