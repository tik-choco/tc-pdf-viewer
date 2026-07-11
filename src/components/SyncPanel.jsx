import { RefreshCw, Users, X, Share2, QrCode } from 'lucide-preact';

export function SyncPanel({
  open,
  onClose,
  roomId,
  status,
  error,
  peerCount,
  onCopyInvite,
  onStartSync,
  onShowQR,
  onDisconnect,
}) {
  const isActive = status === 'connecting' || status === 'connected';

  const statusLabel = (s) => {
    switch (s) {
      case 'connecting': return '接続中';
      case 'connected': return '同期中';
      case 'error': return 'エラー';
      default: return '未接続';
    }
  };

  if (!open) return null;

  return (
    <div className={`modal-backdrop ${open ? 'open' : ''}`} onClick={onClose}>
      <div className="modal-card sync-card" onClick={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <div>
            <h2>Sync</h2>
            <p className="subtle">他のデバイスとデータをリアルタイム共有します</p>
          </div>

          <div className="sync-header-right">
            <div className={`sync-status-pill ${status}`}>
              {statusLabel(status)}
            </div>
            {isActive && (
              <div className="sync-count">
                <Users size={14} style={{ marginRight: 4 }} />
                {peerCount} 人
              </div>
            )}
            <button className="settings-close" onClick={onClose} aria-label="閉じる"><X size={20} /></button>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-row">
            <label className="settings-label">
              Room ID
            </label>
            <div className="sync-inline">
              <input
                type="text"
                value={roomId || '未作成'}
                readOnly
                placeholder="ルームID"
              />
              <button type="button" className="primary" onClick={onCopyInvite}>
                <Share2 size={16} style={{ marginRight: 4 }} />
                {roomId ? 'コピー' : '招待'}
              </button>
              {roomId && (
                <button type="button" onClick={onShowQR} title="QRコードを表示">
                  <QrCode size={16} />
                </button>
              )}
            </div>
          </div>

          <div className="sync-actions">
            {isActive ? (
              <button type="button" className="danger" onClick={onDisconnect} style={{ width: '100%' }}>
                同期を終了
              </button>
            ) : (
              <button type="button" className="primary" onClick={onStartSync} style={{ width: '100%' }}>
                <RefreshCw size={16} style={{ marginRight: 8 }} />
                同期を開始
              </button>
            )}
          </div>

          {error && <p className="hint error">{error}</p>}
          {!isActive && (
            <p className="hint">
              「同期を開始」ボタンを押すと、P2P通信用のルームが作成されます。
              ルームIDまたは招待リンクを共有することで、他のブラウザとデータを同期できます。
            </p>
          )}
        </div>

        <div className="sync-footer">
          <a href="https://github.com/tik-choco-lab/mistlib" target="_blank" rel="noopener noreferrer">
            Powered by mistlib
          </a>
        </div>
      </div>
    </div>
  );
}
