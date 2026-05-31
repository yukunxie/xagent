import type { PermissionRequest } from './types'

interface Props {
  req:     PermissionRequest
  onReply: (id: string, reply: 'once' | 'always' | 'reject') => void
}

export default function PermissionDialog({ req, onReply }: Props) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.65)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      zIndex: 50, padding: '0 0 20px',
    }}>
      <div style={{
        background: '#161b22', border: '1px solid #30363d', borderRadius: 16,
        padding: '20px 20px 16px', width: '100%', maxWidth: 480,
        margin: '0 12px',
      }}>
        <div style={{ color: '#e3b341', fontWeight: 600, fontSize: 15, marginBottom: 10 }}>
          🔐 权限请求
        </div>
        <div style={{ color: '#e6edf3', fontSize: 14, marginBottom: 8 }}>
          {req.permission}
        </div>
        {req.patterns.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            {req.patterns.map((p, i) => (
              <code key={i} style={{
                display: 'block', background: '#0d1117', borderRadius: 4,
                padding: '3px 8px', fontSize: 12, color: '#7d8590', marginBottom: 3,
              }}>
                {p}
              </code>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button onClick={() => onReply(req.id, 'reject')}  style={btnStyle('#da3633', '#1b0000')}>拒绝</button>
          <button onClick={() => onReply(req.id, 'once')}    style={btnStyle('#388bfd', '#0d2044')}>允许一次</button>
          <button onClick={() => onReply(req.id, 'always')}  style={btnStyle('#3fb950', '#0d2918')}>始终允许</button>
        </div>
      </div>
    </div>
  )
}

function btnStyle(color: string, bg: string): React.CSSProperties {
  return {
    background: bg, border: `1px solid ${color}`, borderRadius: 6,
    color, padding: '7px 16px', fontSize: 13, cursor: 'pointer', fontWeight: 500,
  }
}
