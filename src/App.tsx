import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import { SessionInfo } from "./types";
import { TabBar } from "./components/SessionList";
import { TerminalView } from "./components/TerminalView";
import { NewSessionModal } from "./components/NewSessionModal";

export default function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    invoke<SessionInfo[]>("list_sessions").then(setSessions);

    const unlisten = listen<{ session_id: string; exit_code: number | null }>(
      "pty_exit",
      (e) => {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === e.payload.session_id ? { ...s, status: "exited" as const } : s
          )
        );
      }
    );

    // Intercept window close — ask for confirmation
    const appWindow = getCurrentWindow();
    const unlistenClose = appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      const ok = await confirm("确认关闭 xAgent？\n当前所有会话将终止。", {
        title: "关闭确认",
        kind: "warning",
      });
      if (ok) appWindow.destroy();
    });

    return () => {
      unlisten.then((fn) => fn());
      unlistenClose.then((fn) => fn());
    };
  }, []);

  const handleCreate = async (name: string, command: string, args: string[], cwd: string) => {
    const sessionId = await invoke<string>("start_session", {
      command,
      args,
      cwd,
      rows: 24,
      cols: 80,
    });
    const next: SessionInfo = {
      id: sessionId,
      name,
      command,
      cwd,
      status: "running",
      created_at: Date.now() / 1000,
    };
    setSessions((prev) => [...prev, next]);
    setActiveId(sessionId);
    setShowNew(false);
  };

  const handleKill = async (id: string) => {
    await invoke("kill_session", { sessionId: id });
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (activeId === id) {
      const remaining = sessions.filter((s) => s.id !== id);
      setActiveId(remaining.at(-1)?.id ?? null);
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <TabBar
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={() => setShowNew(true)}
        onKill={handleKill}
      />

      <div className="relative flex-1 min-h-0 overflow-hidden">
        {activeId ? (
          <TerminalView key={activeId} sessionId={activeId} />
        ) : (
          <EmptyState onNew={() => setShowNew(true)} />
        )}
      </div>

      {showNew && (
        <NewSessionModal onCreate={handleCreate} onClose={() => setShowNew(false)} />
      )}
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-zinc-500">
      <div className="text-5xl">⌨️</div>
      <p className="text-sm">还没有会话</p>
      <button
        onClick={onNew}
        className="px-4 py-2 text-sm bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-md text-zinc-300 transition-colors"
      >
        + 新建会话
      </button>
      <p className="text-xs text-zinc-700">支持 claude、copilot-cli、pwsh 等任意 CLI</p>
    </div>
  );
}

