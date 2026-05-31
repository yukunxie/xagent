import { useState, useRef, useEffect } from 'react'
import type { SessionInfo } from './types'

interface Props {
  sessions:      SessionInfo[]
  savedDir:      string
  onNew:         (dir: string) => void
  onRestore:     (sid: string) => void
  onClose:       () => void
}

// Detect Tauri runtime
const isTauri = typeof (window as any).__TAURI__ !== 'undefined'

export default function NewSessionOverlay({ sessions, savedDir, onNew, onRestore, onClose }: Props) {
  const [dir, setDir]     = useState(savedDir)
  const inputRef          = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const handleBrowse = async () => {
    if (!isTauri) return
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ directory: true, multiple: false, title: '选择工作目录' })
      if (typeof selected === 'string') setDir(selected)
    } catch (e) {
      console.warn('dialog open failed:', e)
    }
  }

  const handleNew = () => {
    onNew(dir)
  }

  const sorted = [...sessions].sort((a, b) => b.created_at - a.created_at)

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 60, padding: 16,
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#161b22', border: '1px solid #30363d', borderRadius: 14,
          width: '100%', maxWidth: 440, padding: 20,
          display: 'flex', flexDirection: 'column', gap: 16,
        }}
      >
        {/* ── New opencode session ─── */}
        <div>
          <div style={{ color: '#e6edf3', fontWeight: 600, fontSize: 15, marginBottom: 12 }}>
            🤖 新建 opencode 会话
          </div>

          <label style={{ display: 'block', color: '#7d8590', fontSize: 12, marginBottom: 6 }}>
            工作目录 <span style={{ color: '#484f58' }}>（留空使用默认）</span>
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              ref={inputRef}
              value={dir}
              onChange={e => setDir(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleNew()}
              placeholder="C:\Users\me\project"
              style={{
                flex: 1, background: '#0d1117', border: '1px solid #30363d',
                borderRadius: 8, color: '#e6edf3', padding: '8px 12px',
                fontSize: 13, outline: 'none', fontFamily: 'monospace',
              }}
            />
            {isTauri && (
              <button
                onClick={handleBrowse}
                title="浏览"
                style={{
                  background: '#21262d', border: '1px solid #30363d', borderRadius: 8,
                  color: '#e6edf3', padding: '8px 12px', fontSize: 16,
                  cursor: 'pointer', flexShrink: 0,
                }}
              >
                📁
              </button>
            )}
          </div>

          <button
            onClick={handleNew}
            style={{
              width: '100%', marginTop: 10, background: '#238636',
              border: 'none', borderRadius: 8, color: '#fff',
              padding: '10px', fontSize: 14, cursor: 'pointer', fontWeight: 500,
            }}
          >
            ＋ 新建会话
          </button>
        </div>

        {/* ── Restore existing ─── */}
        {sorted.length > 0 && (
          <div>
            <div style={{
              borderTop: '1px solid #21262d', paddingTop: 14,
              color: '#7d8590', fontSize: 12, marginBottom: 8,
            }}>
              恢复已有会话
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
              {sorted.map(s => (
                <button
                  key={s.id}
                  onClick={() => onRestore(s.id)}
                  style={{
                    background: '#0d1117', border: '1px solid #21262d', borderRadius: 8,
                    padding: '10px 12px', textAlign: 'left', cursor: 'pointer',
                    display: 'flex', flexDirection: 'column', gap: 3,
                  }}
                >
                  <div style={{ color: '#e6edf3', fontSize: 13, fontWeight: 500 }}>
                    {s.title || s.id.slice(0, 12)}
                  </div>
                  <div style={{ color: '#484f58', fontSize: 11, fontFamily: 'monospace' }}>
                    {s.directory || '–'}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        <button
          onClick={onClose}
          style={{
            alignSelf: 'flex-end', background: 'transparent', border: 'none',
            color: '#7d8590', fontSize: 13, cursor: 'pointer', padding: '4px 0',
          }}
        >
          取消
        </button>
      </div>
    </div>
  )
}
