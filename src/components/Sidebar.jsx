import { useState } from 'preact/hooks';
import { List, RefreshCw, Settings, Sun, Moon } from 'lucide-preact';
import { FileBrowser } from './sidebar/FileBrowser';
import { SettingsPanel } from './sidebar/SettingsPanel';
import { useTheme } from '../hooks/useTheme';

export default function Sidebar({
    onSelectPdf,
    currentPdfName,
    onOpenSync,
    isSyncActive,
    pdfs,
    setPdfs,
    customFolders,
    setCustomFolders,
    ocrMarkdownIndex,
}) {
    const [view, setView] = useState('files');
    const { theme, toggleTheme } = useTheme();
    const isDark = theme === 'dark';

    return (
        <div className="sidebar">
            <div className="sidebar-header">
                <h1>PDF Viewer</h1>
                <div className="nav-icons">
                    <button
                        className={view === 'files' ? 'active' : ''}
                        onClick={() => setView('files')}
                        title="ファイル一覧"
                    >
                        <List size={16} />
                    </button>
                    <button
                        className={isSyncActive ? 'active' : ''}
                        onClick={onOpenSync}
                        title="同期設定"
                    >
                        <RefreshCw size={16} className={isSyncActive ? 'spinning' : ''} />
                    </button>
                    <button
                        className={view === 'settings' ? 'active' : ''}
                        onClick={() => setView('settings')}
                        title="AI設定"
                    >
                        <Settings size={16} />
                    </button>
                    <button
                        onClick={toggleTheme}
                        title={isDark ? 'ライトモードに切り替え' : 'ダークモードに切り替え'}
                        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
                    >
                        {isDark ? <Sun size={16} /> : <Moon size={16} />}
                    </button>
                </div>
            </div>

            <div className="sidebar-content">
                {view === 'files' ? (
                    <FileBrowser
                        currentPdfName={currentPdfName}
                        onSelectPdf={onSelectPdf}
                        pdfs={pdfs}
                        setPdfs={setPdfs}
                        customFolders={customFolders}
                        setCustomFolders={setCustomFolders}
                        ocrMarkdownIndex={ocrMarkdownIndex}
                    />
                ) : (
                    <SettingsPanel />
                )}
            </div>

            <div className="sidebar-footer">
                Powered by <a href="https://github.com/tik-choco-lab/mistlib" target="_blank" rel="noopener noreferrer">mistlib</a>
            </div>
        </div>
    );
}
