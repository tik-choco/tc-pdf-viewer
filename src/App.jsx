import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import Sidebar from './components/Sidebar';
import PdfViewer from './components/PdfViewer';
import Tooltip from './components/Tooltip';
import Chat from './components/Chat';
import { loadPdf } from './services/storage';
import { extractText } from './services/pdf';
import { explainText, translateText, getAiSettings } from './services/ai';
import { PanelLeftClose, PanelLeftOpen, MessageCircle } from 'lucide-preact';

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

  const [tooltipText, setTooltipText] = useState(null);
  const [lastHoverText, setLastHoverText] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const [lastLang, setLastLang] = useState(localStorage.getItem('mist_last_lang') || '日本語');

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
            {currentPdfName && `ファイル: ${currentPdfName}`}
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
            title="AIチャット"
          >
            <MessageCircle size={18} />
            <span className="chat-toggle-text">AIチャット</span>
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
    </div>
  );
}
