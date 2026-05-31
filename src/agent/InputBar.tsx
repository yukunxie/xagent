import { useState, useRef, useEffect } from 'react'

interface Props {
  isBusy:      boolean
  onSend:      (text: string) => void
  onAbort:     () => void
  disabled?:   boolean
}

export default function InputBar({ isBusy, onSend, onAbort, disabled }: Props) {
  const [text, setText]   = useState('')
  const textareaRef       = useRef<HTMLTextAreaElement>(null)

  // auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }, [text])

  const submit = () => {
    const t = text.trim()
    if (!t || disabled) return
    onSend(t)
    setText('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
  }

  return (
    <div style={{
      borderTop: '1px solid #21262d', padding: '10px 12px',
      display: 'flex', gap: 8, alignItems: 'flex-end',
      background: '#161b22', flexShrink: 0,
    }}>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={isBusy || disabled}
        placeholder={isBusy ? 'Agent 正在运行…' : '输入消息（Enter 发送，Shift+Enter 换行）'}
        rows={1}
        style={{
          flex: 1, resize: 'none', background: '#0d1117',
          border: '1px solid #30363d', borderRadius: 10,
          color: '#e6edf3', padding: '10px 12px', fontSize: 14,
          lineHeight: 1.5, outline: 'none', overflowY: 'hidden',
          fontFamily: 'inherit',
        }}
      />
      {isBusy ? (
        <button
          onClick={onAbort}
          style={{
            background: '#da3633', border: 'none', borderRadius: 10,
            color: '#fff', padding: '10px 16px', fontSize: 14,
            cursor: 'pointer', flexShrink: 0, alignSelf: 'flex-end',
          }}
        >
          停止
        </button>
      ) : (
        <button
          onClick={submit}
          disabled={!text.trim() || disabled}
          style={{
            background: text.trim() ? '#238636' : '#21262d',
            border: 'none', borderRadius: 10,
            color: text.trim() ? '#fff' : '#7d8590',
            padding: '10px 16px', fontSize: 16,
            cursor: text.trim() ? 'pointer' : 'default',
            flexShrink: 0, alignSelf: 'flex-end', transition: 'background .15s',
          }}
        >
          ↑
        </button>
      )}
    </div>
  )
}
