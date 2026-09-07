import { useEffect, useState, useRef } from 'preact/hooks';
import { Sparkles, X, Copy, Check, Languages, ChevronDown, Volume2, Square, Loader } from 'lucide-preact';
import { getAiSettings } from '../services/ai';
import { renderMarkdown } from '../utils/markdown';

/**
 * Height reserved for a streaming answer. The panel opens at this size and the
 * text fills it (scrolling once it's full), so a growing answer never moves the
 * window; when the stream ends the panel settles to its content height from the
 * same top edge, and may expand downward if the answer is longer than this.
 */
const STREAM_RESERVE_PX = 260;

/** How close to the bottom still counts as "following the stream". */
const STICK_THRESHOLD_PX = 24;

/** Smallest box a hand-resize may drag the result panel down to. */
const MIN_SIZE = { w: 220, h: 140 };

/**
 * Speech input for an AI result: the rendered markdown's text content, so
 * headings/list bullets/code fences aren't read out as literal punctuation.
 */
function speechTextFromHtml(html) {
  if (!html) return '';
  try {
    return new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim() || '';
  } catch {
    return '';
  }
}

export default function Tooltip({ text, currentTerm, position, isVisible, isStreaming = false, onClose, onRequestExplanation, onRequestTranslation, onSwitchLanguage, lastLang, onSpeak, ttsSupported = false, speakingId = null, ttsLoadingId = null, ttsError = '' }) {
  const tooltipRef = useRef(null);
  const [offset, setOffset] = useState({ x: 15, y: 15 });
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [htmlContent, setHtmlContent] = useState('');
  const [copied, setCopied] = useState(false);
  const [showLangs, setShowLangs] = useState(false);
  const [targetLanguages, setTargetLanguages] = useState([]);
  const [hasDragged, setHasDragged] = useState(false);
  const [measuredHeight, setMeasuredHeight] = useState(null);
  // A result panel is sized to its own content (see .ai-tooltip.wide in
  // index.css: the inner box lays out at max-content, capped at 450px), so a
  // one-word translation gets a one-word box instead of a 450px banner.
  const [measuredWidth, setMeasuredWidth] = useState(null);
  // How tall the panel may grow once the answer is complete: the room between
  // its (fixed) top edge and the bottom of the viewport.
  const [availableHeight, setAvailableHeight] = useState(null);
  // A hand-dragged size, once the user has resized the panel: from then on it
  // keeps that exact box (the content-fit sizing above stops applying) until
  // the tooltip is opened on another selection, or the grip is double-clicked.
  const [userSize, setUserSize] = useState(null);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef(null);
  const measureRef = useRef(null);
  const scrollAreaRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const placementLockedRef = useRef(false);

  const isResult = Boolean(text) && text !== 'loading';
  // The loading panel is not the thing being reserved for: only an answer that
  // is actually rendering tokens gets the fixed box and the placement lock.
  const isStreamingResult = isStreaming && isResult;
  const streamReservePx = () => Math.min(STREAM_RESERVE_PX, Math.max(160, window.innerHeight - 40));

  useEffect(() => {
    const settings = getAiSettings();
    setTargetLanguages(settings.targetLanguages || []);
  }, [isVisible]);

  useEffect(() => {
    if (text && text !== 'loading') {
      setHtmlContent(renderMarkdown(text));
    } else {
      setHtmlContent('');
    }
    setCopied(false);
  }, [text]);

  useEffect(() => {
    if (isVisible) {
      setDragOffset({ x: 0, y: 0 });
      setHasDragged(false);
      setUserSize(null);
    }
  }, [isVisible, currentTerm]);

  // A new request (back to the idle/loading panel) may be placed freshly; a
  // running answer keeps the spot its first token got. Declared before the
  // placement effect so the reset lands in the same commit.
  useEffect(() => {
    if (!text || text === 'loading') placementLockedRef.current = false;
  }, [text, currentTerm, isVisible]);

  useEffect(() => {
    if (!tooltipRef.current || !position || isDragging || hasDragged) return;
    // The answer is placed once and then left alone: recomputing per token is
    // what made the panel crawl up the page as the text grew.
    if (placementLockedRef.current) return;

    const toolRect = tooltipRef.current.getBoundingClientRect();
    const targetRect = position;
    // While an answer streams in, place the panel as if it were already at its
    // full streaming size and let the text fill that reserved box, so no token
    // can shift it. The reserve is also what caps its height until the answer
    // is complete (--tooltip-max-height below). The loading panel is placed
    // normally: it is still the wrong size to lock a position to.
    const height = isStreamingResult ? streamReservePx() : toolRect.height;

    let preferredX = targetRect.left + (targetRect.width / 2) - (toolRect.width / 2);
    let preferredY = targetRect.top - height - 15;

    if (preferredY < 10) {
      preferredY = targetRect.bottom + 15;
    }

    preferredX = Math.max(10, Math.min(preferredX, window.innerWidth - toolRect.width - 10));
    preferredY = Math.max(10, Math.min(preferredY, window.innerHeight - height - 10));

    setOffset({
      x: preferredX - targetRect.left,
      y: preferredY - targetRect.top
    });
    // Whatever room is left below the panel's top edge is how tall it may grow
    // once the answer is complete — it expands downward from a fixed top
    // instead of moving.
    setAvailableHeight(Math.max(160, window.innerHeight - preferredY - 10));
    if (isStreamingResult) placementLockedRef.current = true;
  }, [position, isVisible, text, currentTerm, htmlContent, isDragging, hasDragged, isStreamingResult]);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isDragging) return;
      setHasDragged(true);
      setDragOffset(prev => ({
        x: prev.x + e.movementX,
        y: prev.y + e.movementY
      }));
    };
    const handleMouseUp = () => setIsDragging(false);

    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const handleMouseDown = (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button') || e.target.closest('.lang-menu')) return;

    e.stopPropagation();
    setIsDragging(true);
  };

  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (e) => {
      const start = resizeStartRef.current;
      if (!start) return;
      // Clamped to the room right of / below the panel's own top-left corner,
      // so a resize can't push the panel off screen.
      const maxW = Math.max(MIN_SIZE.w, window.innerWidth - start.left - 10);
      const maxH = Math.max(MIN_SIZE.h, window.innerHeight - start.top - 10);
      setUserSize({
        w: Math.min(maxW, Math.max(MIN_SIZE.w, start.w + (e.clientX - start.x))),
        h: Math.min(maxH, Math.max(MIN_SIZE.h, start.h + (e.clientY - start.y)))
      });
    };
    const handleMouseUp = () => setIsResizing(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  const handleResizeStart = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = tooltipRef.current?.getBoundingClientRect();
    if (!rect) return;
    resizeStartRef.current = {
      x: e.clientX, y: e.clientY,
      w: rect.width, h: rect.height,
      left: rect.left, top: rect.top
    };
    setUserSize({ w: rect.width, h: rect.height });
    setIsResizing(true);
  };

  const handleCopy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const [shouldRender, setShouldRender] = useState(isVisible);
  const [isActuallyVisible, setIsActuallyVisible] = useState(false);

  useEffect(() => {
    if (isVisible) {
      setShouldRender(true);
      const timer = setTimeout(() => setIsActuallyVisible(true), 20);
      return () => clearTimeout(timer);
    } else {
      setIsActuallyVisible(false);
      const timer = setTimeout(() => setShouldRender(false), 300);
      return () => clearTimeout(timer);
    }
  }, [isVisible]);

  // A fresh answer starts following again, however the last one was left.
  useEffect(() => {
    stickToBottomRef.current = true;
  }, [currentTerm, isStreaming]);

  // Once the answer is taller than the panel, keep the newest streamed text in
  // view instead of leaving the user staring at the first paragraph -- but only
  // while the view is still at the bottom. Scrolling up to re-read something
  // detaches it until the user scrolls back down.
  const handleScrollAreaScroll = () => {
    const area = scrollAreaRef.current;
    if (!area) return;
    stickToBottomRef.current = area.scrollHeight - area.scrollTop - area.clientHeight <= STICK_THRESHOLD_PX;
  };

  useEffect(() => {
    if (!isStreaming || !stickToBottomRef.current) return;
    const area = scrollAreaRef.current;
    if (area) area.scrollTop = area.scrollHeight;
  }, [htmlContent, isStreaming]);

  useEffect(() => {
    if (measureRef.current && shouldRender) {
      const obs = new ResizeObserver((entries) => {
        for (let entry of entries) {
          setMeasuredHeight(entry.contentRect.height);
          setMeasuredWidth(entry.contentRect.width);
        }
      });
      obs.observe(measureRef.current);
      return () => obs.disconnect();
    }
  }, [shouldRender]);

  if (!shouldRender || !currentTerm) return null;

  const smoothEasing = 'cubic-bezier(0.16, 1, 0.3, 1)';

  // The header's speak button reads whatever the tooltip is currently
  // showing: the selection while idle, the AI result once there is one. It
  // stays in the header (rather than joining the idle action row) because a
  // third button doesn't fit the 300px tooltip without wrapping the labels.
  const speechTarget = text
    ? { id: 'result', value: speechTextFromHtml(htmlContent), title: '結果を読み上げ' }
    : { id: 'selection', value: currentTerm, title: '選択テキストを読み上げ' };

  const speakIcon = (id) => {
    if (ttsLoadingId === id) return <Loader size={14} className="tts-spin" />;
    if (speakingId === id) return <Square size={14} />;
    return <Volume2 size={14} />;
  };

  return (
    <div
      ref={tooltipRef}
      className={`ai-tooltip ${isResult ? 'wide' : ''} ${isStreamingResult ? 'is-streaming' : ''} ${text === 'loading' ? 'loading-state' : ''} ${showLangs ? 'langs-open' : ''} ${userSize ? 'is-resized' : ''} ${isResizing ? 'is-resizing' : ''} ${isDragging ? 'is-dragging' : ''} ${isActuallyVisible ? 'active' : ''}`}
      style={{
        left: position.x + offset.x + dragOffset.x,
        top: position.y + offset.y + dragOffset.y,
        opacity: isActuallyVisible ? 1 : 0,
        // A finished result is content-sized; the idle/loading panels keep
        // their fixed widths from index.css, and a streaming one stays at the
        // full 450px so the text doesn't re-wrap on every token. +2px covers
        // the panel's own border (everything here is border-box), so the
        // measured inner box isn't clipped by the width taken from it.
        // A hand-resized panel keeps exactly the box the user dragged out; the
        // content caps stop applying and the answer scrolls inside it.
        width: userSize
          ? `${userSize.w}px`
          : isResult && !isStreamingResult && measuredWidth ? `${Math.ceil(measuredWidth) + 2}px` : undefined,
        maxWidth: userSize ? 'none' : undefined,
        // Caps the panel while streaming (the reserved box) and lets it use
        // the room below its fixed top edge once the answer is complete.
        '--tooltip-max-height': userSize
          ? `${userSize.h}px`
          : isStreamingResult
          ? `${streamReservePx()}px`
          : availableHeight
            ? `${availableHeight}px`
            : undefined,
        height: userSize
          ? `${userSize.h}px`
          : measuredHeight && isActuallyVisible ? `${measuredHeight}px` : 'auto',
        transform: `translateY(${isActuallyVisible ? 0 : 10}px) scale(${isActuallyVisible ? 1 : 0.95})`,
        transition: isDragging || isResizing ? 'none' : `
          opacity 0.3s ${smoothEasing},
          transform 0.4s ${smoothEasing},
          width 0.3s ${smoothEasing},
          height 0.4s ${smoothEasing},
          left 0.4s ${smoothEasing},
          top 0.4s ${smoothEasing}
        `.trim()
      }}
    >
      <div ref={measureRef} className="tooltip-inner-measure">
        <div className="tooltip-header" onMouseDown={handleMouseDown}>
          <div className="header-left">
            <span className="ai-label">
              {text === 'loading' ? '処理中...' : text ? (isStreaming ? '生成中...' : 'AI 結果') : '選択中の文章'}
            </span>
          </div>
          <div className="header-actions">
            {ttsSupported && text !== 'loading' && (
              <button
                className={`icon-action-btn ${speakingId === speechTarget.id ? 'is-speaking' : ''}`}
                onClick={() => onSpeak?.(speechTarget.value, speechTarget.id)}
                // Reading a half-generated answer aloud isn't useful; the
                // buttons stay in place (rather than appearing at the end) so
                // the header doesn't reflow when the stream finishes.
                disabled={isStreaming}
                title={speakingId === speechTarget.id ? '読み上げを停止' : speechTarget.title}
              >
                {speakIcon(speechTarget.id)}
              </button>
            )}
            {isResult && (
              <button className="icon-action-btn" onClick={handleCopy} disabled={isStreaming} title="結果をコピー">
                {copied ? <Check size={14} color="#10b981" /> : <Copy size={14} />}
              </button>
            )}
            <button onClick={onClose} className="icon-action-btn close"><X size={14} /></button>
          </div>
        </div>

        <div className="tooltip-content">
          {text === 'loading' ? (
            <div className="loading-spinner">
              <div className="spinner"></div>
              <span>解析中...</span>
            </div>
          ) : text ? (
            <div className="tooltip-scroll-area" ref={scrollAreaRef} onScroll={handleScrollAreaScroll}>
              <div
                className={`explanation-text markdown-body ${isStreaming ? 'is-streaming' : ''}`}
                dangerouslySetInnerHTML={{ __html: htmlContent }}
              />
            </div>
          ) : (
            <div className="tooltip-idle">
              <div className="term-display">
                <strong>{currentTerm}</strong>
              </div>
              <div className="tooltip-actions">
                <button onClick={onRequestExplanation} className="explain-action-btn">
                  <Sparkles size={14} /> AI で解説
                </button>

                <div className="lang-split-container">
                  <button
                    className="lang-main-btn"
                    onClick={() => onRequestTranslation(lastLang)}
                    title={`${lastLang}で翻訳`}
                  >
                    <Languages size={14} /> {lastLang}
                  </button>
                  <button
                    className={`lang-toggle-btn ${showLangs ? 'active' : ''}`}
                    onClick={() => setShowLangs(!showLangs)}
                    title="言語を切り替え"
                  >
                    <ChevronDown size={14} />
                  </button>

                  {showLangs && (
                    <div className="lang-menu">
                      {targetLanguages.map(lang => (
                        <button
                          key={lang}
                          className="lang-item"
                          onClick={() => {
                            onSwitchLanguage(lang);
                            setShowLangs(false);
                          }}
                        >
                          {lang}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {ttsError && <div className="tooltip-tts-error">{ttsError}</div>}
        </div>
      </div>

      {isResult && (
        <div
          className="tooltip-resize-handle"
          onMouseDown={handleResizeStart}
          onDblClick={() => setUserSize(null)}
          title="ドラッグでサイズ変更 / ダブルクリックで自動サイズに戻す"
        />
      )}
    </div>
  );
}
