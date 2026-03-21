import { useState, useMemo, useCallback } from 'preact/hooks';
import { Viewer, Worker, SpecialZoomLevel } from '@react-pdf-viewer/core';
import { zoomPlugin } from '@react-pdf-viewer/zoom';

import '@react-pdf-viewer/core/lib/styles/index.css';
import '@react-pdf-viewer/zoom/lib/styles/index.css';

const workerUrl = new URL('pdfjs-dist/build/pdf.worker.js', import.meta.url).toString();

export default function PdfViewer({ pdfData, onHoverText }) {
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

    useMemo(() => {
        if (!pdfData) return;
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
                    onHoverText(text, { 
                        x: rect.left + rect.width / 2, 
                        y: rect.top - 10 
                    });
                }
            }
        }, 50);
    }, [onHoverText]);

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
                    />
                </div>
            </Worker>
        </div>
    );
}
