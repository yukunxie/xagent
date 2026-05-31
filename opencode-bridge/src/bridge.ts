// Core bridge: connects opencode SSE → WebSocket clients
// Maintains session state map and routes structured events to connected clients.

import { WebSocketServer, WebSocket } from 'ws'
import type { ServerMessage, ClientMessage, SessionInfo, HistoryMessage, HistoryPart } from './types.ts'
import { OpenCodeClient } from './opencode-client.ts'

export class Bridge {
  private wss: WebSocketServer
  private clients = new Set<WebSocket>()
  private opencode: OpenCodeClient
  private sessions = new Map<string, SessionInfo & { status: 'idle' | 'busy' | 'retry' }>()
  private sseAbort: AbortController | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opencodeUrl: string, directory: string, wsPort: number) {
    this.opencode = new OpenCodeClient(opencodeUrl, directory)
    this.wss = new WebSocketServer({ port: wsPort })
    this.setupWss()
  }

  // ── Public lifecycle ─────────────────────────────────────────────────────────

  async start() {
    const sessions = await this.opencode.listSessions()
    for (const s of sessions) this.sessions.set(s.id, { ...s, status: 'idle' })
    console.log(`[bridge] Loaded ${sessions.length} existing session(s)`)
    this.startSSE()
  }

  stop() {
    this.sseAbort?.abort()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.wss.close()
  }

  // ── WebSocket server ─────────────────────────────────────────────────────────

  private setupWss() {
    this.wss.on('listening', () => {
      const addr = this.wss.address() as { port: number }
      console.log(`[bridge] WebSocket listening on ws://0.0.0.0:${addr.port}`)
    })

    this.wss.on('connection', (ws) => {
      this.clients.add(ws)
      console.log(`[bridge] Client connected (total: ${this.clients.size})`)

      // Send welcome: bridge status + session list
      this.send(ws, { type: 'bridge.ready', opencode_url: this.opencode.url })
      this.send(ws, { type: 'session.list', sessions: [...this.sessions.values()] })

      ws.on('message', (raw) => {
        try {
          const msg: ClientMessage = JSON.parse(raw.toString())
          this.handleClientMessage(ws, msg)
        } catch (e) {
          console.error('[bridge] bad client message:', e)
        }
      })

      ws.on('close', () => {
        this.clients.delete(ws)
        console.log(`[bridge] Client disconnected (total: ${this.clients.size})`)
      })
    })
  }

  private async handleClientMessage(ws: WebSocket, msg: ClientMessage) {
    try {
      switch (msg.type) {
        case 'session.list': {
          const sessions = await this.opencode.listSessions()
          for (const s of sessions) this.sessions.set(s.id, { ...s, status: 'idle' })
          this.send(ws, { type: 'session.list', sessions: [...this.sessions.values()] })
          break
        }

        case 'session.create': {
          const session = await this.opencode.createSession(msg.directory)
          this.sessions.set(session.id, { ...session, status: 'idle' })
          this.broadcast({ type: 'session.created', session })
          break
        }

        case 'session.prompt': {
          const { session_id, text } = msg
          // Echo user message to all clients immediately so the UI shows it
          this.broadcast({ type: 'user.message', session_id, message_id: '', text })
          await this.opencode.sendPrompt(session_id, text)
          break
        }

        case 'permission.reply': {
          await this.opencode.replyPermission(msg.id, msg.reply)
          break
        }

        case 'session.abort': {
          await this.opencode.abort(msg.session_id)
          break
        }

        case 'session.history': {
          const raw = await this.opencode.getMessages(msg.session_id)
          const messages = this.formatHistory(raw)
          this.send(ws, { type: 'session.history', session_id: msg.session_id, messages })
          break
        }
      }
    } catch (err: any) {
      this.send(ws, { type: 'bridge.error', message: err.message ?? String(err) })
    }
  }

  // ── SSE subscription + event routing ─────────────────────────────────────────

  private startSSE() {
    this.sseAbort = new AbortController()
    this.runSSELoop(this.sseAbort.signal).catch(err => {
      if ((err as any).name === 'AbortError') return
      console.error('[bridge] SSE loop error:', err)
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(delayMs = 3000) {
    if (this.reconnectTimer) return
    console.log(`[bridge] Reconnecting SSE in ${delayMs}ms…`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.startSSE()
    }, delayMs)
  }

  private async runSSELoop(signal: AbortSignal) {
    console.log('[bridge] SSE connected to opencode')
    for await (const event of this.opencode.subscribeSSE(signal)) {
      this.routeEvent(event)
    }
    this.scheduleReconnect()
  }

  // Translate one opencode SSE event into zero or more bridge WebSocket messages
  private routeEvent(event: any) {
    const { type, properties: p } = event
    if (!type || !p) return

    switch (type) {
      case 'session.created': {
        const s = this.mapSession(p.info)
        this.sessions.set(s.id, s)
        this.broadcast({ type: 'session.created', session: s })
        break
      }

      case 'session.updated': {
        const existing = this.sessions.get(p.sessionID)
        if (existing && p.info?.title) existing.title = p.info.title
        this.broadcast({ type: 'session.updated', session_id: p.sessionID, title: p.info?.title })
        break
      }

      case 'session.status': {
        const s = this.sessions.get(p.sessionID)
        const status: 'idle' | 'busy' | 'retry' =
          p.status?.type === 'idle'  ? 'idle'  :
          p.status?.type === 'retry' ? 'retry' : 'busy'
        if (s) s.status = status
        this.broadcast({
          type: 'session.status',
          session_id: p.sessionID,
          status,
          retry_msg: p.status?.message,
        })
        break
      }

      case 'session.error': {
        this.broadcast({
          type: 'session.error',
          session_id: p.sessionID ?? '',
          error: p.error?.message ?? JSON.stringify(p.error),
        })
        break
      }

      case 'message.part.delta': {
        const { sessionID, messageID, partID, field, delta } = p
        if (field === 'text') {
          this.broadcast({ type: 'text.delta', session_id: sessionID, message_id: messageID, part_id: partID, delta })
        } else if (field === 'reasoning') {
          this.broadcast({ type: 'reasoning.delta', session_id: sessionID, message_id: messageID, part_id: partID, delta })
        }
        break
      }

      case 'message.part.updated': {
        const part = p.part
        if (!part) break
        const sid = part.sessionID
        const mid = part.messageID
        const pid = part.id

        if (part.type === 'text' && part.text !== undefined) {
          this.broadcast({ type: 'text.done', session_id: sid, message_id: mid, part_id: pid })
        }

        if (part.type === 'tool') {
          const state = part.state
          if (!state) break
          const base = { session_id: sid, message_id: mid, part_id: pid, tool: part.tool ?? '', call_id: part.callID ?? '' }
          switch (state.status) {
            case 'pending':
              this.broadcast({ type: 'tool.pending', ...base, input: state.input ?? {} })
              break
            case 'running':
              this.broadcast({ type: 'tool.running', ...base, input: state.input ?? {}, title: state.title })
              break
            case 'completed':
              this.broadcast({ type: 'tool.done', session_id: sid, message_id: mid, part_id: pid, tool: part.tool ?? '', title: state.title ?? '', output: state.output ?? '' })
              break
            case 'error':
              this.broadcast({ type: 'tool.error', session_id: sid, message_id: mid, part_id: pid, tool: part.tool ?? '', error: state.error ?? '' })
              break
          }
        }
        break
      }

      case 'permission.asked': {
        this.broadcast({
          type: 'permission.asked',
          id: p.id,
          session_id: p.sessionID,
          permission: p.permission,
          patterns: p.patterns ?? [],
          metadata: p.metadata ?? {},
          tool: p.tool ? { message_id: p.tool.messageID, call_id: p.tool.callID } : undefined,
        })
        break
      }

      case 'permission.replied': {
        this.broadcast({
          type: 'permission.replied',
          id: p.requestID ?? p.id,
          session_id: p.sessionID,
          reply: p.reply,
        })
        break
      }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private mapSession(info: any): SessionInfo & { status: 'idle' } {
    return {
      id: info.id,
      title: info.title || '(untitled)',
      directory: info.directory || this.opencode.directory,
      status: 'idle',
      created_at: info.time?.created ?? Date.now(),
      cost: info.cost,
      tokens: info.tokens ? { input: info.tokens.input, output: info.tokens.output } : undefined,
    }
  }

  private formatHistory(raw: any[]): HistoryMessage[] {
    if (!Array.isArray(raw)) return []
    return raw.map(msg => {
      const role: 'user' | 'assistant' = msg.role === 'user' ? 'user' : 'assistant'
      const parts: HistoryPart[] = (msg.parts ?? []).flatMap((p: any): HistoryPart[] => {
        if (p.type === 'text') {
          const text = typeof p.text === 'string' ? p.text : ''
          return text ? [{ type: 'text', id: p.id ?? '', text }] : []
        }
        if (p.type === 'tool') {
          const state = p.state ?? {}
          return [{
            type: 'tool',
            id: p.id ?? '',
            tool: p.tool ?? '',
            call_id: p.callID ?? '',
            input: state.input ?? {},
            title: state.title ?? p.tool ?? '',
            output: state.output,
            error: state.error,
            status: state.status === 'completed' ? 'completed'
                  : state.status === 'error'     ? 'error'
                  : state.status === 'running'   ? 'running'
                  : 'pending',
          }]
        }
        return []
      })
      return { id: msg.id ?? '', role, parts }
    })
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  private broadcast(msg: ServerMessage) {
    const data = JSON.stringify(msg)
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    }
  }
}
