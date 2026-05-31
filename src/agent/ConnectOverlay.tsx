import { useState, useRef, useEffect } from 'react'
import type { ConnectState } from './useBridge'
import { BRIDGE_PORT } from './useBridge'

interface Props {
  state: ConnectState
  onConnect: (ip: string) => void
}

export default function ConnectOverlay({ state, onConnect }: Props) {
  const [ip, setIp]         = useState(() => localStorage.getItem('xagent_bridge_ip') || '127.0.0.1')
  const inputRef            = useRef<HTMLInputElement>(null)

  // auto-focus the input when we show the error state
  useEffect(() => { if (state === 'failed') inputRef.current?.focus() }, [state])

  if (state === 'connected') return null

  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: '#0d1117', zIndex: 100, gap: 16,
    }}>
      <div style={{ fontSize: 28 }}>🤖</div>
      <div style={{ color: '#e6edf3', fontSize: 18, fontWeight: 600 }}>xAgent</div>

      {state === 'connecting' ? (
        <div style={{ color: '#7d8590', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="spin" style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid #30363d', borderTopColor: '#58a6ff', borderRadius: '50%' }} />
          正在连接 {BRIDGE_PORT} 端口…
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
          <div style={{ color: '#f85149', fontSize: 13 }}>连接失败，请输入 Bridge 主机 IP</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ color: '#7d8590', fontSize: 13 }}>ws://</span>
            <input
              ref={inputRef}
              value={ip}
              onChange={e => setIp(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && onConnect(ip)}
              placeholder="127.0.0.1"
              style={{
                background: '#161b22', border: '1px solid #30363d', borderRadius: 6,
                color: '#e6edf3', padding: '6px 10px', fontSize: 14, width: 160,
                outline: 'none',
              }}
            />
            <span style={{ color: '#7d8590', fontSize: 13 }}>:{BRIDGE_PORT}</span>
          </div>
          <button
            onClick={() => onConnect(ip)}
            style={{
              background: '#238636', border: 'none', borderRadius: 6,
              color: '#fff', padding: '8px 20px', fontSize: 14, cursor: 'pointer',
            }}
          >
            连接
          </button>
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        .spin { animation: spin .8s linear infinite }
      `}</style>
    </div>
  )
}
