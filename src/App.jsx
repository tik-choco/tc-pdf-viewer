import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import Sidebar from './components/Sidebar';
import PdfViewer from './components/PdfViewer';
import MarkdownViewer from './components/MarkdownViewer';
import Tooltip from './components/Tooltip';
import Chat from './components/Chat';
import { loadPdf, renamePdf, getPdfList as loadPdfList, prefetchPdf, saveOcrMarkdown, saveOcrMarkdownSummary, getOcrMarkdown, getOcrMarkdownIndexSnapshot, saveTranslatedMarkdown, getTranslatedMarkdown, getTranslatedMarkdownIndexSnapshot } from './services/storage';
import { scheduleDriveExport } from './services/driveExport';
import { extractText, renderPdfPagesToImages } from './services/pdf';
import { explainText, translateText, translateMarkdown, getAiSettings, saveAiSettings, ocrImagesToMarkdown, summarizeOcrMarkdown } from './services/ai';
import { PanelLeftClose, PanelLeftOpen, MessageCircle, RefreshCw, FileText, X } from 'lucide-preact';
import { useSync } from './hooks/useSync';
import { useNetworkConsumerConnection } from './hooks/useNetworkConsumerConnection';
import { useNetworkProvider } from './hooks/useNetworkProvider';
import { SyncPanel } from './components/SyncPanel';
import { DiffConfirmPanel } from './components/DiffConfirmPanel';
import { QRPanel } from './components/QRPanel';

const PREFETCH_CONCURRENCY = 3;
const AI_JOB_RETENTION_MS = 8000;

function isPendingAiJob(job) {
  return job.status === 'queued' || job.status === 'running' || job.status === 'cancelling';
}

function isVisibleAiJob(job) {
  return ['queued', 'running', 'cancelling', 'complete', 'failed', 'cancelled'].includes(job.status);
}

function isSameAiJob(job, draft) {
  return job.type === draft.type
    && job.pdfName === draft.pdfName
    && (job.language || '') === (draft.language || '');
}

function getAiJobKindLabel(job) {
  if (job.type === 'summary') return 'Summary';
  return job.type === 'translation' ? 'Translate' : 'OCR';
}

function getAiJobTitle(job) {
  const language = job.language ? ` to ${job.language}` : '';
  return `${getAiJobKindLabel(job)}${language}: ${job.pdfName}`;
}

function getAiJobStatusText(job) {
  if (!job) return '';
  if (job.status === 'queued') return 'Queued';
  if (job.status === 'cancelling') return 'Cancelling...';
  if (job.status === 'cancelled') return 'Cancelled';
  if (job.status === 'failed') return `Failed: ${job.error || 'Unknown error'}`;
  if (job.status === 'complete') return job.progress || 'Done';
  return job.progress || 'Running...';
}

function isCancelError(err) {
  return err?.name === 'AbortError' || /cancelled|canceled|キャンセル/i.test(err?.message || '');
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    const error = new Error('Request cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

function findLatestVisibleAiJob(jobs, { type, pdfName, language }) {
  if (!pdfName) return null;
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    const job = jobs[i];
    if (!isVisibleAiJob(job)) continue;
    if (job.type !== type || job.pdfName !== pdfName) continue;
    if (language !== undefined && (job.language || '') !== (language || '')) continue;
    return job;
  }
  return null;
}

async function prefetchPdfsWithLimit(files, onProgress) {
  let nextIndex = 0;
  let completed = 0;

  const workers = Array.from(
    { length: Math.min(PREFETCH_CONCURRENCY, files.length) },
    async () => {
      while (nextIndex < files.length) {
        const file = files[nextIndex];
        nextIndex += 1;
        await prefetchPdf(file.name);
        completed += 1;
        onProgress(completed);
      }
    }
  );

  await Promise.all(workers);
}

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
  const [ocrMarkdown, setOcrMarkdown] = useState('');
  const [ocrStatus, setOcrStatus] = useState('');
  const [ocrError, setOcrError] = useState('');
  const [hasSavedOcrMarkdown, setHasSavedOcrMarkdown] = useState(false);
  const [translatedMarkdown, setTranslatedMarkdown] = useState('');
  const [markdownTranslateStatus, setMarkdownTranslateStatus] = useState('');
  const [markdownTranslateError, setMarkdownTranslateError] = useState('');
  const [aiJobs, setAiJobs] = useState([]);
  const [markdownModeRequest, setMarkdownModeRequest] = useState({ mode: 'preview', id: 0 });

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
  const pdfTextCacheRef = useRef(new Map());
  const pdfTextRequestRef = useRef(0);
  const resizeFrameRef = useRef(null);
  const pendingResizeRef = useRef(null);
  const aiJobsRef = useRef([]);
  const activeAiJobRef = useRef(null);
  const aiJobControllersRef = useRef(new Map());
  const nextAiJobIdRef = useRef(1);
  const currentPdfNameRef = useRef(currentPdfName);
  const lastLangRef = useRef(lastLang);
  const summaryGenerationRef = useRef(new Set());

  useEffect(() => {
    currentPdfNameRef.current = currentPdfName;
  }, [currentPdfName]);

  useEffect(() => {
    lastLangRef.current = lastLang;
  }, [lastLang]);

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
      // Reconcile the tc-storage-facing drive mirror with whatever the
      // library looks like now (initial mount and after peer sync updates).
      scheduleDriveExport();
    };
    loadData();

    const handleSyncUpdate = () => {
      loadData();
    };
    window.addEventListener('sync-data-updated', handleSyncUpdate);
    return () => window.removeEventListener('sync-data-updated', handleSyncUpdate);
  }, []);

  const currentAiSettings = getAiSettings();

  const syncState = useMemo(() => ({
    files: pdfs,
    explanations: JSON.parse(localStorage.getItem('mist_explanations_index') || '{}'),
    ocrMarkdown: ocrMarkdownIndex,
    translatedMarkdown: translatedMarkdownIndex,
    aiSettings: currentAiSettings,
    lastLang: lastLang,
    lastPdf: currentPdfName,
    customFolders: customFolders
  }), [pdfs, ocrMarkdownIndex, translatedMarkdownIndex, lastLang, currentPdfName, customFolders, currentAiSettings]);

  // Eagerly maintains the mistllm consumer connection (when backend === 'mistllm')
  // and the LLM network provider role (when enabled), independent of whether
  // SettingsPanel is currently mounted — see hooks/useNetworkConsumerConnection.js
  // and hooks/useNetworkProvider.js.
  useNetworkConsumerConnection({
    backend: currentAiSettings.backend,
    roomId: currentAiSettings.mistllmRoomId,
  });
  useNetworkProvider({
    networkProviderEnabled: currentAiSettings.networkProviderEnabled,
    mistllmRoomId: currentAiSettings.mistllmRoomId,
  });

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
      scheduleDriveExport();

      // 繝舌ャ繧ｯ繧ｰ繝ｩ繧ｦ繝ｳ繝峨〒蜈ｨPDF繧恥refetch・・on-blocking縲・㍾隍・せ繧ｭ繝・・・・
      const filesToFetch = nextState.files ?? [];
      if (filesToFetch.length > 0) {
        const signature = filesToFetch.map(f => f.cid).join(',');
        if (signature !== lastPrefetchSignatureRef.current) {
          lastPrefetchSignatureRef.current = signature;
          const total = filesToFetch.length;
          setPrefetchProgress({ done: 0, total, complete: false });
          prefetchPdfsWithLimit(filesToFetch, (done) => {
              setPrefetchProgress(prev => {
                if (!prev) return null;
                if (done >= total) {
                  setTimeout(() => setPrefetchProgress(null), 2000);
                  // Synced PDF bytes are now in the local block store, so the
                  // drive mirror can pick up files it had to defer earlier.
                  scheduleDriveExport();
                  return { done, total, complete: true };
                }
                return { done, total, complete: false };
              });
          });
        }
      }

      if (nextState.lastPdf && nextState.lastPdf !== currentPdfName) {
        handleSelectPdf(nextState.lastPdf);
      } else if (currentPdfName) {
        const ocrContent = (nextState.ocrMarkdown || {})[currentPdfName]?.content ?? null;
        setOcrMarkdown(ocrContent ?? '');
        setHasSavedOcrMarkdown(ocrContent !== null);
        if (ocrContent) {
          setOcrStatus('保存済みMarkdown');
          ensureOcrSummaryInBackground(currentPdfName, ocrContent);
        }

        const translationContent = (nextState.translatedMarkdown || {})[currentPdfName]?.[lastLangRef.current]?.content ?? null;
        setTranslatedMarkdown(translationContent ?? '');
        if (translationContent) setMarkdownTranslateStatus(`Loaded ${lastLangRef.current} translation`);
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

  const updateAiJobs = useCallback((updater) => {
    const nextJobs = typeof updater === 'function'
      ? updater(aiJobsRef.current)
      : updater;
    aiJobsRef.current = nextJobs;
    setAiJobs(nextJobs);
    return nextJobs;
  }, []);

  const markAiJob = useCallback((jobId, patch) => {
    updateAiJobs(jobs => jobs.map(job => (
      job.id === jobId
        ? { ...job, ...patch, updatedAt: Date.now() }
        : job
    )));
  }, [updateAiJobs]);

  const scheduleAiJobRemoval = useCallback((jobId) => {
    window.setTimeout(() => {
      updateAiJobs(jobs => jobs.filter(job => (
        job.id !== jobId || isPendingAiJob(job)
      )));
    }, AI_JOB_RETENTION_MS);
  }, [updateAiJobs]);

  const generateAndSaveOcrSummary = useCallback(async (pdfName, markdown, signal = null) => {
    if (!pdfName || !markdown?.trim()) return '';

    const summary = await summarizeOcrMarkdown(markdown, { fileName: pdfName, signal });
    if (!summary?.trim()) return '';

    await saveOcrMarkdownSummary(pdfName, summary.trim());
    setOcrMarkdownIndex(getOcrMarkdownIndexSnapshot());
    window.dispatchEvent(new CustomEvent('sync-data-updated'));
    return summary.trim();
  }, []);

  const ensureOcrSummaryInBackground = useCallback((pdfName, markdown) => {
    if (!pdfName || !markdown?.trim()) return;

    const currentEntry = getOcrMarkdownIndexSnapshot()[pdfName];
    if (currentEntry?.summary || summaryGenerationRef.current.has(pdfName)) return;

    summaryGenerationRef.current.add(pdfName);
    const jobId = nextAiJobIdRef.current;
    nextAiJobIdRef.current += 1;
    updateAiJobs(jobs => [
      ...jobs,
      {
        id: jobId,
        type: 'summary',
        pdfName,
        status: 'running',
        progress: 'Generating summary...',
        error: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    generateAndSaveOcrSummary(pdfName, markdown)
      .then(() => {
        markAiJob(jobId, {
          status: 'complete',
          progress: 'Summary saved',
        });
        scheduleAiJobRemoval(jobId);
      })
      .catch((err) => {
        if (isCancelError(err)) {
          markAiJob(jobId, {
            status: 'cancelled',
            progress: 'Cancelled',
            error: '',
          });
        } else {
          console.warn('Failed to generate OCR summary in background:', err);
          markAiJob(jobId, {
            status: 'failed',
            progress: 'Summary failed',
            error: err.message || String(err),
          });
        }
        scheduleAiJobRemoval(jobId);
      })
      .finally(() => {
        summaryGenerationRef.current.delete(pdfName);
      });
  }, [generateAndSaveOcrSummary, markAiJob, scheduleAiJobRemoval, updateAiJobs]);

  const runOcrJob = useCallback(async (job, signal) => {
    markAiJob(job.id, {
      progress: 'Loading PDF...',
      done: 0,
      total: null,
    });

    const data = await loadPdf(job.pdfName);
    throwIfCancelled(signal);
    const images = await renderPdfPagesToImages(data, {
      scale: 2,
      signal,
      onProgress: ({ done, total }) => {
        markAiJob(job.id, {
          progress: `Rendering PDF pages... ${done}/${total}`,
          done,
          total,
        });
        if (currentPdfNameRef.current === job.pdfName) {
          setOcrStatus(`Rendering PDF pages... ${done}/${total}`);
        }
      },
    });

    const pageMarkdown = [];
    for (let i = 0; i < images.length; i += 1) {
      throwIfCancelled(signal);
      const progress = `Running LLM OCR... ${i + 1}/${images.length}`;
      markAiJob(job.id, {
        progress,
        done: i,
        total: images.length,
      });
      if (currentPdfNameRef.current === job.pdfName) {
        setOcrStatus(progress);
      }

      const markdown = await ocrImagesToMarkdown([images[i]], { fileName: job.pdfName, signal });
      throwIfCancelled(signal);
      pageMarkdown.push(markdown);
      const partialMarkdown = pageMarkdown.join('\n\n');

      markAiJob(job.id, {
        progress: `Running LLM OCR... ${i + 1}/${images.length}`,
        done: i + 1,
        total: images.length,
      });
      if (currentPdfNameRef.current === job.pdfName) {
        setOcrMarkdown(partialMarkdown);
        setHasSavedOcrMarkdown(false);
      }
    }

    const finalMarkdown = pageMarkdown.join('\n\n');
    await saveOcrMarkdown(job.pdfName, finalMarkdown);
    setOcrMarkdownIndex(getOcrMarkdownIndexSnapshot());
    window.dispatchEvent(new CustomEvent('sync-data-updated'));

    markAiJob(job.id, {
      progress: 'Generating summary...',
      done: images.length,
      total: images.length,
    });
    if (currentPdfNameRef.current === job.pdfName) {
      setOcrStatus('Generating summary...');
    }
    try {
      await generateAndSaveOcrSummary(job.pdfName, finalMarkdown, signal);
    } catch (err) {
      if (isCancelError(err)) throw err;
      console.warn('Failed to generate OCR summary:', err);
    }

    if (currentPdfNameRef.current === job.pdfName) {
      setOcrMarkdown(finalMarkdown);
      setHasSavedOcrMarkdown(true);
      setOcrStatus('Saved');
    }

    markAiJob(job.id, {
      status: 'complete',
      progress: 'OCR saved',
      done: images.length,
      total: images.length,
    });
  }, [generateAndSaveOcrSummary, markAiJob]);

  const runTranslationJob = useCallback(async (job, signal) => {
    const language = job.language || lastLangRef.current || '日本語';
    markAiJob(job.id, {
      progress: `Translating to ${language}...`,
      done: 0,
      total: null,
    });

    const translated = await translateMarkdown(job.markdown, language, ({ done, total, translatedMarkdown }) => {
      const progress = `Translating to ${language}... ${done}/${total}`;
      markAiJob(job.id, {
        progress,
        done,
        total,
      });
      if (currentPdfNameRef.current === job.pdfName && lastLangRef.current === language) {
        setTranslatedMarkdown(translatedMarkdown);
        setMarkdownTranslateStatus(progress);
      }
    }, { signal });
    throwIfCancelled(signal);

    await saveTranslatedMarkdown(job.pdfName, language, translated);
    setTranslatedMarkdownIndex(getTranslatedMarkdownIndexSnapshot());
    window.dispatchEvent(new CustomEvent('sync-data-updated'));

    if (currentPdfNameRef.current === job.pdfName && lastLangRef.current === language) {
      setTranslatedMarkdown(translated);
      setMarkdownTranslateStatus(`Translated to ${language}`);
    }

    markAiJob(job.id, {
      status: 'complete',
      progress: `Translated to ${language}`,
    });
  }, [markAiJob]);

  const processAiQueue = useCallback(() => {
    if (activeAiJobRef.current) return;

    const nextJob = aiJobsRef.current.find(job => job.status === 'queued');
    if (!nextJob) return;

    const controller = new AbortController();
    activeAiJobRef.current = nextJob.id;
    aiJobControllersRef.current.set(nextJob.id, controller);
    markAiJob(nextJob.id, {
      status: 'running',
      progress: 'Starting...',
      startedAt: Date.now(),
      error: '',
    });

    const runner = nextJob.type === 'translation' ? runTranslationJob : runOcrJob;
    runner(nextJob, controller.signal)
      .catch((err) => {
        const message = err.message || String(err);
        if (isCancelError(err)) {
          markAiJob(nextJob.id, {
            status: 'cancelled',
            progress: 'Cancelled',
            error: '',
          });
          if (nextJob.type === 'ocr' && currentPdfNameRef.current === nextJob.pdfName) {
            setOcrStatus('Cancelled');
          }
          if (nextJob.type === 'translation'
            && currentPdfNameRef.current === nextJob.pdfName
            && lastLangRef.current === nextJob.language) {
            setMarkdownTranslateStatus('Translation cancelled');
          }
        } else {
          markAiJob(nextJob.id, {
            status: 'failed',
            progress: 'Failed',
            error: message,
          });

          if (nextJob.type === 'ocr' && currentPdfNameRef.current === nextJob.pdfName) {
            setOcrError(message);
            setOcrStatus('Failed');
          }
          if (nextJob.type === 'translation'
            && currentPdfNameRef.current === nextJob.pdfName
            && lastLangRef.current === nextJob.language) {
            setMarkdownTranslateError(message);
            setMarkdownTranslateStatus('Translation failed');
          }
        }
      })
      .finally(() => {
        activeAiJobRef.current = null;
        aiJobControllersRef.current.delete(nextJob.id);
        scheduleAiJobRemoval(nextJob.id);
        processAiQueue();
      });
  }, [markAiJob, runOcrJob, runTranslationJob, scheduleAiJobRemoval]);

  const enqueueAiJob = useCallback((draft) => {
    const existingJob = aiJobsRef.current.find(job => isPendingAiJob(job) && isSameAiJob(job, draft));
    if (existingJob) {
      processAiQueue();
      return existingJob;
    }

    const job = {
      ...draft,
      id: nextAiJobIdRef.current,
      status: 'queued',
      progress: 'Queued',
      error: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    nextAiJobIdRef.current += 1;

    updateAiJobs(jobs => [
      ...jobs.filter(item => !(item.status === 'failed' && isSameAiJob(item, draft))),
      job,
    ]);
    window.setTimeout(processAiQueue, 0);
    return job;
  }, [processAiQueue, updateAiJobs]);

  const cancelAiJob = useCallback((jobId) => {
    const job = aiJobsRef.current.find(item => item.id === jobId);
    if (!job || !isPendingAiJob(job)) return;

    if (job.status === 'queued') {
      markAiJob(jobId, {
        status: 'cancelled',
        progress: 'Cancelled',
        error: '',
      });
      scheduleAiJobRemoval(jobId);
      return;
    }

    markAiJob(jobId, {
      status: 'cancelling',
      progress: 'Cancelling...',
      error: '',
    });
    aiJobControllersRef.current.get(jobId)?.abort();
  }, [markAiJob, scheduleAiJobRemoval]);

  const currentOcrJob = useMemo(() => (
    findLatestVisibleAiJob(aiJobs, {
      type: 'ocr',
      pdfName: currentPdfName,
    })
  ), [aiJobs, currentPdfName]);

  const currentTranslationJob = useMemo(() => (
    findLatestVisibleAiJob(aiJobs, {
      type: 'translation',
      pdfName: currentPdfName,
      language: lastLang,
    })
  ), [aiJobs, currentPdfName, lastLang]);

  const isCurrentOcrBusy = currentOcrJob ? isPendingAiJob(currentOcrJob) : false;
  const isCurrentTranslationBusy = currentTranslationJob ? isPendingAiJob(currentTranslationJob) : false;
  const currentOcrStatus = currentOcrJob ? getAiJobStatusText(currentOcrJob) : ocrStatus;
  const currentOcrError = currentOcrJob?.status === 'failed' ? currentOcrJob.error : ocrError;
  const currentTranslationStatus = currentTranslationJob ? getAiJobStatusText(currentTranslationJob) : markdownTranslateStatus;
  const currentTranslationError = currentTranslationJob?.status === 'failed'
    ? currentTranslationJob.error
    : markdownTranslateError;
  const visibleAiJobs = useMemo(() => aiJobs.filter(isVisibleAiJob).slice(-4), [aiJobs]);
  const runningAiJob = useMemo(() => aiJobs.find(job => job.status === 'running'), [aiJobs]);
  const queuedAiJobCount = useMemo(() => aiJobs.filter(job => job.status === 'queued').length, [aiJobs]);

  const containerRef = useRef(null);

  useEffect(() => {
    const flushResize = () => {
      resizeFrameRef.current = null;
      const pending = pendingResizeRef.current;
      if (!pending) return;

      if (pending.sidebarWidth !== undefined) {
        setSidebarWidth(pending.sidebarWidth);
      }
      if (pending.chatWidth !== undefined) {
        setChatWidth(pending.chatWidth);
      }
      pendingResizeRef.current = null;
    };

    const scheduleResize = (nextSize) => {
      pendingResizeRef.current = {
        ...pendingResizeRef.current,
        ...nextSize,
      };
      if (resizeFrameRef.current !== null) return;
      resizeFrameRef.current = window.requestAnimationFrame(flushResize);
    };

    const handleMouseMove = (e) => {
      if (isResizingSidebar) {
        const newWidth = Math.max(200, Math.min(600, e.clientX));
        scheduleResize({ sidebarWidth: newWidth });
      } else if (isResizingChat) {
        const newWidth = Math.max(250, Math.min(800, window.innerWidth - e.clientX));
        scheduleResize({ chatWidth: newWidth });
      }
    };

    const handleMouseUp = () => {
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
      }
      flushResize();
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
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
    };
  }, [isResizingSidebar, isResizingChat]);

  const handleSelectPdf = async (name, language = lastLang) => {
    const requestId = ++pdfTextRequestRef.current;
    setIsPdfMasking(true);
    setCurrentPdfName(name);
    setPdfData(null);
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
        if (requestId !== pdfTextRequestRef.current) return;
        setPdfData(data);
        setIsTooltipVisible(false);
        const savedMarkdown = await getOcrMarkdown(name);
        if (requestId !== pdfTextRequestRef.current) return;
        if (savedMarkdown) {
          setOcrMarkdown(savedMarkdown);
          setOcrStatus('菫晏ｭ俶ｸ医∩Markdown');
          setHasSavedOcrMarkdown(true);
          ensureOcrSummaryInBackground(name, savedMarkdown);
        }

        const savedTranslation = await getTranslatedMarkdown(name, language);
        if (requestId !== pdfTextRequestRef.current) return;
        if (savedTranslation) {
          setTranslatedMarkdown(savedTranslation);
          setMarkdownTranslateStatus(`Loaded ${language} translation`);
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

  useEffect(() => {
    if (!chatOpen || !pdfData || !currentPdfName || pdfContent) return;

    const cachedText = pdfTextCacheRef.current.get(currentPdfName);
    if (cachedText !== undefined) {
      setPdfContent(cachedText);
      return;
    }

    let cancelled = false;
    const requestId = pdfTextRequestRef.current;

    const run = async () => {
      const text = await extractText(pdfData);
      if (cancelled || requestId !== pdfTextRequestRef.current) return;
      pdfTextCacheRef.current.set(currentPdfName, text);
      setPdfContent(text);
    };

    if ('requestIdleCallback' in window) {
      const idleId = window.requestIdleCallback(run, { timeout: 2000 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(idleId);
      };
    }

    const timeoutId = window.setTimeout(run, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [chatOpen, currentPdfName, pdfData, pdfContent]);

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
      const contextMarkdown = ocrMarkdown || await getOcrMarkdown(currentPdfName) || '';
      const explanation = await explainText(lastHoverText, {
        contextMarkdown,
        pdfName: currentPdfName || '',
      });
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
    if (!pdfData || !currentPdfName) return;
    setDocumentViewMode('markdown');

    if (hasSavedOcrMarkdown && ocrMarkdown) {
      return;
    }

    await runOcrToMarkdown();
  };

  const runOcrToMarkdown = async () => {
    if (!pdfData || !currentPdfName) return;

    setDocumentViewMode(prev => prev === 'pdf' ? 'markdown' : prev);
    setOcrMarkdown('');
    setOcrError('');
    setHasSavedOcrMarkdown(false);
    setOcrStatus('Queued');
    enqueueAiJob({
      type: 'ocr',
      pdfName: currentPdfName,
    });
  };

  const saveCurrentOcrMarkdown = async () => {
    if (!currentPdfName || !ocrMarkdown || isCurrentOcrBusy) return;
    setOcrError('');
    setOcrStatus('Saving...');
    try {
      await saveOcrMarkdown(currentPdfName, ocrMarkdown);
      setOcrMarkdownIndex(getOcrMarkdownIndexSnapshot());
      setHasSavedOcrMarkdown(true);
      window.dispatchEvent(new CustomEvent('sync-data-updated'));
      setOcrStatus('Generating summary...');
      try {
        await generateAndSaveOcrSummary(currentPdfName, ocrMarkdown);
      } catch (summaryErr) {
        console.warn('Failed to generate OCR summary:', summaryErr);
      }
      setOcrStatus('Saved');
    } catch (err) {
      setOcrError(err.message || String(err));
      setOcrStatus('Save failed');
    }
  };

  const handleTranslateMarkdown = async (targetLanguage, { force = false } = {}) => {
    if (!currentPdfName || !ocrMarkdown) return;

    setMarkdownTranslateError('');
    setMarkdownTranslateStatus(`Queued translation to ${targetLanguage}`);
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
      enqueueAiJob({
        type: 'translation',
        pdfName: currentPdfName,
        language: targetLanguage,
        markdown: ocrMarkdown,
      });
    } catch (err) {
      setMarkdownTranslateError(err.message || String(err));
      setMarkdownTranslateStatus('Translation failed');
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

  const openAiJobTarget = (job) => {
    const mode = job.type === 'translation' ? 'translation' : 'preview';
    const language = job.language || lastLangRef.current;

    setDocumentViewMode('markdown');
    setMarkdownModeRequest(current => ({ mode, id: current.id + 1 }));

    if (job.type === 'translation' && language) {
      setLastLang(language);
      localStorage.setItem('mist_last_lang', language);
    }

    if (currentPdfNameRef.current !== job.pdfName) {
      handleSelectPdf(job.pdfName, language);
    }
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
        ocrMarkdownIndex={ocrMarkdownIndex}
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
                if (!ocrMarkdown && !isCurrentOcrBusy) {
                  handleOcrToMarkdown();
                } else {
                  setDocumentViewMode('markdown');
                }
              }}
              disabled={!pdfData}
              title="Markdown view"
            >
              {isCurrentOcrBusy ? <RefreshCw size={16} className="spinning" /> : <FileText size={16} />}
              Markdown
            </button>
            <button
              className={documentViewMode === 'split' ? 'active' : ''}
              onClick={() => {
                setDocumentViewMode('split');
                if (!ocrMarkdown && !isCurrentOcrBusy) {
                  runOcrToMarkdown();
                }
              }}
              disabled={!pdfData}
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
                  status={currentOcrStatus}
                  error={currentOcrError}
                  isRunning={isCurrentOcrBusy}
                  hasPdf={Boolean(pdfData)}
                  onRunOcr={runOcrToMarkdown}
                  onSave={saveCurrentOcrMarkdown}
                  onCopy={copyOcrMarkdown}
                  onDownload={downloadOcrMarkdown}
                  translatedMarkdown={translatedMarkdown}
                  translationStatus={currentTranslationStatus}
                  translationError={currentTranslationError}
                  isTranslating={isCurrentTranslationBusy}
                  targetLanguage={lastLang}
                  targetLanguages={getAiSettings().targetLanguages || ['日本語', 'English']}
                  onTranslate={handleTranslateMarkdown}
                  modeRequest={markdownModeRequest}
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
            ocrMarkdown={ocrMarkdown}
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

      {visibleAiJobs.length > 0 && (
        <div className="ai-queue-toast">
          <div className="ai-queue-header">
            <RefreshCw size={13} className={runningAiJob ? 'spinning' : ''} />
            <span>{runningAiJob ? 'AI processing' : 'AI queue'}</span>
            {queuedAiJobCount > 0 && <span className="ai-queue-count">{queuedAiJobCount} queued</span>}
          </div>
          <div className="ai-queue-list">
            {visibleAiJobs.map(job => (
              <div
                key={job.id}
                role="button"
                tabIndex={0}
                className={`ai-queue-item ${job.status}`}
                onClick={() => openAiJobTarget(job)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openAiJobTarget(job);
                  }
                }}
                title={`Open ${job.pdfName}`}
              >
                <div className="ai-queue-item-main">
                  <div className="ai-queue-item-title">{getAiJobTitle(job)}</div>
                  <div className="ai-queue-item-status">{getAiJobStatusText(job)}</div>
                </div>
                {(job.status === 'queued' || job.status === 'running') && (
                  <button
                    type="button"
                    className="ai-queue-cancel"
                    onClick={(event) => {
                      event.stopPropagation();
                      cancelAiJob(job.id);
                    }}
                    title="Cancel job"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

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

