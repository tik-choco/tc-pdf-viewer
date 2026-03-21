import { useState, useEffect, useRef } from 'preact/hooks';
import { Settings, FileUp, List, Save, RefreshCw, Folder, Download, Edit3, Trash2, ChevronRight, ChevronDown, SortAsc, Plus, FolderPlus, Move, Check, X, MoreVertical } from 'lucide-preact';
import { getAiSettings, saveAiSettings, getAvailableModels } from '../services/ai';
import { getPdfList, savePdf, renamePdf, deletePdf, updatePdfFolder, loadPdf } from '../services/storage';

export default function Sidebar({ onSelectPdf, currentPdfName }) {
    const [view, setView] = useState('files');
    const [pdfs, setPdfs] = useState([]);
    const [settings, setSettings] = useState(getAiSettings());
    const [isUploading, setIsUploading] = useState(false);
    const [availableModels, setAvailableModels] = useState([]);
    const [isLoadingModels, setIsLoadingModels] = useState(false);
    const [sortOrder, setSortOrder] = useState('date');
    const [expandedFolders, setExpandedFolders] = useState(['Default']);
    const [editingFile, setEditingFile] = useState(null);
    const [movingFile, setMovingFile] = useState(null);
    const [newName, setNewName] = useState('');
    const [isAddingFolder, setIsAddingFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [customFolders, setCustomFolders] = useState(['Default']);
    const [activeMenu, setActiveMenu] = useState(null); // { type, id }
    const menuRef = useRef(null);

    useEffect(() => {
        loadFiles();
        const savedFolders = localStorage.getItem('mist_custom_folders');
        if (savedFolders) setCustomFolders(JSON.parse(savedFolders));

        const handleClickOutside = (e) => {
            if (menuRef.current && !menuRef.current.contains(e.target)) {
                setActiveMenu(null);
                setIsAddingFolder(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const loadFiles = async () => {
        const list = await getPdfList();
        setPdfs(list);
    };

    const handleUpload = async (e, folderName) => {
        const file = e.target.files[0];
        if (!file) return;
        setIsUploading(true);
        setActiveMenu(null);
        try {
            const buffer = await file.arrayBuffer();
            await savePdf(file.name, new Uint8Array(buffer));
            await updatePdfFolder(file.name, folderName);
            await loadFiles();
            onSelectPdf(file.name);
        } catch (err) { alert('失敗'); } finally { setIsUploading(false); }
    };

    const handleAddFolder = () => {
        if (!newFolderName.trim()) { setIsAddingFolder(false); return; }
        if (!customFolders.includes(newFolderName)) {
            const newList = [...customFolders, newFolderName];
            setCustomFolders(newList);
            localStorage.setItem('mist_custom_folders', JSON.stringify(newList));
            setExpandedFolders(prev => [...prev, newFolderName]);
        }
        setNewFolderName(''); setIsAddingFolder(false);
    };

    const handleDeleteFolder = (folderName) => {
        if (folderName === 'Default') return;
        if (confirm(`フォルダ「${folderName}」を削除してもよろしいですか？（中のファイルはDefaultに移動します）`)) {
            const newList = customFolders.filter(f => f !== folderName);
            setCustomFolders(newList);
            localStorage.setItem('mist_custom_folders', JSON.stringify(newList));
            pdfs.forEach(async p => {
                if (p.folder === folderName) await updatePdfFolder(p.name, 'Default');
            });
            loadFiles();
        }
    };

    const handleMoveToFolder = async (fileName, folder) => {
        await updatePdfFolder(fileName, folder);
        await loadFiles();
        setMovingFile(null);
    };

    const handleRename = async (oldName) => {
        if (!newName.trim() || newName === oldName) { setEditingFile(null); return; }
        await renamePdf(oldName, newName); await loadFiles(); setEditingFile(null);
    };

    const sortedPdfs = [...pdfs].sort((a, b) => {
        if (sortOrder === 'name') return a.name.localeCompare(b.name);
        return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    const allFolders = Array.from(new Set([...customFolders, ...pdfs.map(p => p.folder || 'Default')]));

    return (
        <div className="sidebar">
            <div className="sidebar-header">
                <h1>PDF Explainer</h1>
                <div className="nav-icons">
                    <button className={view === 'files' ? 'active' : ''} onClick={() => setView('files')}><List size={16} /></button>
                    <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}><Settings size={16} /></button>
                </div>
            </div>
            <div className="sidebar-content">
                {view === 'files' ? (
                    <div className="file-section">
                        <div className="file-top-bar">
                            <button className="sort-btn" onClick={() => setSortOrder(sortOrder === 'name' ? 'date' : 'name')}>
                                <SortAsc size={14} /> {sortOrder === 'name' ? '名前' : '日付'}
                            </button>
                            <button className="new-folder-top-btn" onClick={() => setIsAddingFolder(true)}>
                                <FolderPlus size={14} /> フォルダ
                            </button>
                        </div>

                        {isAddingFolder && (
                            <div className="inline-add-folder" ref={menuRef}>
                                <input className="folder-name-input" placeholder="名前..." value={newFolderName} onInput={e => setNewFolderName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleAddFolder(); if (e.key === 'Escape') setIsAddingFolder(false); }} autoFocus />
                                <button onClick={handleAddFolder}><Check size={14} /></button>
                            </div>
                        )}
                        
                        <div className="folder-list">
                            {allFolders.map(folder => (
                                <div key={folder} className={`folder-group ${expandedFolders.includes(folder) ? 'expanded' : ''}`}>
                                    <div className="folder-header">
                                        <div className="folder-info" onClick={() => toggleFolder(folder)}>
                                            {expandedFolders.includes(folder) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                            <Folder size={14} />
                                            <span>{folder}</span>
                                            <span className="count">{pdfs.filter(p => (p.folder || 'Default') === folder).length}</span>
                                        </div>
                                        
                                        <div className="folder-menu-container" ref={activeMenu?.id === folder ? menuRef : null}>
                                            <button className="folder-plus-btn" onClick={() => setActiveMenu(activeMenu?.id === folder ? null : { type:'folder', id:folder })}>
                                                <Plus size={16} />
                                            </button>
                                            {activeMenu?.id === folder && (
                                                <div className="folder-dropdown">
                                                    <label className="menu-item">
                                                        <FileUp size={14} /> アップロード
                                                        <input type="file" accept="application/pdf" onChange={e => handleUpload(e, folder)} hidden />
                                                    </label>
                                                    {folder !== 'Default' && (
                                                        <button className="menu-item delete" onClick={() => handleDeleteFolder(folder)}>
                                                            <Trash2 size={14} /> 削除
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    {expandedFolders.includes(folder) && (
                                        <ul className="file-list">
                                            {sortedPdfs.filter(p => (p.folder || 'Default') === folder).map(file => (
                                                <li key={file.name} className={currentPdfName === file.name ? 'active' : ''} draggable onDragStart={e => e.dataTransfer.setData('fileName', file.name)}>
                                                    <div className="file-item-main" onClick={() => onSelectPdf(file.name)}>
                                                        {editingFile === file.name ? (
                                                            <input className="rename-input" value={newName} onInput={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleRename(file.name); if (e.key === 'Escape') setEditingFile(null); }} onBlur={() => handleRename(file.name)} autoFocus />
                                                        ) : (
                                                            <span className="file-name">{file.name}</span>
                                                        )}
                                                    </div>
                                                    <div className="file-actions">
                                                        <div className="dropdown-container" ref={activeMenu?.id === file.name ? menuRef : null}>
                                                            <button onClick={() => setActiveMenu(activeMenu?.id === file.name ? null : { type:'file', id:file.name })}>
                                                                <MoreVertical size={12} />
                                                            </button>
                                                            {activeMenu?.id === file.name && (
                                                                <div className="file-dropdown">
                                                                    <button className="menu-item" onClick={() => { setEditingFile(file.name); setNewName(file.name); setActiveMenu(null); }}><Edit3 size={14} /> 名前変更</button>
                                                                    <button className="menu-item" onClick={() => { loadPdf(file.name).then(data => { const b=new Blob([data],{type:'application/pdf'}); const u=URL.createObjectURL(b); const a=document.createElement('a'); a.href=u; a.download=file.name; a.click(); }); setActiveMenu(null); }}><Download size={14} /> ダウンロード</button>
                                                                    <button className="menu-item delete" onClick={() => { if(confirm('削除？')){deletePdf(file.name).then(loadFiles);} setActiveMenu(null); }}><Trash2 size={14} /> 削除</button>
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                ) : (
                    <div className="settings-section">
                        {/* settings content ... */}
                    </div>
                )}
            </div>
            <div className="sidebar-footer">Powered by mistlib</div>
        </div>
    );
}
