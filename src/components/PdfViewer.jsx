import { useState, useMemo, useCallback, useEffect } from 'preact/hooks';
import { Viewer, Worker, SpecialZoomLevel } from '@react-pdf-viewer/core';
import { zoomPlugin } from '@react-pdf-viewer/zoom';
import { Download } from 'lucide-preact';
import { pdfJsAssetUrls } from '../services/pdfAssets';

import '@react-pdf-viewer/core/lib/styles/index.css';
import '@react-pdf-viewer/zoom/lib/styles/index.css';

const workerUrl = new URL('pdfjs-dist/build/pdf.worker.js', import.meta.url).toString();

export default function PdfViewer({ pdfData, fileName, onHoverText }) {
    const [fileUrl, setFileUrl] = useState(null);
    
    const zoomLevels = useMemo(() => {
        const levels = [];
        for (let i = 0.1; i <= 5.0; i += 0.05) {
            levels.push(Math.round(i * 100) / 100);
        }
        return levels;
    }, []);

    const zoomPluginInstance = zoomPlugin({
        zoomLevels: zoomLevels
    });
    const { ZoomIn, ZoomOut, Zoom } = zoomPluginInstance;

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
                    <ZoomOut />
                    <Zoom />
                    <ZoomIn />
                    <div style={{ width: '1px', height: '16px', background: 'rgba(255,255,255,0.1)', margin: '0 4px' }} />
                    <button className="toolbar-btn" onClick={handleDownload} title="ダウンロード">
                        <Download size={16} />
                    </button>
                </div>
                <div className="toolbar-right"></div>
            </div>
            <Worker workerUrl={workerUrl}>
                <div style={{ height: 'calc(100% - 40px)', width: '100%' }} className="pdf-container-inner">
                    <Viewer 
                        fileUrl={fileUrl}
                        theme="dark"
                        plugins={[zoomPluginInstance]}
                        defaultScale={SpecialZoomLevel.PageWidth}
                        characterMap={{
                            url: pdfJsAssetUrls.cMapUrl,
                            isCompressed: true,
                        }}
                    />
                </div>
            </Worker>
        </div>
    );
}
