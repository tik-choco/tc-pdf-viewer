import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import Sidebar from './components/Sidebar';
import PdfViewer from './components/PdfViewer';
import Tooltip from './components/Tooltip';
import Chat from './components/Chat';
import { loadPdf, renamePdf, getPdfList as loadPdfList } from './services/storage';
import { extractText } from './services/pdf';
import { explainText, translateText, getAiSettings, saveAiSettings } from './services/ai';
import { PanelLeftClose, PanelLeftOpen, MessageCircle, RefreshCw } from 'lucide-preact';
import { useSync } from './hooks/useSync';
import { SyncPanel } from './components/SyncPanel';
import { DiffConfirmPanel } from './components/DiffConfirmPanel';
import { QRPanel } from './components/QRPanel';

export function App() {
  const [currentPdfName, setCurrentPdfName] = useState(null);
  const [pdfData, setPdfData] = useState(null);
  const [pdfContent, setPdfContent] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);

  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [chatWidth, setChatWidth] = useState(350);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [isResizingChat, setIsResizingChat] = useState(false);
  const [isPdfMasking, setIsPdfMasking] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  const [tooltipText, setTooltipText] = useState(null);
  const [lastHoverText, setLastHoverText] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const [lastLang, setLastLang] = useState(localStorage.getItem('mist_last_lang') || '日本語');

  const [pdfs, setPdfs] = useState([]);
  const [customFolders, setCustomFolders] = useState(['Default']);

  useEffect(() => {
    const loadData = async () => {
      const list = await loadPdfList();
      setPdfs(list);
      const savedFolders = localStorage.getItem('mist_custom_folders');
      if (savedFolders) {
        try {
          const parsed = JSON.parse(savedFolders);
          if (Array.isArray(parsed)) setCustomFolders(parsed);
        } catch (e) {}
      }
    };
    loadData();

    const handleSyncUpdate = () => {
      loadData();
    };
    window.addEventListener('sync-data-updated', handleSyncUpdate);
    return () => window.removeEventListener('sync-data-updated', handleSyncUpdate);
  }, []);

  const syncState = useMemo(() => ({
    files: pdfs,
    explanations: JSON.parse(localStorage.getItem('mist_explanations_index') || '{}'),
    aiSettings: getAiSettings(),
    lastLang: lastLang,
    lastPdf: currentPdfName,
    customFolders: customFolders
  }), [pdfs, lastLang, currentPdfName, customFolders]);

  const [isSyncOpen, setIsSyncOpen] = useState(false);
  const [isQrOpen, setIsQrOpen] = useState(false);
  const [isDiffConfirmOpen, setIsDiffConfirmOpen] = useState(false);

  const {
    roomId,
    inviteUrl,
    status: syncStatus,
    error: syncError,
    acceptRemoteState,
    setAcceptRemoteState,
    peerCount,
    hasRemoteStateDiff,
    startSync,
    copyInviteLink,
    disconnect,
  } = useSync({
    state: syncState,
    onReplaceState: (nextState) => {
      localStorage.setItem('mist_files_index', JSON.stringify(nextState.files));
      localStorage.setItem('mist_explanations_index', JSON.stringify(nextState.explanations));
      saveAiSettings(nextState.aiSettings);
      localStorage.setItem('mist_last_lang', nextState.lastLang);
      localStorage.setItem('mist_custom_folders', JSON.stringify(nextState.customFolders));
      
      setLastLang(nextState.lastLang);
      setPdfs(nextState.files);
      setCustomFolders(nextState.customFolders);
      
      if (nextState.lastPdf && nextState.lastPdf !== currentPdfName) {
        handleSelectPdf(nextState.lastPdf);
      }
      
      window.dispatchEvent(new CustomEvent('sync-data-updated'));
    },
    isEditing: isRenaming
  });

  useEffect(() => {
    if (syncStatus === 'connected' && hasRemoteStateDiff && !acceptRemoteState) {
      setIsDiffConfirmOpen(true);
    } else if (!hasRemoteStateDiff) {
      setIsDiffConfirmOpen(false);
    }
  }, [syncStatus, hasRemoteStateDiff, acceptRemoteState]);

  const containerRef = useRef(null);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (isResizingSidebar) {
        const newWidth = Math.max(200, Math.min(600, e.clientX));
        setSidebarWidth(newWidth);
      } else if (isResizingChat) {
        const newWidth = Math.max(250, Math.min(800, window.innerWidth - e.clientX));
        setChatWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizingSidebar(false);
      setIsResizingChat(false);
      document.body.style.cursor = 'default';
    };

    if (isResizingSidebar || isResizingChat) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingSidebar, isResizingChat]);

  const handleSelectPdf = async (name) => {
    setIsPdfMasking(true);
    setCurrentPdfName(name);
    setPdfContent('');
    localStorage.setItem('mist_last_pdf', name);
    try {
      const data = await loadPdf(name);
      if (data) {
        setPdfData(data);
        setIsTooltipVisible(false);
        const text = await extractText(data);
        setPdfContent(text);
      } else {
        alert('PDFの読み込みに失敗しました');
      }
    } catch (err) {
      console.error(err);
      alert('エラーが発生しました: ' + err.message);
    } finally {
      setTimeout(() => {
        setIsPdfMasking(false);
      }, 0);
    }
  };

  const handleHeaderRename = async () => {
    if (!renameValue.trim() || renameValue === currentPdfName) {
      setIsRenaming(false);
      return;
    }
    const success = await renamePdf(currentPdfName, renameValue);
    if (success) {
      setCurrentPdfName(renameValue);
      localStorage.setItem('mist_last_pdf', renameValue);
    }
    setIsRenaming(false);
  };

  useEffect(() => {
    const savedPdf = localStorage.getItem('mist_last_pdf');
    if (savedPdf) {
      handleSelectPdf(savedPdf);
    }
  }, []);

  const handleHoverText = useCallback((text, pos) => {
    setTooltipPos(pos);
    setTooltipText(null);
    setLastHoverText(text);
    setIsTooltipVisible(true);
  }, []);

  const handleRequestExplanation = async () => {
    if (!lastHoverText) return;
    setTooltipText('loading');
    try {
      const explanation = await explainText(lastHoverText);
      setTooltipText(explanation);
    } catch (err) {
      setTooltipText('エラー: ' + err.message);
    }
  };

  const handleRequestTranslation = async (lang) => {
    if (!lastHoverText) return;
    setTooltipText('loading');
    setLastLang(lang);
    localStorage.setItem('mist_last_lang', lang);
    try {
      const translation = await translateText(lastHoverText, lang);
      setTooltipText(translation);
    } catch (err) {
      setTooltipText('エラー: ' + err.message);
    }
  };

  const handleSwitchLanguage = (lang) => {
    setLastLang(lang);
    localStorage.setItem('mist_last_lang', lang);
  };

  const closeTooltip = () => {
    setIsTooltipVisible(false);
  };

  return (
    <div
      ref={containerRef}
      className={`app-container ${sidebarOpen ? 'sidebar-pg-open' : 'sidebar-pg-closed'} ${chatOpen ? 'chat-pg-open' : 'chat-pg-closed'}`}
      style={{
        '--sidebar-width': `${sidebarWidth}px`,
        '--chat-width': `${chatWidth}px`
      }}
    >
      <Sidebar
        onSelectPdf={handleSelectPdf}
        currentPdfName={currentPdfName}
        onOpenSync={() => setIsSyncOpen(true)}
        isSyncActive={syncStatus === 'connected' || syncStatus === 'connecting'}
        pdfs={pdfs}
        setPdfs={setPdfs}
        customFolders={customFolders}
        setCustomFolders={setCustomFolders}
      />

      <div
        className={`resizer-handle sidebar-resizer ${isResizingSidebar ? 'is-resizing' : ''}`}
        onMouseDown={() => setIsResizingSidebar(true)}
      />

      <main className="main-content">
        <header className="main-header">
          <button
            className="sidebar-toggle"
            onClick={() => {
              setIsPdfMasking(true);
              setSidebarOpen(!sidebarOpen);
              setTimeout(() => {
                setIsPdfMasking(false);
              }, 600);
            }}
            title="サイドバーを切替"
          >
            {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>

          <div className="current-file-badge">
            {currentPdfName && (
              isRenaming ? (
                <input
                  className="rename-header-input"
                  value={renameValue}
                  onInput={e => setRenameValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleHeaderRename();
                    if (e.key === 'Escape') setIsRenaming(false);
                  }}
                  onBlur={handleHeaderRename}
                  autoFocus
                />
              ) : (
                <div className="file-name-display" onClick={() => { setIsRenaming(true); setRenameValue(currentPdfName); }} title="クリックして名前を変更">
                  <span className="editable-name">{currentPdfName}</span>
                </div>
              )
            )}
          </div>

          <button
            className={`chat-toggle ${chatOpen ? 'active' : ''}`}
            onClick={() => {
              setIsPdfMasking(true);
              setChatOpen(!chatOpen);
              setTimeout(() => {
                setIsPdfMasking(false);
              }, 600);
            }}
            title="AI Chat"
          >
            <MessageCircle size={18} />
            <span className="chat-toggle-text">AI Chat</span>
          </button>
        </header>

        <div className="viewer-and-chat">
          <div className="pdf-viewer-wrapper" style={{ flex: 1, position: 'relative', display: 'flex', minWidth: 0 }}>
            <div className={`pdf-mask ${isPdfMasking ? 'active' : ''}`}></div>
            <PdfViewer
              pdfData={pdfData}
              fileName={currentPdfName}
              onHoverText={handleHoverText}
              currentHoverText={tooltipText}
            />
          </div>

          {chatOpen && (
            <div
              className={`resizer-handle chat-resizer-global ${isResizingChat ? 'is-resizing' : ''}`}
              onMouseDown={() => setIsResizingChat(true)}
            />
          )}

          <Chat
            lastExplainedText={lastHoverText}
            currentPdfName={currentPdfName}
            pdfContent={pdfContent}
            onResizerMouseDown={() => setIsResizingChat(true)}
            isResizing={isResizingChat}
          />
        </div>

        <Tooltip
          text={tooltipText}
          currentTerm={lastHoverText}
          position={tooltipPos}
          isVisible={isTooltipVisible}
          onClose={closeTooltip}
          onRequestExplanation={handleRequestExplanation}
          onRequestTranslation={handleRequestTranslation}
          onSwitchLanguage={handleSwitchLanguage}
          lastLang={lastLang}
        />
      </main>

      <SyncPanel
        open={isSyncOpen}
        onClose={() => setIsSyncOpen(false)}
        roomId={roomId}
        status={syncStatus}
        error={syncError}
        peerCount={peerCount}
        onCopyInvite={copyInviteLink}
        onStartSync={startSync}
        onShowQR={() => setIsQrOpen(true)}
        onDisconnect={disconnect}
      />

      <DiffConfirmPanel
        open={isDiffConfirmOpen}
        onAccept={() => {
          setAcceptRemoteState(true);
          setIsDiffConfirmOpen(false);
        }}
        onDisconnect={() => {
          disconnect();
          setIsDiffConfirmOpen(false);
        }}
      />

      <QRPanel
        open={isQrOpen}
        onClose={() => setIsQrOpen(false)}
        url={inviteUrl}
      />
    </div>
  );
}
