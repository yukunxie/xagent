import { useState, useEffect, useRef, useCallback } from 'react'
import type { SessionInfo, ChatMessage, PermissionRequest, ChatPart } from './types'

const DEFAULT_IP   = '127.0.0.1'
export const BRIDGE_PORT = 9001
const LS_IP_KEY    = 'xagent_bridge_ip'

export type ConnectState = 'connecting' | 'connected' | 'failed'

export function useBridge() {
  const [connectState, setConnectState] = useState<ConnectState>('connecting')
  const [sessions,     setSessions]     = useState<SessionInfo[]>([])
  const [currentSid,   setCurrentSidRaw]= useState<string | null>(null)
  const [msgs,         setMsgs]         = useState<Map<string, ChatMessage[]>>(new Map())
  const [isBusy,       setIsBusy]       = useState(false)
  const [pending,      setPending]      = useState<PermissionRequest | null>(null)

  const wsRef         = useRef<WebSocket | null>(null)
  const reconnTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentSidRef = useRef<string | null>(null)
  const sessionsRef   = useRef<SessionInfo[]>([])

  // Keep refs in sync
  const setCurrentSid = (sid: string | null) => {
    currentSidRef.current = sid
    setCurrentSidRaw(sid)
  }

  // ── Message state helpers ─────────────────────────────────────────────────

  const appendMsg = useCallback((sid: string, msg: ChatMessage) => {
    setMsgs(prev => {
      const next = new Map(prev)
      next.set(sid, [...(next.get(sid) ?? []), msg])
      return next
    })
  }, [])

  const updateAiText = useCallback((sid: string, partId: string, delta: string) => {
    setMsgs(prev => {
      const list = prev.get(sid) ?? []
      const idx  = list.findIndex(m => m.part.type === 'ai_text' && (m.part as any).partId === partId && !(m.part as any).done)
      const next = new Map(prev)
      if (idx >= 0) {
        const updated = [...list]
        const p = updated[idx].part as Extract<ChatPart, { type: 'ai_text' }>
        updated[idx] = { ...updated[idx], part: { ...p, text: p.text + delta } }
        next.set(sid, updated)
      } else {
        next.set(sid, [...list, { id: `ai-${partId}`, part: { type: 'ai_text', partId, text: delta, done: false } }])
      }
      return next
    })
  }, [])

  const finalizeAiText = useCallback((sid: string, partId: string) => {
    setMsgs(prev => {
      const list = prev.get(sid) ?? []
      const next = new Map(prev)
      next.set(sid, list.map(m => {
        if (m.part.type === 'ai_text' && (m.part as any).partId === partId) {
          return { ...m, part: { ...m.part, done: true } }
        }
        return m
      }))
      return next
    })
  }, [])

  const updateReasoning = useCallback((sid: string, partId: string, delta: string) => {
    setMsgs(prev => {
      const list = prev.get(sid) ?? []
      const idx  = list.findIndex(m => m.part.type === 'reasoning' && (m.part as any).partId === partId)
      const next = new Map(prev)
      if (idx >= 0) {
        const updated = [...list]
        const p = updated[idx].part as Extract<ChatPart, { type: 'reasoning' }>
        updated[idx] = { ...updated[idx], part: { ...p, text: p.text + delta } }
        next.set(sid, updated)
      } else {
        next.set(sid, [...list, { id: `r-${partId}`, part: { type: 'reasoning', partId, text: delta } }])
      }
      return next
    })
  }, [])

  const upsertTool = useCallback((sid: string, partId: string, tool: Extract<ChatPart, { type: 'tool' }>) => {
    setMsgs(prev => {
      const list = prev.get(sid) ?? []
      const idx  = list.findIndex(m => m.part.type === 'tool' && (m.part as any).id === partId)
      const next = new Map(prev)
      if (idx >= 0) {
        const updated = [...list]
        updated[idx] = { ...updated[idx], part: tool }
        next.set(sid, updated)
      } else {
        next.set(sid, [...list, { id: `tool-${partId}`, part: tool }])
      }
      return next
    })
  }, [])

  // ── Send helper ────────────────────────────────────────────────────────────
  const sendRaw = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(msg))
  }, [])

  const requestHistory = useCallback((sid: string) => {
    sendRaw({ type: 'session.history', session_id: sid })
  }, [sendRaw])

  // ── Message router (uses refs to avoid stale closure) ─────────────────────
  const handleMsg = useCallback((msg: any) => {
    const sid = currentSidRef.current

    switch (msg.type) {
      case 'bridge.ready': break

      case 'session.list': {
        const list: SessionInfo[] = msg.sessions ?? []
        sessionsRef.current = list
        setSessions(list)
        const picked = sid ?? list.at(-1)?.id ?? null
        setCurrentSid(picked)
        if (picked) requestHistory(picked)
        break
      }

      case 'session.created': {
        const s: SessionInfo = msg.session
        sessionsRef.current = [...sessionsRef.current, s]
        setSessions(prev => [...prev, s])
        setCurrentSid(s.id)
        requestHistory(s.id)
        break
      }

      case 'session.updated':
        setSessions(prev => prev.map(s => s.id === msg.session_id ? { ...s, title: msg.title ?? s.title } : s))
        break

      case 'session.status':
        setSessions(prev => prev.map(s => s.id === msg.session_id ? { ...s, status: msg.status } : s))
        if (msg.session_id === currentSidRef.current) {
          setIsBusy(msg.status === 'busy' || msg.status === 'retry')
        }
        break

      case 'session.history': {
        const hsid: string = msg.session_id
        const raw: any[]   = msg.messages ?? []
        if (!raw.length) break
        const built: ChatMessage[] = []
        for (const m of raw) {
          if (m.role === 'user') {
            const text = (m.parts ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('')
            if (text) built.push({ id: `h-u-${m.id}`, part: { type: 'user_text', text } })
          } else {
            for (const p of (m.parts ?? [])) {
              if (p.type === 'text' && p.text)
                built.push({ id: `h-t-${p.id}`, part: { type: 'ai_text', partId: p.id, text: p.text, done: true } })
              else if (p.type === 'tool')
                built.push({ id: `h-tool-${p.id}`, part: { type: 'tool', id: p.id, tool: p.tool, title: p.title ?? p.tool, input: p.input ?? {}, output: p.output, error: p.error, status: p.status ?? 'completed' } })
            }
          }
        }
        setMsgs(prev => { const next = new Map(prev); next.set(hsid, built); return next })
        break
      }

      case 'user.message':
        appendMsg(msg.session_id, { id: `u-${Date.now()}-${Math.random()}`, part: { type: 'user_text', text: msg.text } })
        break

      case 'text.delta':    updateAiText(msg.session_id, msg.part_id, msg.delta);                       break
      case 'text.done':     finalizeAiText(msg.session_id, msg.part_id);                                break
      case 'reasoning.delta': updateReasoning(msg.session_id, msg.part_id, msg.delta);                 break

      case 'tool.pending':
        upsertTool(msg.session_id, msg.part_id, { type: 'tool', id: msg.part_id, tool: msg.tool, title: msg.tool, input: msg.input ?? {}, status: 'pending' })
        break
      case 'tool.running':
        upsertTool(msg.session_id, msg.part_id, { type: 'tool', id: msg.part_id, tool: msg.tool, title: msg.title ?? msg.tool, input: msg.input ?? {}, status: 'running' })
        break
      case 'tool.done':
        upsertTool(msg.session_id, msg.part_id, { type: 'tool', id: msg.part_id, tool: msg.tool, title: msg.title, input: {}, output: msg.output, status: 'completed' })
        break
      case 'tool.error':
        upsertTool(msg.session_id, msg.part_id, { type: 'tool', id: msg.part_id, tool: msg.tool, title: msg.tool, input: {}, error: msg.error, status: 'error' })
        break

      case 'permission.asked':  setPending(msg);                                                       break
      case 'permission.replied': setPending(prev => prev?.id === msg.id ? null : prev);                break
      case 'session.error':
        appendMsg(msg.session_id, { id: `err-${Date.now()}`, part: { type: 'error', text: msg.error } })
        break
    }
  }, [appendMsg, updateAiText, finalizeAiText, updateReasoning, upsertTool, requestHistory])

  const handleMsgRef = useRef(handleMsg)
  handleMsgRef.current = handleMsg

  // ── Connect ────────────────────────────────────────────────────────────────
  const connect = useCallback((ip: string) => {
    if (reconnTimer.current) { clearTimeout(reconnTimer.current); reconnTimer.current = null }
    wsRef.current?.close()
    setConnectState('connecting')

    let ws: WebSocket
    try { ws = new WebSocket(`ws://${ip}:${BRIDGE_PORT}`) } catch { setConnectState('failed'); return }
    wsRef.current = ws

    const failTimer = setTimeout(() => { ws.close(); setConnectState('failed') }, 5000)

    ws.onopen  = () => { clearTimeout(failTimer); localStorage.setItem(LS_IP_KEY, ip); setConnectState('connected') }
    ws.onmessage = (e) => { try { handleMsgRef.current(JSON.parse(e.data as string)) } catch {} }
    ws.onerror = () => { clearTimeout(failTimer); setConnectState('failed') }
    ws.onclose = () => {
      clearTimeout(failTimer)
      setConnectState('failed')
      const lastIp = localStorage.getItem(LS_IP_KEY) || DEFAULT_IP
      reconnTimer.current = setTimeout(() => connect(lastIp), 3000)
    }
  }, [])

  useEffect(() => {
    const ip = localStorage.getItem(LS_IP_KEY) || DEFAULT_IP
    connect(ip)
    return () => {
      wsRef.current?.close()
      if (reconnTimer.current) clearTimeout(reconnTimer.current)
    }
  }, [connect])

  // ── Public API ─────────────────────────────────────────────────────────────
  const selectSession = useCallback((sid: string) => {
    setCurrentSid(sid)
    const s = sessionsRef.current.find(x => x.id === sid)
    setIsBusy(s?.status === 'busy' || s?.status === 'retry')
    setMsgs(prev => {
      if (!prev.has(sid)) {
        requestHistory(sid)
        return prev
      }
      return prev
    })
  }, [requestHistory])

  const sendPrompt = useCallback((text: string) => {
    if (!currentSidRef.current) return
    sendRaw({ type: 'session.prompt', session_id: currentSidRef.current, text })
  }, [sendRaw])

  const createSession = useCallback((directory?: string) => sendRaw({ type: 'session.create', directory }), [sendRaw])
  const abortSession  = useCallback(() => {
    if (currentSidRef.current) sendRaw({ type: 'session.abort', session_id: currentSidRef.current })
  }, [sendRaw])

  const replyPermission = useCallback((id: string, reply: 'once' | 'always' | 'reject') => {
    sendRaw({ type: 'permission.reply', id, reply })
  }, [sendRaw])

  return {
    connectState, connect,
    sessions, currentSid, selectSession,
    msgs: (currentSid ? msgs.get(currentSid) : undefined) ?? [],
    isBusy, pending,
    sendPrompt, createSession, abortSession, replyPermission,
    savedDir: localStorage.getItem('xagent_last_dir') ?? '',
    saveDir: (d: string) => localStorage.setItem('xagent_last_dir', d),
  }
}
