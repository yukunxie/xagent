export interface SessionInfo {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  status: "running" | "exited";
  created_at: number;
  wsUrl?: string; // set for remote sessions
}
