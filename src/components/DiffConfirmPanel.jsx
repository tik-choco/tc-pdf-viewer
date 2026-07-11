import { X, AlertTriangle } from 'lucide-preact';

export function DiffConfirmPanel({ open, onAccept, onDisconnect }) {
  if (!open) return null;

  return (
    <div className="modal-backdrop open" style={{ zIndex: 3000 }}>
      <div className="modal-card sync-card diff-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <AlertTriangle color="#f59e0b" size={24} />
            <h2>同期データの競合</h2>
          </div>
        </div>
        <div className="settings-section">
          <p style={{ lineHeight: 1.6 }}>
            接続先のデバイスとデータの内容に差異があります。<br />
            <strong>相手のデータ（ファイルリスト、AI設定など）</strong>に上書きしてもよろしいですか？
          </p>
          <p className="hint" style={{ marginTop: 12 }}>
            ※ 「受け入れる」を選択すると、現在の設定やファイル索引は相手のものに置き換わります。<br />
            ※ どちらか一方が「受け入れる」を押すことで同期が開始されます。
          </p>
          <div className="sync-actions" style={{ marginTop: '24px', display: 'flex', gap: 12 }}>
            <button type="button" className="danger" onClick={onDisconnect} style={{ flex: 1 }}>
              切断する
            </button>
            <button type="button" className="primary" onClick={onAccept} style={{ flex: 1 }}>
              受け入れる
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
