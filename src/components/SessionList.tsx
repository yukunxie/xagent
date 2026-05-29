import { SessionInfo } from "../types";

interface Props {
  sessions: SessionInfo[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onKill: (id: string) => void;
}

export function TabBar({ sessions, activeId, onSelect, onNew, onKill }: Props) {
  return (
    <div className="flex items-end h-9 bg-zinc-950 border-b border-zinc-800 flex-shrink-0 select-none overflow-x-auto">
      {/* App label */}
      <div className="flex items-center px-3 h-full text-xs font-bold text-zinc-500 tracking-widest flex-shrink-0 border-r border-zinc-800">
        xAgent
      </div>

      {/* Tabs */}
      {sessions.map((s) => {
      const label = s.name || s.command.split(/[\\/]/).pop() || s.command;
      const icon  = s.wsUrl ? "🌐" : "🖥️";
        const isActive = s.id === activeId;
        return (
          <div
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`group relative flex items-center gap-2 px-3 h-full min-w-0 max-w-[180px] cursor-pointer flex-shrink-0 border-r border-zinc-800 transition-colors ${
              isActive
                ? "bg-zinc-900 text-zinc-100"
                : "bg-zinc-950 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
            }`}
          >
            {/* Active tab top accent */}
            {isActive && (
              <span className="absolute top-0 left-0 right-0 h-[2px] bg-emerald-500" />
            )}

            {/* Status dot */}
            <span
              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                s.status === "running" ? "bg-emerald-400" : "bg-zinc-600"
              }`}
            />

            {/* Type icon + Label */}
            <span className="text-xs flex-shrink-0 opacity-60">{icon}</span>
            <span className="text-xs font-mono truncate flex-1">{label}</span>

            {/* Close button */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onKill(s.id);
              }}
              className="w-4 h-4 flex items-center justify-center rounded text-zinc-600 hover:text-red-400 hover:bg-zinc-700 transition-all flex-shrink-0 opacity-0 group-hover:opacity-100"
              title="关闭"
            >
              ✕
            </button>
          </div>
        );
      })}

      {/* New tab button */}
      <button
        onClick={onNew}
        className="flex items-center justify-center w-8 h-full text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors flex-shrink-0 text-base"
        title="新建会话 (Ctrl+T)"
      >
        +
      </button>
    </div>
  );
}
