import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from './types'

interface Props { msgs: ChatMessage[] }

export default function ChatView({ msgs }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs.length])

  const toggleExpand = (id: string) =>
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  return (
    <div style={{
      flex: 1, overflowY: 'auto', padding: '16px 12px',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      {msgs.length === 0 && (
        <div style={{ textAlign: 'center', color: '#7d8590', marginTop: 40, fontSize: 14 }}>
          发送消息开始对话
        </div>
      )}

      {msgs.map(m => (
        <MessageItem key={m.id} msg={m} expanded={expanded} onToggle={toggleExpand} />
      ))}

      <div ref={bottomRef} />
    </div>
  )
}

function MessageItem({ msg, expanded, onToggle }: {
  msg: ChatMessage
  expanded: Set<string>
  onToggle: (id: string) => void
}) {
  const { part } = msg

  if (part.type === 'user_text') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{
          background: '#1f6feb', color: '#fff', borderRadius: '16px 16px 4px 16px',
          padding: '10px 14px', maxWidth: '80%', fontSize: 14, lineHeight: 1.5,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {part.text}
        </div>
      </div>
    )
  }

  if (part.type === 'ai_text') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
        <div style={{
          background: '#161b22', border: '1px solid #21262d',
          borderRadius: '16px 16px 16px 4px',
          padding: '10px 14px', maxWidth: '85%', fontSize: 14,
          lineHeight: 1.6, color: '#e6edf3',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {part.text}
          {!part.done && <span className="cursor" style={{ borderRight: '2px solid #58a6ff', marginLeft: 1 }}>&nbsp;</span>}
          <style>{`@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}.cursor{animation:blink 1s step-end infinite}`}</style>
        </div>
      </div>
    )
  }

  if (part.type === 'reasoning') {
    const open = expanded.has(msg.id)
    return (
      <div style={{ opacity: 0.7, maxWidth: '85%' }}>
        <button
          onClick={() => onToggle(msg.id)}
          style={{
            background: 'transparent', border: '1px solid #21262d', borderRadius: 6,
            color: '#7d8590', padding: '4px 10px', fontSize: 12, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          <span>💭 思考过程</span>
          <span>{open ? '▲' : '▼'}</span>
        </button>
        {open && (
          <div style={{
            marginTop: 4, background: '#0d1117', border: '1px solid #21262d', borderRadius: 6,
            padding: '8px 12px', fontSize: 12, color: '#7d8590',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 200, overflowY: 'auto',
          }}>
            {part.text}
          </div>
        )}
      </div>
    )
  }

  if (part.type === 'tool') {
    const statusColor = {
      pending:   '#7d8590',
      running:   '#e3b341',
      completed: '#3fb950',
      error:     '#f85149',
    }[part.status]
    const statusIcon = { pending: '⏳', running: '⚙️', completed: '✅', error: '❌' }[part.status]
    const open = expanded.has(msg.id)

    return (
      <div style={{
        background: '#0d1117', border: `1px solid ${statusColor}44`,
        borderRadius: 8, padding: '8px 12px', maxWidth: '90%', fontSize: 13,
      }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}
          onClick={() => onToggle(msg.id)}
        >
          <span>{statusIcon}</span>
          <code style={{ color: '#58a6ff', flex: 1 }}>{part.title || part.tool}</code>
          <span style={{ color: statusColor, fontSize: 11, textTransform: 'uppercase' }}>{part.status}</span>
          <span style={{ color: '#7d8590', fontSize: 11 }}>{open ? '▲' : '▼'}</span>
        </div>
        {open && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Object.keys(part.input).length > 0 && (
              <pre style={{ margin: 0, fontSize: 11, color: '#7d8590', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#161b22', padding: 8, borderRadius: 4, maxHeight: 150, overflowY: 'auto' }}>
                {JSON.stringify(part.input, null, 2)}
              </pre>
            )}
            {part.output && (
              <pre style={{ margin: 0, fontSize: 11, color: '#e6edf3', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#161b22', padding: 8, borderRadius: 4, maxHeight: 200, overflowY: 'auto' }}>
                {part.output}
              </pre>
            )}
            {part.error && (
              <div style={{ fontSize: 12, color: '#f85149', padding: 6, background: '#1b0000', borderRadius: 4 }}>
                {part.error}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  if (part.type === 'error' && part.text) {
    return (
      <div style={{ color: '#f85149', fontSize: 13, padding: '8px 12px', background: '#1b0000', borderRadius: 6 }}>
        ⚠ {part.text}
      </div>
    )
  }

  return null
}
