import { useState, useMemo, useCallback, useEffect, useRef } from 'preact/hooks';
import { Document, Page, pdfjs } from 'react-pdf';
import { Download, ZoomIn as ZoomInIcon, ZoomOut as ZoomOutIcon, MoveHorizontal } from 'lucide-preact';
import { pdfJsAssetUrls } from '../services/pdfAssets';

import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
).toString();

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5.0;
const ZOOM_STEP = 0.05;

const documentOptions = {
    cMapUrl: pdfJsAssetUrls.cMapUrl,
    cMapPacked: true,
    // 非埋め込みフォントの代替システムフォント情報(fontSubstitution)をtextContent.stylesに含める
    fontExtraProperties: true,
};

// テキストレイヤーの各スパンに、キャンバス描画用に読み込まれた埋め込みフォントを適用し、
// 幅補正(scaleX)を実フォントのメトリクスで再計算する。
// pdf.js標準はフォールバックフォント(sans-serif等)で幅を合わせるため行の中間で文字位置がずれるが、
// 実際の埋め込みフォントで文字を組めば選択ハイライトが文字単位でほぼ一致する。
function refineTextLayerFonts(layerEl, textContent, scale) {
    if (!layerEl || !textContent || !scale) return;
    const children = layerEl.querySelectorAll('[role="presentation"]');
    let index = 0;
    for (const item of textContent.items) {
        if (!('str' in item)) continue;
        const child = children[index];
        index += item.str && item.hasEOL ? 2 : 1;
        if (!child || child.tagName !== 'SPAN') continue;
        if (!item.str.trim() || !item.fontName || !item.width) continue;
        const orig = child.dataset.origTransform ?? child.style.transform ?? '';
        if (orig.includes('rotate')) continue; // 回転テキストは対象外

        if (!child.dataset.origFontFamily) {
            child.dataset.origFontFamily = child.style.fontFamily || getComputedStyle(child).fontFamily;
            child.dataset.origTransform = orig;
        }

        // フォント候補: 埋め込みフォント → 代替システムフォント → pdf.jsのフォールバック
        // (未読込のフォントはブラウザが自動的に後方へフォールバックする)
        const style = textContent.styles?.[item.fontName];
        const stack = [`"${item.fontName}"`];
        if (style?.fontSubstitution) stack.push(style.fontSubstitution);
        stack.push(child.dataset.origFontFamily);
        child.style.fontFamily = stack.join(', ');

        // 目標幅はPDFデータ由来(item.width × 表示スケール)なのでDOM計測タイミングに依存しない。
        // 現在の実効フォントでの自然幅を測り、目標幅に一致するscaleXを再計算する。
        const targetWidth = item.width * scale;
        const rest = orig.replace(/scaleX\([^)]+\)\s*/, '').trim(); // scale(1/minFontSize)等は保持
        child.style.transform = rest;
        const naturalWidth = child.getBoundingClientRect().width;
        child.style.transform = naturalWidth > 0
            ? `scaleX(${targetWidth / naturalWidth}) ${rest}`.trim()
            : orig;
    }
}

function LazyPage({ pageNumber, width, scale }) {
    const containerRef = useRef(null);
    const [isVisible, setIsVisible] = useState(false);
    const textContentRef = useRef(null);

    useEffect(() => {
        const node = containerRef.current;
        if (!node) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setIsVisible(true);
                }
            },
            { root: node.closest('.pdf-pages-scroll'), rootMargin: '200px 0px' }
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    const handleGetTextSuccess = useCallback((textContent) => {
        textContentRef.current = textContent;
    }, []);

    const refine = useCallback(() => {
        const layerEl = containerRef.current?.querySelector('.react-pdf__Page__textContent');
        // width未確定時はPageがスケール1で描画されるため、1PDF単位=1pxとなる
        refineTextLayerFonts(layerEl, textContentRef.current, width ? scale : 1);
    }, [scale, width]);

    const handleRenderTextLayerSuccess = useCallback(() => {
        refine();
        document.fonts.ready.then(refine);
    }, [refine]);

    // 埋め込みフォントはキャンバス描画と並行して遅延読込されるため、
    // 読込完了のたびに補正をかけ直す(補正は冪等)
    useEffect(() => {
        document.fonts.addEventListener('loadingdone', refine);
        return () => document.fonts.removeEventListener('loadingdone', refine);
    }, [refine]);

    return (
        <div ref={containerRef} className="pdf-page-wrapper" data-page-number={pageNumber}>
            {isVisible ? (
                <Page
                    pageNumber={pageNumber}
                    width={width ? width * scale : undefined}
                    renderTextLayer
                    renderAnnotationLayer
                    onGetTextSuccess={handleGetTextSuccess}
                    onRenderTextLayerSuccess={handleRenderTextLayerSuccess}
                />
            ) : (
                <div className="pdf-page-placeholder" style={{ width: width ? width * scale : '100%', height: (width ? width * scale : 600) * 1.4 }} />
            )}
        </div>
    );
}

export default function PdfViewer({ pdfData, fileName, onHoverText }) {
    const [fileUrl, setFileUrl] = useState(null);
    const [numPages, setNumPages] = useState(0);
    const [pageWidth, setPageWidth] = useState(null);
    const [scale, setScale] = useState(1);
    const [fitWidth, setFitWidth] = useState(true);
    const scrollContainerRef = useRef(null);

    const file = useMemo(() => (fileUrl ? { url: fileUrl } : null), [fileUrl]);

    useEffect(() => {
        if (!pdfData) {
            setFileUrl(null);
            return;
        }
        const blob = new Blob([pdfData], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        setFileUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [pdfData]);

    const handleDocumentLoadSuccess = useCallback((pdf) => {
        setNumPages(pdf.numPages);
        // ページの内在幅(拡大率1.0時)を読込時に1回だけ取得する
        pdf.getPage(1).then((page) => {
            const viewport = page.getViewport({ scale: 1 });
            setPageWidth(viewport.width);
        });
    }, []);

    // 幅フィットモード中はコンテナ幅に合わせてスケールを算出し、リサイズにも追従する
    useEffect(() => {
        if (!fitWidth || !pageWidth) return;
        const container = scrollContainerRef.current;
        if (!container) return;
        const fit = () => {
            const containerWidth = container.clientWidth;
            if (containerWidth > 0) {
                setScale(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, containerWidth / pageWidth)));
            }
        };
        fit();
        const observer = new ResizeObserver(fit);
        observer.observe(container);
        return () => observer.disconnect();
    }, [fitWidth, pageWidth]);

    const handleZoomIn = useCallback(() => {
        setFitWidth(false);
        setScale((prev) => Math.min(MAX_ZOOM, Math.round((prev + ZOOM_STEP) * 100) / 100));
    }, []);

    const handleZoomOut = useCallback(() => {
        setFitWidth(false);
        setScale((prev) => Math.max(MIN_ZOOM, Math.round((prev - ZOOM_STEP) * 100) / 100));
    }, []);

    const handleFitWidth = useCallback(() => {
        setFitWidth(true);
    }, []);

    const handleMouseUp = useCallback(() => {
        setTimeout(() => {
            const selection = window.getSelection();
            if (selection && selection.rangeCount > 0 && selection.toString().trim().length > 1) {
                const text = selection.toString().trim();
                const range = selection.getRangeAt(0);
                const rect = range.getBoundingClientRect();
                if (rect.top > 0 && rect.left > 0) {
                    onHoverText(text, rect);
                }
            }
        }, 50);
    }, [onHoverText]);

    const handleDownload = useCallback(() => {
        if (!fileUrl) return;
        const a = document.createElement('a');
        a.href = fileUrl;
        a.download = fileName || 'document.pdf';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }, [fileUrl, fileName]);

    if (!pdfData || !fileUrl) {
        return (
            <div className="pdf-viewer-container empty-state">
                <p>PDFを選択してください</p>
            </div>
        );
    }

    return (
        <div className="pdf-viewer-container" onMouseUp={handleMouseUp}>
            <div className="viewer-toolbar">
                <div className="toolbar-left"></div>
                <div className="zoom-controls">
                    <button className="toolbar-btn" onClick={handleZoomOut} title="縮小">
                        <ZoomOutIcon size={16} />
                    </button>
                    <span className="zoom-display">{Math.round(scale * 100)}%</span>
                    <button className="toolbar-btn" onClick={handleZoomIn} title="拡大">
                        <ZoomInIcon size={16} />
                    </button>
                    <button className="toolbar-btn" onClick={handleFitWidth} title="幅に合わせる">
                        <MoveHorizontal size={16} />
                    </button>
                    <div style={{ width: '1px', height: '16px', background: 'var(--border)', margin: '0 4px' }} />
                    <button className="toolbar-btn" onClick={handleDownload} title="ダウンロード">
                        <Download size={16} />
                    </button>
                </div>
                <div className="toolbar-right"></div>
            </div>
            <div style={{ height: 'calc(100% - 40px)', width: '100%' }} className="pdf-container-inner">
                <div className="pdf-pages-scroll" ref={scrollContainerRef} style={{ height: '100%', width: '100%', overflow: 'auto' }}>
                    <Document
                        file={file}
                        options={documentOptions}
                        onLoadSuccess={handleDocumentLoadSuccess}
                        loading={<div className="pdf-loading">読み込み中...</div>}
                    >
                        {Array.from({ length: numPages }, (_, index) => {
                            const pageNumber = index + 1;
                            return (
                                <LazyPage
                                    key={pageNumber}
                                    pageNumber={pageNumber}
                                    width={pageWidth}
                                    scale={scale}
                                />
                            );
                        })}
                    </Document>
                </div>
            </div>
        </div>
    );
}
