import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { SessionInfo, HistoryMode } from "./types";
import { TabBar } from "./components/SessionList";
import { TerminalView } from "./components/TerminalView";
import { NewSessionModal } from "./components/NewSessionModal";

export default function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const appWindowRef = useRef(getCurrentWindow());
  const forceCloseRef = useRef(false); // skip confirmation on confirmed close

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

    // Keep remote client count badge up-to-date
    const unlistenRemote = listen<{ session_id: string; count: number }>(
      "remote_client_change",
      (e) => {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === e.payload.session_id ? { ...s, client_count: e.payload.count } : s
          )
        );
      }
    );

    // Intercept window close — show React confirmation modal
    const unlistenClose = appWindowRef.current.onCloseRequested((event) => {
      if (forceCloseRef.current) return; // user confirmed — let it close
      event.preventDefault();
      setShowCloseConfirm(true);
    });

    return () => {
      unlisten.then((fn) => fn());
      unlistenRemote.then((fn) => fn());
      unlistenClose.then((fn) => fn());
    };
  }, []);

  const handleCreate = async (name: string, command: string, args: string[], cwd: string, wsUrl?: string, wsSessionId?: string, historyMode?: HistoryMode) => {
    const next: SessionInfo = {
      id: "",
      name,
      command,
      args,
      cwd,
      status: "running",
      created_at: Date.now() / 1000,
      wsUrl,
      wsSessionId,
      historyMode,
    };

    if (wsUrl) {
      // Remote session — no Rust PTY, TerminalView manages WS directly
      next.id = `remote-${crypto.randomUUID()}`;
      setSessions((prev) => [...prev, next]);
      setActiveId(next.id);
      setShowNew(false);
      return;
    }

    const sessionId = await invoke<string>("start_session", {
      command,
      args,
      cwd,
      rows: 24,
      cols: 80,
    });
    next.id = sessionId;
    setSessions((prev) => [...prev, next]);
    setActiveId(sessionId);
    setShowNew(false);
  };

  const handleKill = async (id: string) => {
    const s = sessions.find((x) => x.id === id);
    if (!s?.wsUrl) await invoke("kill_session", { sessionId: id });
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

      {/* pointer-events-none prevents xterm from eating modal clicks */}
      <div
        className="relative flex-1 min-h-0 overflow-hidden"
        style={showCloseConfirm || showNew ? { pointerEvents: "none" } : undefined}
      >
        {sessions.length === 0 ? (
          <EmptyState onNew={() => setShowNew(true)} />
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              style={{ display: s.id !== activeId ? "none" : undefined, position: "absolute", inset: 0 }}
            >
              <TerminalView
                sessionId={s.id}
                isActive={s.id === activeId}
                wsUrl={s.wsUrl}
                wsSessionId={s.wsSessionId}
                historyMode={s.historyMode}
                clientCount={s.client_count ?? 0}
                command={s.command}
                args={s.args}
                cwd={s.cwd}
              />
            </div>
          ))
        )}
      </div>

      {showNew && (
        <NewSessionModal onCreate={handleCreate} onClose={() => setShowNew(false)} />
      )}

      {showCloseConfirm && (
        <CloseConfirmModal
          onConfirm={() => invoke("exit_app")}
          onCancel={() => setShowCloseConfirm(false)}
        />
      )}
    </div>
  );
}

function CloseConfirmModal({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)",
      }}
    >
      <div
        style={{
          background: "#18181b", border: "1px solid #3f3f46",
          borderRadius: "0.75rem", boxShadow: "0 25px 50px rgba(0,0,0,0.5)",
          width: "20rem", padding: "1.5rem",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.75rem" }}>
          <span style={{ fontSize: "1.5rem" }}>⚠️</span>
          <h2 style={{ color: "#f4f4f5", fontWeight: 600, fontSize: "0.9rem" }}>关闭 xAgent</h2>
        </div>
        <p style={{ color: "#a1a1aa", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
          当前所有会话将终止，确认关闭？
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
          <button
            autoFocus
            onClick={onCancel}
            style={{
              padding: "0.5rem 1rem", fontSize: "0.875rem",
              color: "#a1a1aa", background: "transparent", border: "none", cursor: "pointer",
            }}
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: "0.5rem 1rem", fontSize: "0.875rem",
              background: "#b91c1c", color: "#fff",
              border: "none", borderRadius: "0.375rem", cursor: "pointer",
            }}
          >
            确认关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-zinc-500">
      <div className="text-5xl">🤖</div>
      <p className="text-sm">还没有会话</p>
      <button
        onClick={onNew}
        className="px-4 py-2 text-sm bg-violet-700 hover:bg-violet-600 border border-violet-600 rounded-md text-zinc-100 transition-colors"
      >
        + 新建 opencode 会话
      </button>
      <p className="text-xs text-zinc-700">手机/浏览器可通过 agent.html 同步查看</p>
    </div>
  );
}

