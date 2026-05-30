// ── Bridge Protocol Types ─────────────────────────────────────────────────────
//
// Messages from Bridge → Client
// Messages from Client → Bridge
//
// The bridge translates opencode SSE events into structured messages that
// UI clients can render as chat bubbles, tool cards, and permission dialogs.

// ─── Server → Client ──────────────────────────────────────────────────────────

export type ServerMessage =
  | { type: 'bridge.ready';     opencode_url: string }
  | { type: 'bridge.error';     message: string }

  // Session lifecycle
  | { type: 'session.list';     sessions: SessionInfo[] }
  | { type: 'session.created';  session: SessionInfo }
  | { type: 'session.updated';  session_id: string; title?: string }
  | { type: 'session.status';   session_id: string; status: 'idle' | 'busy' | 'retry'; retry_msg?: string }
  | { type: 'session.error';    session_id: string; error: string }

  // Text streaming (high-frequency delta events)
  | { type: 'text.delta';  session_id: string; message_id: string; part_id: string; delta: string }
  | { type: 'text.done';   session_id: string; message_id: string; part_id: string }

  // Reasoning / thinking (collapsed by default in UI)
  | { type: 'reasoning.delta'; session_id: string; message_id: string; part_id: string; delta: string }

  // Tool execution lifecycle
  | { type: 'tool.pending';   session_id: string; message_id: string; part_id: string; call_id: string; tool: string; input: Record<string, unknown> }
  | { type: 'tool.running';   session_id: string; message_id: string; part_id: string; call_id: string; tool: string; input: Record<string, unknown>; title?: string }
  | { type: 'tool.done';      session_id: string; message_id: string; part_id: string; tool: string; title: string; output: string }
  | { type: 'tool.error';     session_id: string; message_id: string; part_id: string; tool: string; error: string }

  // Permission: AI wants to run something, user must approve/reject
  | {
      type: 'permission.asked'
      id: string
      session_id: string
      permission: string        // 'write' | 'execute' | 'read' etc.
      patterns: string[]        // files/commands the tool wants to access
      metadata: Record<string, unknown>
      tool?: { message_id: string; call_id: string }
    }
  | { type: 'permission.replied'; id: string; session_id: string; reply: 'once' | 'always' | 'reject' }

  // User message echoed back (so all clients see it)
  | { type: 'user.message'; session_id: string; message_id: string; text: string }

// ─── Client → Server ──────────────────────────────────────────────────────────

export type ClientMessage =
  // Ask for current session list
  | { type: 'session.list' }
  // Create a new opencode session in the given directory
  | { type: 'session.create'; directory?: string }
  // Send a prompt to a session
  | { type: 'session.prompt'; session_id: string; text: string }
  // Reply to a permission request
  | { type: 'permission.reply'; id: string; reply: 'once' | 'always' | 'reject' }
  // Abort a running session
  | { type: 'session.abort'; session_id: string }

// ─── opencode domain types (subset we care about) ─────────────────────────────

export interface SessionInfo {
  id: string
  title: string
  directory: string
  status: 'idle' | 'busy' | 'retry'
  created_at: number
  cost?: number
  tokens?: { input: number; output: number }
}
