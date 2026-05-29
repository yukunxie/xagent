export interface SessionInfo {
  id: string;
  name: string;
  command: string;
  cwd: string;
  status: "running" | "exited";
  created_at: number;
}
