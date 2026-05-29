export type HistoryMode = "all" | "10M" | "5M" | "1M" | "none";

export interface SessionInfo {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  status: "running" | "exited";
  created_at: number;
  wsUrl?: string;        // set for remote WS sessions
  wsSessionId?: string;  // if set: attach to this existing remote session ID
  historyMode?: HistoryMode;
  client_count?: number; // remote WS clients currently attached (local sessions only)
}
