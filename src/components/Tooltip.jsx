import { useEffect, useState, useRef } from 'preact/hooks';
import { Sparkles, X, Copy, Check, Languages, ChevronDown } from 'lucide-preact';
import { Marked } from 'marked';
import { getAiSettings } from '../services/ai';

const marked = new Marked();

export default function Tooltip({ text, currentTerm, position, isVisible, onClose, onRequestExplanation, onRequestTranslation, onSwitchLanguage, lastLang }) {
  const tooltipRef = useRef(null);
  const [offset, setOffset] = useState({ x: 15, y: 15 });
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [htmlContent, setHtmlContent] = useState('');
  const [copied, setCopied] = useState(false);
  const [showLangs, setShowLangs] = useState(false);
  const [targetLanguages, setTargetLanguages] = useState([]);
  const [hasDragged, setHasDragged] = useState(false);

  useEffect(() => {
    const settings = getAiSettings();
    setTargetLanguages(settings.targetLanguages || []);
  }, [isVisible]);

  useEffect(() => {
    if (text && text !== 'loading') {
      setHtmlContent(marked.parse(text));
    } else {
      setHtmlContent('');
    }
    setCopied(false);
  }, [text]);

  useEffect(() => {
    if (!isVisible) {
      setDragOffset({ x: 0, y: 0 });
      setHasDragged(false);
    }
  }, [isVisible, currentTerm]);

  useEffect(() => {
    if (tooltipRef.current && position && !isDragging && !hasDragged) {
      const rect = tooltipRef.current.getBoundingClientRect();
      let x = position.x + 15;
      let y = position.y + 15;
      if (x + rect.width > window.innerWidth) x = Math.max(10, position.x - rect.width - 20);
      if (y + rect.height > window.innerHeight) y = Math.max(10, position.y - rect.height - 20);
      setOffset({ x: x - position.x, y: y - position.y });
    }
  }, [position, isVisible, text, currentTerm, htmlContent, isDragging, hasDragged]);

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
      // Small timeout to trigger transition
      const timer = setTimeout(() => setIsActuallyVisible(true), 20);
      return () => clearTimeout(timer);
    } else {
      setIsActuallyVisible(false);
      const timer = setTimeout(() => setShouldRender(false), 300);
      return () => clearTimeout(timer);
    }
  }, [isVisible]);

  if (!shouldRender || !currentTerm) return null;

  const smoothEasing = 'cubic-bezier(0.16, 1, 0.3, 1)';

  return (
    <div
      ref={tooltipRef}
      className={`ai-tooltip ${text && text !== 'loading' ? 'wide' : ''} ${showLangs ? 'langs-open' : ''} ${isDragging ? 'is-dragging' : ''} ${isActuallyVisible ? 'active' : ''}`}
      style={{
        left: position.x + offset.x + dragOffset.x,
        top: position.y + offset.y + dragOffset.y,
        opacity: isActuallyVisible ? 1 : 0,
        transform: `translateY(${isActuallyVisible ? 0 : 10}px) scale(${isActuallyVisible ? 1 : 0.95})`,
        transition: isDragging ? 'none' : `
          opacity 0.3s ${smoothEasing},
          transform 0.4s ${smoothEasing},
          width 0.3s ${smoothEasing},
          height 0.3s ${smoothEasing}
        `.trim()
      }}
    >
      <div className="tooltip-header" onMouseDown={handleMouseDown}>
        <div className="header-left">
           <span className="ai-label">{text === 'loading' ? '処理中...' : text ? 'AI 結果' : '選択中の用語'}</span>
        </div>
        <div className="header-actions">
          {text && text !== 'loading' && (
            <button className="icon-action-btn" onClick={handleCopy} title="結果をコピー">
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
          <div className="tooltip-scroll-area">
            <div className="explanation-text markdown-body" dangerouslySetInnerHTML={{ __html: htmlContent }} />
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
      </div>
    </div>
  );
}
