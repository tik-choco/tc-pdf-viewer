import { useEffect, useRef } from 'preact/hooks';
import QRCode from 'qrcode';
import { X } from 'lucide-preact';

export function QRPanel({ open, onClose, url }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (open && url && canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, url, {
        width: 250,
        margin: 2,
        color: {
          dark: '#0f172a',
          light: '#ffffff',
        },
        errorCorrectionLevel: 'H',
      }).catch(err => {
        console.error('QR code generation failed', err);
      });
    }
  }, [open, url]);

  if (!open) return null;

  return (
    <div className={`modal-backdrop ${open ? 'open' : ''}`} onClick={onClose} style={{ zIndex: 4000 }}>
      <div className="modal-card qr-card" onClick={(e) => e.stopPropagation()} style={{ textAlign: 'center', width: 'auto' }}>
        <div className="settings-header" style={{ justifyContent: 'center' }}>
          <h2>招待 QR コード</h2>
        </div>
        
        <div className="qr-container" style={{ background: 'white', padding: 12, borderRadius: 12, display: 'inline-block', margin: '16px 0' }}>
          <canvas ref={canvasRef} />
        </div>
        
        <p className="hint">このQRコードをカメラでスキャンすると、この同期ルームに参加できます。</p>
        
        <div className="sync-actions" style={{ marginTop: 20 }}>
          <button type="button" className="primary" onClick={onClose} style={{ width: '100%' }}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
