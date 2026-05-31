import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { HistoryMode } from "../types";

const LAST_CWD_KEY  = "xagent:last_cwd";
const LAST_HOST_KEY = "xagent:last_host";
const BRIDGE_PORT   = 9001;

interface RemoteSession {
  id: string;
  command: string;
  cwd: string;
  created_at: number;
  is_local: boolean;
  status: string;
  buffer_bytes: number;
}

interface ScanResult {
  port: number;
  sessions: RemoteSession[];
}

interface Props {
  onCreate: (name: string, command: string, args: string[], cwd: string, wsUrl?: string, wsSessionId?: string, historyMode?: HistoryMode) => void;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes >= 10 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  if (bytes >= 1024 * 1024)       return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024)               return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** Try ports 10337–10436 in parallel; return first that sends a "welcome" */
function scanForServer(host: string): Promise<ScanResult | null> {
  return new Promise((resolve) => {
    let done = false;
    let pending = 100;
    const sockets: WebSocket[] = [];

    const finish = (result: ScanResult | null) => {
      if (done) return;
      done = true;
      clearTimeout(overallTimeout);
      sockets.forEach((ws) => { try { ws.close(); } catch { /**/ } });
      resolve(result);
    };

    const overallTimeout = setTimeout(() => finish(null), 3000);

    for (let i = 0; i < 100; i++) {
      const port = 10337 + i;
      const ws = new WebSocket(`ws://${host}:${port}`);
      sockets.push(ws);
      let portDone = false;

      const portFinish = () => {
        if (portDone) return;
        portDone = true;
        pending--;
        if (pending === 0) finish(null);
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string);
          if (msg.type === "welcome") finish({ port, sessions: msg.sessions ?? [] });
        } catch { /**/ }
        portFinish();
      };
      ws.onerror = portFinish;
      ws.onclose = portFinish;
    }
  });
}

export function NewSessionModal({ onCreate, onClose }: Props) {
  const [mode, setMode] = useState<"local" | "remote">("local");

  // local fields
  const [name,               setName]               = useState("");
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const [cwd,                setCwd]                = useState(() => localStorage.getItem(LAST_CWD_KEY) ?? "");

  // remote fields
  const [host,        setHost]        = useState(() => localStorage.getItem(LAST_HOST_KEY) ?? "127.0.0.1");
  const [scanState,   setScanState]   = useState<"idle" | "scanning" | "found" | "failed">("idle");
  const [scanResult,  setScanResult]  = useState<ScanResult | null>(null);
  const [historyModes, setHistoryModes] = useState<Record<string, HistoryMode>>({});

  const handleScan = async () => {
    const h = host.trim();
    if (!h) return;
    setScanState("scanning");
    setScanResult(null);
    localStorage.setItem(LAST_HOST_KEY, h);
    const result = await scanForServer(h);
    if (result) {
      setScanResult(result);
      setScanState("found");
    } else {
      setScanState("failed");
    }
  };

  const handleAttach = (rs: RemoteSession) => {
    if (!scanResult) return;
    const wsUrl    = `ws://${host.trim()}:${scanResult.port}`;
    const label    = `${host.trim()} · ${rs.command}`;
    const histMode = historyModes[rs.id] ?? (rs.buffer_bytes > 512 * 1024 ? "1M" : "all");
    onCreate(label, rs.command, [], rs.cwd, wsUrl, rs.id, histMode);
  };

  const handleLocalSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const finalCwd = cwd.trim();
    const finalName = name.trim() || (finalCwd ? finalCwd.split(/[\\/]/).pop() || "opencode" : "opencode");
    if (finalCwd) localStorage.setItem(LAST_CWD_KEY, finalCwd);
    onCreate(finalName, "opencode", [], finalCwd);
  };

  const pickFolder = async () => {
    const selected = await open({
      directory: true, multiple: false,
      defaultPath: cwd || localStorage.getItem(LAST_CWD_KEY) || undefined,
    });
    if (typeof selected === "string") {
      setCwd(selected);
      localStorage.setItem(LAST_CWD_KEY, selected);
      if (!nameManuallyEdited) {
        setName(selected.split(/[\\/]/).pop() || "opencode");
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[480px] p-6 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Mode tabs */}
        <div className="flex mb-5 bg-zinc-800 rounded-lg p-1 gap-1">
          {(["local", "remote"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-sm rounded-md transition-colors font-medium ${
                mode === m
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {m === "local" ? "🤖 本地 opencode" : "🌐 远端"}
            </button>
          ))}
        </div>

        {mode === "local" ? (
          <form onSubmit={handleLocalSubmit} className="space-y-4">
            {/* Banner */}
            <div className="flex items-start gap-2 bg-zinc-800/60 border border-zinc-700 rounded-lg px-3 py-2.5 text-xs text-zinc-400">
              <span className="mt-0.5">💡</span>
              <span>
                新建会话将在本地启动 <span className="font-mono text-zinc-300">opencode</span>，
                同时可通过 <span className="font-mono text-zinc-300">ws://127.0.0.1:{BRIDGE_PORT}</span> 在手机/浏览器同步查看
              </span>
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">工作目录 <span className="text-zinc-600">（留空使用默认）</span></label>
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder="C:\Users\me\project"
                  className="flex-1 px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500 font-mono min-w-0"
                />
                <button type="button" onClick={pickFolder} title="选择文件夹"
                  className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-md text-zinc-400 hover:text-zinc-100 transition-colors flex-shrink-0">📁</button>
              </div>
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">会话名称 <span className="text-zinc-600">（留空自动使用目录名）</span></label>
              <input
                value={name}
                onChange={(e) => { setName(e.target.value); setNameManuallyEdited(e.target.value !== ""); }}
                placeholder="我的项目"
                className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500"
              />
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={onClose}
                className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors">取消</button>
              <button type="submit"
                className="px-4 py-2 text-sm bg-violet-600 hover:bg-violet-500 text-white rounded-md transition-colors">
                🚀 启动 opencode
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            {/* Host input + scan */}
            <div>
              <label className="block text-xs text-zinc-400 mb-1">远端 IP 地址</label>
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={host}
                  onChange={(e) => { setHost(e.target.value); setScanState("idle"); setScanResult(null); }}
                  onKeyDown={(e) => e.key === "Enter" && handleScan()}
                  placeholder="192.168.1.100"
                  className="flex-1 px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500 font-mono min-w-0"
                />
                <button
                  type="button"
                  onClick={handleScan}
                  disabled={!host.trim() || scanState === "scanning"}
                  className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-md transition-colors flex-shrink-0"
                >
                  {scanState === "scanning" ? "扫描中…" : "扫描"}
                </button>
              </div>
              <p className="text-xs text-zinc-600 mt-1">自动扫描端口 10337–10436，远端需运行 xAgent</p>
            </div>

            {scanState === "scanning" && (
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <span className="animate-spin">⏳</span> 正在探测端口…
              </div>
            )}

            {scanState === "failed" && (
              <div className="text-sm text-red-400 bg-red-950/40 border border-red-800/50 rounded-md px-3 py-2">
                未找到 xAgent 服务，请确认远端已启动并检查网络连通性
              </div>
            )}

            {scanState === "found" && scanResult && (
              <>
                <div className="text-xs text-emerald-400 mb-1">
                  ✓ 已找到服务（端口 {scanResult.port}）
                </div>

                {scanResult.sessions.length > 0 && (
                  <div>
                    <p className="text-xs text-zinc-400 mb-2">选择接入已有会话：</p>
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {scanResult.sessions.map((rs) => (
                        <div key={rs.id}
                          className="bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <span className="text-sm text-zinc-100 font-mono truncate block">{rs.command}</span>
                              <span className={`text-xs ${rs.status === "running" ? "text-emerald-400" : "text-zinc-500"}`}>
                                {rs.status === "running" ? "● 运行中" : "○ 已退出"}{rs.is_local ? " · 本地" : " · 远端"}{rs.cwd ? ` · ${rs.cwd}` : ""}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              {rs.buffer_bytes > 0 && (
                                <select
                                  value={historyModes[rs.id] ?? (rs.buffer_bytes > 512 * 1024 ? "1M" : "all")}
                                  onChange={(e) => setHistoryModes(prev => ({ ...prev, [rs.id]: e.target.value as HistoryMode }))}
                                  title={`历史数据：${formatBytes(rs.buffer_bytes)}`}
                                  className="text-xs bg-zinc-700 border border-zinc-600 rounded px-1.5 py-1 text-zinc-300 outline-none cursor-pointer"
                                >
                                  <option value="all">全部 ({formatBytes(rs.buffer_bytes)})</option>
                                  <option value="10M">最近 10 MB</option>
                                  <option value="5M">最近 5 MB</option>
                                  <option value="1M">最近 1 MB</option>
                                  <option value="none">不同步</option>
                                </select>
                              )}
                              <button
                                type="button"
                                onClick={() => handleAttach(rs)}
                                className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors"
                              >
                                接入
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {scanState === "idle" && (
              <div className="flex justify-end pt-1">
                <button type="button" onClick={onClose}
                  className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors">取消</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
