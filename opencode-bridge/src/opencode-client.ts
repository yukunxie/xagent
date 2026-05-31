// opencode HTTP client: session management, permission replies, SSE streaming
import type { SessionInfo, ServerMessage } from './types.ts'

export class OpenCodeClient {
  readonly url: string
  readonly directory: string

  constructor(url: string, directory: string) {
    this.url = url.replace(/\/$/, '')
    this.directory = directory
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-opencode-directory': encodeURIComponent(this.directory),
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`opencode API ${method} ${path} → ${res.status}: ${await res.text()}`)
    return res.json() as Promise<T>
  }

  async getMessages(sessionId: string): Promise<any[]> {
    return this.request('GET', `/session/${sessionId}/message`)
  }

  async listSessions(): Promise<SessionInfo[]> {
    const raw: any[] = await this.request('GET', '/session')
    return raw.map(s => ({
      id: s.id,
      title: s.title || '(untitled)',
      directory: s.directory || this.directory,
      status: 'idle' as const,
      created_at: s.time?.created ?? Date.now(),
      cost: s.cost,
      tokens: s.tokens ? { input: s.tokens.input, output: s.tokens.output } : undefined,
    }))
  }

  async createSession(directory?: string): Promise<SessionInfo> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-opencode-directory': encodeURIComponent(directory ?? this.directory),
    }
    const res = await fetch(`${this.url}/session`, {
      method: 'POST', headers, body: JSON.stringify({}),
    })
    if (!res.ok) throw new Error(`opencode API POST /session → ${res.status}: ${await res.text()}`)
    const s: any = await res.json()
    return {
      id: s.id,
      title: s.title || '(untitled)',
      directory: directory ?? this.directory,
      status: 'idle',
      created_at: s.time?.created ?? Date.now(),
    }
  }

  async sendPrompt(sessionId: string, text: string): Promise<void> {
    await this.request('POST', `/session/${sessionId}/message`, {
      parts: [{ type: 'text', text }],
    })
  }

  async abort(sessionId: string): Promise<void> {
    await this.request('POST', `/session/${sessionId}/abort`, {})
  }

  async replyPermission(requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void> {
    await this.request('POST', `/permission/${requestId}/reply`, { reply })
  }

  // ── SSE event stream ────────────────────────────────────────────────────────
  // Yields parsed event objects: { id, type, properties }
  async *subscribeSSE(signal: AbortSignal): AsyncGenerator<any> {
    const res = await fetch(
      `${this.url}/event?directory=${encodeURIComponent(this.directory)}`,
      {
        headers: { ...this.headers(), Accept: 'text/event-stream' },
        signal,
      },
    )
    if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`)

    const decoder = new TextDecoder()
    const reader = res.body.getReader()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE: messages are separated by double newlines
        const messages = buffer.split('\n\n')
        buffer = messages.pop() ?? ''

        for (const msg of messages) {
          const dataLine = msg.split('\n').find(l => l.startsWith('data: '))
          if (!dataLine) continue
          try {
            yield JSON.parse(dataLine.slice(6))
          } catch { /* skip malformed */ }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}

// ── opencode process manager ────────────────────────────────────────────────
// Spawns `opencode serve` and waits for it to print its URL.

import { spawn } from 'node:child_process'

export async function startOpenCodeServer(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('opencode', ['serve'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      windowsHide: true,
    })

    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error('Timed out waiting for opencode serve to start (30s)'))
    }, 30_000)

    const tryParse = (data: Buffer) => {
      const text = data.toString()
      process.stderr.write(`[opencode] ${text}`)
      // opencode prints: "opencode server listening on http://hostname:port"
      const m = text.match(/listening on (https?:\/\/[\w.:]+)/i)
      if (m) {
        clearTimeout(timeout)
        // Replace hostname with 127.0.0.1 for local connections
        resolve(m[1].replace(/localhost|0\.0\.0\.0/, '127.0.0.1'))
      }
    }

    proc.stdout?.on('data', tryParse)
    proc.stderr?.on('data', tryParse)
    proc.on('error', err => { clearTimeout(timeout); reject(err) })
    proc.on('exit', (code) => {
      clearTimeout(timeout)
      if (code !== 0) reject(new Error(`opencode serve exited with code ${code}`))
    })

    // Keep reference so it isn't GC'd
    ;(global as any).__opencodeProc = proc
  })
}
