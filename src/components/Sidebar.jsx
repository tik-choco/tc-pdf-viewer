import { useState, useEffect, useRef } from 'preact/hooks';
import { Settings, FileUp, List, RefreshCw, Folder, Download, Edit3, Trash2, ChevronRight, ChevronDown, Plus, FolderPlus, Move, Check, X, MoreVertical } from 'lucide-preact';
import { getAiSettings, saveAiSettings, getAvailableModels, testAiConnection, DEFAULT_MODELS } from '../services/ai';
import { getPdfList, savePdf, renamePdf, deletePdf, updatePdfFolder, loadPdf, updatePdfList } from '../services/storage';

export default function Sidebar({ onSelectPdf, currentPdfName, onOpenSync, isSyncActive, pdfs, setPdfs, customFolders, setCustomFolders }) {
    const [view, setView] = useState('files');
    const [settings, setSettings] = useState(getAiSettings());
    const [isUploading, setIsUploading] = useState(false);
    const [availableModels, setAvailableModels] = useState(DEFAULT_MODELS);
    const [isLoadingModels, setIsLoadingModels] = useState(false);
    const [connectionStatus, setConnectionStatus] = useState('');
    const [connectionError, setConnectionError] = useState('');
    const [isTestingConnection, setIsTestingConnection] = useState(false);
    const [expandedFolders, setExpandedFolders] = useState(['Default']);
    const [editingFile, setEditingFile] = useState(null);
    const [newName, setNewName] = useState('');
    const [isAddingFolder, setIsAddingFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [activeMenu, setActiveMenu] = useState(null);
    const menuRef = useRef(null);

    useEffect(() => {
        if (view === 'settings') {
            fetchModels();
        }
    }, [view]);

    useEffect(() => {
        const handleSyncUpdate = () => {
            setSettings(getAiSettings());
        };
        window.addEventListener('sync-data-updated', handleSyncUpdate);

        const handleClickOutside = (e) => {
            if (menuRef.current && !menuRef.current.contains(e.target)) {
                setActiveMenu(null);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            window.removeEventListener('sync-data-updated', handleSyncUpdate);
        }
    }, []);

    useEffect(() => {
        if (currentPdfName && pdfs.length > 0) {
            const fileExists = pdfs.some(p => p.name === currentPdfName);
            if (!fileExists) {
                loadFiles();
            }
        }
    }, [currentPdfName]);

    const loadFiles = async () => {
        const list = await getPdfList();
        setPdfs(list);
    };

    const fetchModels = async () => {
        setIsLoadingModels(true);
        const models = await getAvailableModels(settings);
        setAvailableModels(models);
        setIsLoadingModels(false);
    };

    const updateSettings = (nextSettings) => {
        setSettings(nextSettings);
        saveAiSettings(nextSettings);
        window.dispatchEvent(new CustomEvent('sync-data-updated'));
    };

    const handleTestConnection = async () => {
        setIsTestingConnection(true);
        setConnectionStatus('Testing API connection...');
        setConnectionError('');

        try {
            const result = await testAiConnection(settings);
            setConnectionStatus(`Connected. ${result.modelCount} models available.`);
            const models = await getAvailableModels(settings);
            if (models.length) setAvailableModels(models);
        } catch (err) {
            setConnectionStatus('Connection failed');
            setConnectionError(err.message || String(err));
        } finally {
            setIsTestingConnection(false);
        }
    };

    const handleUpload = async (e, folderName) => {
        const file = e.target.files[0];
        if (!file) return;
        setIsUploading(true);
        try {
            const buffer = await file.arrayBuffer();
            await savePdf(file.name, new Uint8Array(buffer));
            await updatePdfFolder(file.name, folderName);
            await loadFiles();
            onSelectPdf(file.name);
        } catch (err) { alert('アップロード失敗'); } finally { setIsUploading(false); }
    };

    const handleAddFolder = () => {
        if (!newFolderName.trim()) { setIsAddingFolder(false); return; }
        const newList = customFolders.includes(newFolderName) ? customFolders : [...customFolders, newFolderName];
        setCustomFolders(newList);
        localStorage.setItem('mist_custom_folders', JSON.stringify(newList));
        setExpandedFolders(prev => [...prev, newFolderName]);
        setNewFolderName(''); setIsAddingFolder(false);
    };

    const handleRename = async (oldName) => {
        if (!newName.trim() || newName === oldName) { setEditingFile(null); return; }
        await renamePdf(oldName, newName); await loadFiles(); setEditingFile(null);
    };

    const handleDelete = async (name) => {
        if (confirm(`削除しますか？`)) { await deletePdf(name); await loadFiles(); }
    };

    const toggleFolder = (folder) => {
        setExpandedFolders(prev => prev.includes(folder) ? prev.filter(f => f !== folder) : [...prev, folder]);
    };

    const allFolders = Array.from(new Set([...customFolders, ...pdfs.map(p => p.folder || 'Default')]));

    return (
        <div className="sidebar">
            <div className="sidebar-header">
                <h1>PDF Viewer</h1>
                <div className="nav-icons">
                    <button className={view === 'files' ? 'active' : ''} onClick={() => setView('files')} title="ファイル一覧"><List size={16} /></button>
                    <button className={isSyncActive ? 'active' : ''} onClick={onOpenSync} title="同期設定"><RefreshCw size={16} className={isSyncActive ? 'spinning' : ''} /></button>
                    <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')} title="AI設定"><Settings size={16} /></button>
                </div>
            </div>
            <div className="sidebar-content">
                {view === 'files' ? (
                    <div className="file-section">
                        <div className="folder-list">
                            {allFolders.map(folder => (
                                <div
                                    key={folder}
                                    className="folder-group"
                                    onDragEnter={e => e.preventDefault()}
                                    onDragOver={e => {
                                        e.preventDefault();
                                        e.dataTransfer.dropEffect = 'move';
                                    }}
                                    onDrop={async e => {
                                        e.preventDefault();
                                        const fileName = e.dataTransfer.getData('fileName') || e.dataTransfer.getData('text/plain');
                                        if (fileName) {
                                            const targetFolder = folder === 'Default' ? 'Default' : folder;
                                            const newPdfs = [...pdfs];
                                            const idx = newPdfs.findIndex(p => p.name === fileName);
                                            if (idx !== -1) {
                                                const [item] = newPdfs.splice(idx, 1);
                                                item.folder = targetFolder;
                                                
                                                let lastIdx = -1;
                                                for (let i = newPdfs.length - 1; i >= 0; i--) {
                                                    if ((newPdfs[i].folder || 'Default') === targetFolder) {
                                                        lastIdx = i;
                                                        break;
                                                    }
                                                }
                                                
                                                if (lastIdx !== -1) {
                                                    newPdfs.splice(lastIdx + 1, 0, item);
                                                } else {
                                                    newPdfs.push(item);
                                                }
                                                
                                                setPdfs(newPdfs);
                                                await updatePdfList(newPdfs);
                                            }
                                        }
                                    }}
                                >
                                    <div className="folder-header">
                                        <div className="folder-info" onClick={() => toggleFolder(folder)}>
                                            {expandedFolders.includes(folder) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                            <Folder size={14} />
                                            <span>{folder}</span>
                                            <span className="count">{pdfs.filter(p => (p.folder || 'Default') === folder).length}</span>
                                        </div>
                                        <div className="folder-actions-direct">
                                            <label className="icon-action-btn" title="アップロード">
                                                <Plus size={16} />
                                                <input type="file" accept="application/pdf" onChange={e => handleUpload(e, folder)} hidden />
                                            </label>
                                            {folder !== 'Default' && (
                                                <button
                                                    className="icon-action-btn delete"
                                                    title="フォルダ削除"
                                                    onClick={async (e) => {
                                                        e.stopPropagation();
                                                        if (confirm(`「${folder}」を削除しますか？\n（中のファイルはDefaultに移動します）`)) {
                                                            setCustomFolders(f => f.filter(x => x !== folder));
                                                            localStorage.setItem('mist_custom_folders', JSON.stringify(customFolders.filter(x => x !== folder)));

                                                            let changed = false;
                                                            for (const p of pdfs) {
                                                                if (p.folder === folder) {
                                                                    await updatePdfFolder(p.name, '');
                                                                    changed = true;
                                                                }
                                                            }
                                                            if (changed) await loadFiles();
                                                        }
                                                    }}
                                                >
                                                    <Trash2 size={12} />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    {expandedFolders.includes(folder) && (
                                        <ul className="file-list">
                                            {pdfs.filter(p => (p.folder || 'Default') === folder).map(file => (
                                                <li
                                                    key={file.name}
                                                    className={currentPdfName === file.name ? 'active' : ''}
                                                    draggable
                                                    onDragStart={e => {
                                                        e.dataTransfer.setData('fileName', file.name);
                                                        e.dataTransfer.setData('text/plain', file.name);
                                                        e.dataTransfer.effectAllowed = 'move';
                                                    }}
                                                    onDragOver={e => {
                                                        e.preventDefault();
                                                        e.dataTransfer.dropEffect = 'move';
                                                    }}
                                                    onDrop={async e => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        const draggedFileName = e.dataTransfer.getData('fileName');
                                                        if (draggedFileName && draggedFileName !== file.name) {
                                                            const newPdfs = [...pdfs];
                                                            const srcIdx = newPdfs.findIndex(p => p.name === draggedFileName);
                                                            const dstIdx = newPdfs.findIndex(p => p.name === file.name);
                                                            if (srcIdx !== -1 && dstIdx !== -1) {
                                                                const [item] = newPdfs.splice(srcIdx, 1);
                                                                item.folder = file.folder || 'Default';
                                                                const insertIdx = newPdfs.findIndex(p => p.name === file.name);
                                                                newPdfs.splice(insertIdx, 0, item);
                                                                setPdfs(newPdfs);
                                                                await updatePdfList(newPdfs);
                                                            }
                                                        }
                                                    }}
                                                >
                                                    <div className="file-item-main" onClick={() => onSelectPdf(file.name)}>
                                                        {editingFile === file.name ? (
                                                            <input className="rename-input" value={newName} onInput={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleRename(file.name); if (e.key === 'Escape') setEditingFile(null); }} onBlur={() => handleRename(file.name)} autoFocus />
                                                        ) : (
                                                            <span className="file-name">{file.name}</span>
                                                        )}
                                                    </div>
                                                    <div className="file-actions">
                                                        <div className="dropdown-container" ref={activeMenu?.id === file.name ? menuRef : null}>
                                                            <button className="file-menu-btn" onClick={(e) => { e.stopPropagation(); setActiveMenu(activeMenu?.id === file.name ? null : { id: file.name }); }}>
                                                                <MoreVertical size={14} />
                                                            </button>
                                                            {activeMenu?.id === file.name && (
                                                                <div className="file-dropdown">
                                                                    <button className="menu-item" onClick={(e) => { e.stopPropagation(); setEditingFile(file.name); setNewName(file.name); setActiveMenu(null); }}><Edit3 size={14} /> 名前変更</button>
                                                                    <button className="menu-item" onClick={(e) => { e.stopPropagation(); loadPdf(file.name).then(d => { const b = new Blob([d], { type: 'application/pdf' }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = file.name; a.click(); }); setActiveMenu(null); }}><Download size={14} /> ダウンロード</button>
                                                                    <button className="menu-item delete" onClick={(e) => { e.stopPropagation(); handleDelete(file.name); setActiveMenu(null); }}><Trash2 size={14} /> 削除</button>
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

                        <div className="file-bottom-bar">
                            <button className="new-folder-top-btn" onClick={() => setIsAddingFolder(true)} style={{ width: '100%' }}>
                                <FolderPlus size={14} /> <span>新規フォルダ</span>
                            </button>
                        </div>

                        {isAddingFolder && (
                            <div className="inline-add-folder">
                                <input className="folder-name-input" placeholder="名前..." value={newFolderName} onInput={e => setNewFolderName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleAddFolder(); if (e.key === 'Escape') setIsAddingFolder(false); }} autoFocus />
                                <button onClick={handleAddFolder}><Check size={14} /></button>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="settings-section">
                        <h3>AI 設定</h3>
                        <div className="form-group">
                            <label htmlFor="ai-base-url">Base URL</label>
                            <input id="ai-base-url" name="ai-base-url" value={settings.baseUrl} onInput={e => updateSettings({ ...settings, baseUrl: e.target.value })} placeholder="https://..." autoComplete="off" />
                        </div>
                        <div className="form-group">
                            <label htmlFor="ai-api-key">API Key</label>
                            <input id="ai-api-key" name="ai-api-key" type="password" value={settings.apiKey} onInput={e => updateSettings({ ...settings, apiKey: e.target.value })} placeholder="sk-..." autoComplete="off" />
                        </div>
                        <div className="form-group">
                            <button className="save-btn" onClick={handleTestConnection} disabled={isTestingConnection}>
                                <RefreshCw size={14} className={isTestingConnection ? 'spinning' : ''} />
                                API接続テスト
                            </button>
                            {(connectionStatus || connectionError) && (
                                <div className="settings-test-result">
                                    <span className={connectionError ? 'error' : ''}>{connectionError || connectionStatus}</span>
                                </div>
                            )}
                        </div>
                        <div className="form-group">
                            <div className="model-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                                <label>モデル設定</label>
                                <button className="refresh-btn" onClick={fetchModels} disabled={isLoadingModels}>
                                    <RefreshCw size={12} className={isLoadingModels ? 'spinning' : ''} />
                                </button>
                            </div>

                            {[
                                { key: 'explain', label: 'AI解説' },
                                { key: 'translate', label: 'AI翻訳' },
                                { key: 'chat', label: 'チャット' },
                                { key: 'ocr', label: 'OCR' }
                            ].map(task => {
                                const currentModel = settings.models?.[task.key] || '';
                                const modelOptions = Array.from(new Set([
                                    ...DEFAULT_MODELS,
                                    ...availableModels
                                ])).sort();
                                const selectedModel = modelOptions.includes(currentModel) ? currentModel : '';

                                return (
                                    <div key={task.key} className="task-model-item" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                                        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', width: '50px' }}>{task.label}</span>
                                        <select
                                            id={`select-model-${task.key}`}
                                            name={`select-model-${task.key}`}
                                            style={{ flex: 1 }}
                                            value={selectedModel}
                                            onChange={e => {
                                                updateSettings({
                                                    ...settings,
                                                    models: { ...settings.models, [task.key]: e.target.value }
                                                });
                                            }}
                                            autoComplete="off"
                                        >
                                            <option value="">(選択...)</option>
                                            {modelOptions.map(m => (
                                                <option key={m} value={m}>{m}</option>
                                            ))}
                                        </select>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
            <div className="sidebar-footer">
                Powered by <a href="https://github.com/tik-choco-lab/mistlib" target="_blank" rel="noopener noreferrer">mistlib</a>
            </div>
        </div>
    );
}
