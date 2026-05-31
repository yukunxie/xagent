import { useBridge } from './useBridge'
import ConnectOverlay   from './ConnectOverlay'
import SessionBar       from './SessionBar'
import ChatView         from './ChatView'
import PermissionDialog from './PermissionDialog'
import InputBar         from './InputBar'

export default function AgentApp() {
  const {
    connectState, connect,
    sessions, currentSid, selectSession,
    msgs, isBusy, pending,
    sendPrompt, createSession, abortSession, replyPermission,
  } = useBridge()

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100vh', width: '100vw',
      background: '#0d1117', overflow: 'hidden',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      {/* 自动连接遮罩 */}
      <ConnectOverlay state={connectState} onConnect={connect} />

      {/* 会话 tab 栏 */}
      {sessions.length > 0 && (
        <SessionBar
          sessions={sessions}
          currentSid={currentSid}
          onSelect={selectSession}
          onNew={createSession}
        />
      )}

      {/* 无会话时的空状态 */}
      {connectState === 'connected' && sessions.length === 0 && (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16,
        }}>
          <div style={{ fontSize: 40 }}>🤖</div>
          <div style={{ color: '#e6edf3', fontSize: 18, fontWeight: 600 }}>xAgent</div>
          <div style={{ color: '#7d8590', fontSize: 13, textAlign: 'center', maxWidth: 280, lineHeight: 1.6 }}>
            还没有会话，点击下方按钮开始
          </div>
          <button
            onClick={createSession}
            style={{
              background: '#238636', border: 'none', borderRadius: 8,
              color: '#fff', padding: '10px 24px', fontSize: 14, cursor: 'pointer',
            }}
          >
            ＋ 新建会话
          </button>
        </div>
      )}

      {/* 聊天区域 */}
      {currentSid && (
        <>
          <ChatView msgs={msgs} />
          <InputBar
            isBusy={isBusy}
            onSend={sendPrompt}
            onAbort={abortSession}
            disabled={connectState !== 'connected'}
          />
        </>
      )}

      {/* 权限弹窗 */}
      {pending && (
        <PermissionDialog req={pending} onReply={replyPermission} />
      )}
    </div>
  )
}
