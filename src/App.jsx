import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import Sidebar from './components/Sidebar';
import PdfViewer from './components/PdfViewer';
import MarkdownViewer from './components/MarkdownViewer';
import Tooltip from './components/Tooltip';
import Chat from './components/Chat';
import { loadPdf, renamePdf, getPdfList as loadPdfList, prefetchPdf, saveOcrMarkdown, getOcrMarkdown, getOcrMarkdownIndexSnapshot, saveTranslatedMarkdown, getTranslatedMarkdown, getTranslatedMarkdownIndexSnapshot } from './services/storage';
import { extractText, renderPdfPagesToImages } from './services/pdf';
import { explainText, translateText, translateMarkdown, getAiSettings, saveAiSettings, ocrImagesToMarkdown } from './services/ai';
import { PanelLeftClose, PanelLeftOpen, MessageCircle, RefreshCw, FileText } from 'lucide-preact';
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
  const [documentViewMode, setDocumentViewMode] = useState('pdf');
  const [isOcrRunning, setIsOcrRunning] = useState(false);
  const [ocrMarkdown, setOcrMarkdown] = useState('');
  const [ocrStatus, setOcrStatus] = useState('');
  const [ocrError, setOcrError] = useState('');
  const [hasSavedOcrMarkdown, setHasSavedOcrMarkdown] = useState(false);
  const [translatedMarkdown, setTranslatedMarkdown] = useState('');
  const [markdownTranslateStatus, setMarkdownTranslateStatus] = useState('');
  const [markdownTranslateError, setMarkdownTranslateError] = useState('');
  const [isMarkdownTranslating, setIsMarkdownTranslating] = useState(false);

  const [tooltipText, setTooltipText] = useState(null);
  const [lastHoverText, setLastHoverText] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const [lastLang, setLastLang] = useState(localStorage.getItem('mist_last_lang') || '日本語');

  const [pdfs, setPdfs] = useState([]);
  const [customFolders, setCustomFolders] = useState(['Default']);
  const [ocrMarkdownIndex, setOcrMarkdownIndex] = useState({});
  const [translatedMarkdownIndex, setTranslatedMarkdownIndex] = useState({});
  const [prefetchProgress, setPrefetchProgress] = useState(null); // null | { done, total, complete }
  const lastPrefetchSignatureRef = useRef('');

  useEffect(() => {
    const loadData = async () => {
      const list = await loadPdfList();
      setPdfs(list);
      setOcrMarkdownIndex(getOcrMarkdownIndexSnapshot());
      setTranslatedMarkdownIndex(getTranslatedMarkdownIndexSnapshot());
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
    ocrMarkdown: ocrMarkdownIndex,
    translatedMarkdown: translatedMarkdownIndex,
    aiSettings: getAiSettings(),
    lastLang: lastLang,
    lastPdf: currentPdfName,
    customFolders: customFolders
  }), [pdfs, ocrMarkdownIndex, translatedMarkdownIndex, lastLang, currentPdfName, customFolders]);

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
      localStorage.setItem('mist_ocr_markdown_index', JSON.stringify(nextState.ocrMarkdown || {}));
      localStorage.setItem('mist_translated_markdown_index', JSON.stringify(nextState.translatedMarkdown || {}));
      saveAiSettings(nextState.aiSettings);
      localStorage.setItem('mist_last_lang', nextState.lastLang);
      localStorage.setItem('mist_custom_folders', JSON.stringify(nextState.customFolders));
      
      setLastLang(nextState.lastLang);
      setPdfs(nextState.files);
      setOcrMarkdownIndex(nextState.ocrMarkdown || {});
      setTranslatedMarkdownIndex(nextState.translatedMarkdown || {});
      setCustomFolders(nextState.customFolders);

      // 繝舌ャ繧ｯ繧ｰ繝ｩ繧ｦ繝ｳ繝峨〒蜈ｨPDF繧恥refetch・・on-blocking縲・㍾隍・せ繧ｭ繝・・・・
      const filesToFetch = nextState.files ?? [];
      if (filesToFetch.length > 0) {
        const signature = filesToFetch.map(f => f.cid).join(',');
        if (signature !== lastPrefetchSignatureRef.current) {
          lastPrefetchSignatureRef.current = signature;
          const total = filesToFetch.length;
          setPrefetchProgress({ done: 0, total, complete: false });
          filesToFetch.forEach(f => {
            prefetchPdf(f.name).finally(() => {
              setPrefetchProgress(prev => {
                if (!prev) return null;
                const done = prev.done + 1;
                if (done >= total) {
                  setTimeout(() => setPrefetchProgress(null), 2000);
                  return { done, total, complete: true };
                }
                return { done, total, complete: false };
              });
            });
          });
        }
      }

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
    setOcrMarkdown('');
    setOcrStatus('');
    setOcrError('');
    setHasSavedOcrMarkdown(false);
    setTranslatedMarkdown('');
    setMarkdownTranslateStatus('');
    setMarkdownTranslateError('');
    localStorage.setItem('mist_last_pdf', name);
    try {
      const data = await loadPdf(name);
      if (data) {
        setPdfData(data);
        setIsTooltipVisible(false);
        const text = await extractText(data);
        setPdfContent(text);
        const savedMarkdown = await getOcrMarkdown(name);
        if (savedMarkdown) {
          setOcrMarkdown(savedMarkdown);
          setOcrStatus('菫晏ｭ俶ｸ医∩Markdown');
          setHasSavedOcrMarkdown(true);
        }

        const savedTranslation = await getTranslatedMarkdown(name, lastLang);
        if (savedTranslation) {
          setTranslatedMarkdown(savedTranslation);
          setMarkdownTranslateStatus(`Loaded ${lastLang} translation`);
        }
      }
    } catch (err) {
      console.error('PDF load error:', err);
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
      setTooltipText('繧ｨ繝ｩ繝ｼ: ' + err.message);
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
      setTooltipText('繧ｨ繝ｩ繝ｼ: ' + err.message);
    }
  };

  const handleSwitchLanguage = (lang) => {
    setLastLang(lang);
    localStorage.setItem('mist_last_lang', lang);
  };

  const handleOcrToMarkdown = async () => {
    if (!pdfData || isOcrRunning) return;
    setDocumentViewMode('markdown');

    if (hasSavedOcrMarkdown && ocrMarkdown) {
      return;
    }

    await runOcrToMarkdown();
  };

  const runOcrToMarkdown = async () => {
    if (!pdfData || isOcrRunning) return;

    setDocumentViewMode(prev => prev === 'pdf' ? 'markdown' : prev);
    setIsOcrRunning(true);
    setOcrMarkdown('');
    setOcrError('');
    setHasSavedOcrMarkdown(false);
    setOcrStatus('Rendering PDF pages...');

    try {
      const images = await renderPdfPagesToImages(pdfData, {
        scale: 2,
        onProgress: ({ done, total }) => {
          setOcrStatus(`Rendering PDF pages... ${done}/${total}`);
        },
      });

      const pageMarkdown = [];
      for (let i = 0; i < images.length; i++) {
        setOcrStatus(`Running LLM OCR... ${i + 1}/${images.length}`);
        const markdown = await ocrImagesToMarkdown([images[i]], { fileName: currentPdfName });
        pageMarkdown.push(markdown);
        setOcrMarkdown(pageMarkdown.join('\n\n'));
      }
      const finalMarkdown = pageMarkdown.join('\n\n');
      await saveOcrMarkdown(currentPdfName, finalMarkdown);
      setOcrMarkdownIndex(getOcrMarkdownIndexSnapshot());
      setHasSavedOcrMarkdown(true);
      window.dispatchEvent(new CustomEvent('sync-data-updated'));
      setOcrStatus('Saved');
    } catch (err) {
      setOcrError(err.message || String(err));
      setOcrStatus('Failed');
    } finally {
      setIsOcrRunning(false);
    }
  };

  const saveCurrentOcrMarkdown = async () => {
    if (!currentPdfName || !ocrMarkdown || isOcrRunning) return;
    setOcrError('');
    setOcrStatus('Saving...');
    try {
      await saveOcrMarkdown(currentPdfName, ocrMarkdown);
      setOcrMarkdownIndex(getOcrMarkdownIndexSnapshot());
      setHasSavedOcrMarkdown(true);
      window.dispatchEvent(new CustomEvent('sync-data-updated'));
      setOcrStatus('Saved');
    } catch (err) {
      setOcrError(err.message || String(err));
      setOcrStatus('Save failed');
    }
  };

  const handleTranslateMarkdown = async (targetLanguage, { force = false } = {}) => {
    if (!ocrMarkdown || isMarkdownTranslating) return;

    setMarkdownTranslateError('');
    setMarkdownTranslateStatus(`Translating to ${targetLanguage}...`);
    setIsMarkdownTranslating(true);
    setLastLang(targetLanguage);
    localStorage.setItem('mist_last_lang', targetLanguage);

    try {
      if (!force) {
        const savedTranslation = await getTranslatedMarkdown(currentPdfName, targetLanguage);
        if (savedTranslation) {
          setTranslatedMarkdown(savedTranslation);
          setMarkdownTranslateStatus(`Loaded ${targetLanguage} translation`);
          return;
        }
      }

      setTranslatedMarkdown('');
      const translated = await translateMarkdown(ocrMarkdown, targetLanguage, ({ done, total, translatedMarkdown }) => {
        setTranslatedMarkdown(translatedMarkdown);
        setMarkdownTranslateStatus(`Translating to ${targetLanguage}... ${done}/${total}`);
      });
      setTranslatedMarkdown(translated);
      await saveTranslatedMarkdown(currentPdfName, targetLanguage, translated);
      setTranslatedMarkdownIndex(getTranslatedMarkdownIndexSnapshot());
      window.dispatchEvent(new CustomEvent('sync-data-updated'));
      setMarkdownTranslateStatus(`Translated to ${targetLanguage}`);
    } catch (err) {
      setMarkdownTranslateError(err.message || String(err));
      setMarkdownTranslateStatus('Translation failed');
    } finally {
      setIsMarkdownTranslating(false);
    }
  };

  const copyOcrMarkdown = async () => {
    if (!ocrMarkdown) return;
    await navigator.clipboard.writeText(ocrMarkdown);
  };

  const downloadOcrMarkdown = () => {
    if (!ocrMarkdown) return;
    const baseName = (currentPdfName || 'document.pdf').replace(/\.pdf$/i, '');
    const blob = new Blob([ocrMarkdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
            title="繧ｵ繧､繝峨ヰ繝ｼ繧貞・譖ｿ"
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
                <div className="file-name-display" onClick={() => { setIsRenaming(true); setRenameValue(currentPdfName); }} title="繧ｯ繝ｪ繝・け縺励※蜷榊燕繧貞､画峩">
                  <span className="editable-name">{currentPdfName}</span>
                </div>
              )
            )}
          </div>

          <div className="document-view-switcher">
            <button
              className={documentViewMode === 'pdf' ? 'active' : ''}
              onClick={() => setDocumentViewMode('pdf')}
              disabled={!pdfData}
              title="PDF view"
            >
              PDF
            </button>
            <button
              className={documentViewMode === 'markdown' ? 'active' : ''}
              onClick={() => {
                if (!ocrMarkdown && !isOcrRunning) {
                  handleOcrToMarkdown();
                } else {
                  setDocumentViewMode('markdown');
                }
              }}
              disabled={!pdfData || isOcrRunning}
              title="Markdown view"
            >
              {isOcrRunning ? <RefreshCw size={16} className="spinning" /> : <FileText size={16} />}
              Markdown
            </button>
            <button
              className={documentViewMode === 'split' ? 'active' : ''}
              onClick={() => {
                setDocumentViewMode('split');
                if (!ocrMarkdown && !isOcrRunning) {
                  runOcrToMarkdown();
                }
              }}
              disabled={!pdfData || isOcrRunning}
              title="PDF and Markdown"
            >
              Split
            </button>
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
          <div className={`document-viewer-wrapper mode-${documentViewMode}`} style={{ flex: 1, position: 'relative', display: 'flex', minWidth: 0 }}>
            <div className={`pdf-mask ${isPdfMasking ? 'active' : ''}`}></div>
            {(documentViewMode === 'pdf' || documentViewMode === 'split') && (
              <div className="document-pane pdf-pane">
                <PdfViewer
                  pdfData={pdfData}
                  fileName={currentPdfName}
                  onHoverText={handleHoverText}
                  currentHoverText={tooltipText}
                />
              </div>
            )}
            {(documentViewMode === 'markdown' || documentViewMode === 'split') && (
              <div className="document-pane markdown-pane">
                <MarkdownViewer
                  fileName={currentPdfName}
                  markdown={ocrMarkdown}
                  onChange={setOcrMarkdown}
                  status={ocrStatus}
                  error={ocrError}
                  isRunning={isOcrRunning}
                  hasPdf={Boolean(pdfData)}
                  onRunOcr={runOcrToMarkdown}
                  onSave={saveCurrentOcrMarkdown}
                  onCopy={copyOcrMarkdown}
                  onDownload={downloadOcrMarkdown}
                  translatedMarkdown={translatedMarkdown}
                  translationStatus={markdownTranslateStatus}
                  translationError={markdownTranslateError}
                  isTranslating={isMarkdownTranslating}
                  targetLanguage={lastLang}
                  targetLanguages={getAiSettings().targetLanguages || ['日本語', 'English']}
                  onTranslate={handleTranslateMarkdown}
                />
              </div>
            )}
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

      {prefetchProgress && (
        <div className={`prefetch-toast ${prefetchProgress.complete ? 'complete' : ''}`}>
          <RefreshCw size={13} className={prefetchProgress.complete ? '' : 'spinning'} />
          {prefetchProgress.complete
            ? `PDF蜷梧悄螳御ｺ・(${prefetchProgress.total}莉ｶ)`
            : `PDF繧貞酔譛滉ｸｭ ${prefetchProgress.done}/${prefetchProgress.total}`}
        </div>
      )}
    </div>
  );
}

