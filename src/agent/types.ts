// Bridge protocol types (subset used by UI)

export interface SessionInfo {
  id: string
  title: string
  directory: string
  status: 'idle' | 'busy' | 'retry'
  created_at: number
}

export interface PermissionRequest {
  id: string
  session_id: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
}

export type ChatPart =
  | { type: 'user_text'; text: string }
  | { type: 'ai_text';   partId: string; text: string; done: boolean }
  | { type: 'reasoning'; partId: string; text: string }
  | { type: 'tool';      id: string; tool: string; title: string; input: Record<string, unknown>; output?: string; error?: string; status: 'pending' | 'running' | 'completed' | 'error' }
  | { type: 'error';     text: string }

export interface ChatMessage {
  id: string
  part: ChatPart
}
