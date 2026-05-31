import type { SessionInfo } from './types'

interface Props {
  sessions:    SessionInfo[]
  currentSid:  string | null
  onSelect:    (sid: string) => void
  onNew:       () => void
}

export default function SessionBar({ sessions, currentSid, onSelect, onNew }: Props) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4,
      borderBottom: '1px solid #21262d',
      padding: '6px 8px', overflowX: 'auto', flexShrink: 0,
      background: '#161b22',
    }}>
      {sessions.map(s => (
        <button
          key={s.id}
          onClick={() => onSelect(s.id)}
          title={s.directory}
          style={{
            background:  s.id === currentSid ? '#21262d' : 'transparent',
            border:      s.id === currentSid ? '1px solid #30363d' : '1px solid transparent',
            borderRadius: 6,
            color:       s.id === currentSid ? '#e6edf3' : '#7d8590',
            padding:     '4px 10px',
            fontSize:    13,
            cursor:      'pointer',
            whiteSpace:  'nowrap',
            maxWidth:    160,
            overflow:    'hidden',
            textOverflow:'ellipsis',
            flexShrink:  0,
          }}
        >
          {s.title || s.id.slice(0, 8)}
          {(s.status === 'busy' || s.status === 'retry') && (
            <span style={{ marginLeft: 4, display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#3fb950', verticalAlign: 'middle' }} />
          )}
        </button>
      ))}

      <button
        onClick={onNew}
        title="新建会话"
        style={{
          background: 'transparent', border: '1px dashed #30363d', borderRadius: 6,
          color: '#7d8590', padding: '4px 10px', fontSize: 16, cursor: 'pointer',
          flexShrink: 0, lineHeight: 1,
        }}
      >
        ＋
      </button>
    </div>
  )
}
