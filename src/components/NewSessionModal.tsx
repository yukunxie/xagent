import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

const LAST_CWD_KEY  = "xagent:last_cwd";
const LAST_HOST_KEY = "xagent:last_host";

interface RemoteSession {
  id: string;
  command: string;
  cwd: string;
  created_at: number;
  is_local: boolean;
  status: string;
}

interface ScanResult {
  port: number;
  sessions: RemoteSession[];
}

interface Props {
  onCreate: (name: string, command: string, args: string[], cwd: string, wsUrl?: string, wsSessionId?: string) => void;
  onClose: () => void;
}

const PRESETS = [
  { label: "claude",      command: "claude", args: [] },
  { label: "copilot-cli", command: "gh",     args: ["copilot"] },
  { label: "PowerShell",  command: "pwsh",   args: [] },
  { label: "cmd",         command: "cmd",    args: [] },
];

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
  const [command,            setCommand]            = useState("");
  const [cwd,                setCwd]                = useState(() => localStorage.getItem(LAST_CWD_KEY) ?? "");

  // remote fields
  const [host,      setHost]      = useState(() => localStorage.getItem(LAST_HOST_KEY) ?? "127.0.0.1");
  const [scanState, setScanState] = useState<"idle" | "scanning" | "found" | "failed">("idle");
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [rCmd,      setRCmd]      = useState("");
  const [rName,     setRName]     = useState("");
  const [rNameME,   setRNameME]   = useState(false);

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
    const wsUrl  = `ws://${host.trim()}:${scanResult.port}`;
    const label  = `${host.trim()} · ${rs.command}`;
    onCreate(label, rs.command, [], rs.cwd, wsUrl, rs.id);
  };

  const handleNewRemote = () => {
    if (!scanResult || !rCmd.trim()) return;
    const [cmd, ...args] = rCmd.trim().split(/\s+/);
    const finalName = rName.trim() || `${host.trim()} · ${cmd}`;
    onCreate(finalName, cmd, args, "", `ws://${host.trim()}:${scanResult.port}`);
  };

  const handleLocalSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const [cmd, ...args] = command.trim().split(/\s+/);
    if (!cmd) return;
    const finalName = name.trim() || cmd.split(/[\\/]/).pop() || cmd;
    if (cwd.trim()) localStorage.setItem(LAST_CWD_KEY, cwd.trim());
    onCreate(finalName, cmd, args, cwd.trim());
  };

  const applyPreset = (preset: (typeof PRESETS)[number], remote = false) => {
    const full = [preset.command, ...preset.args].join(" ");
    if (remote) {
      setRCmd(full);
      if (!rNameME) setRName(preset.label);
    } else {
      setCommand(full);
      if (!nameManuallyEdited) setName(preset.label);
    }
  };

  const pickFolder = async () => {
    const selected = await open({
      directory: true, multiple: false,
      defaultPath: cwd || localStorage.getItem(LAST_CWD_KEY) || undefined,
    });
    if (typeof selected === "string") {
      setCwd(selected);
      localStorage.setItem(LAST_CWD_KEY, selected);
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
              {m === "local" ? "🖥️ 本地" : "🌐 远端"}
            </button>
          ))}
        </div>

        {mode === "local" ? (
          <>
            {/* Presets */}
            <div className="flex flex-wrap gap-2 mb-5">
              {PRESETS.map((p) => (
                <button key={p.label} type="button" onClick={() => applyPreset(p)}
                  className="px-3 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 rounded-md transition-colors font-mono">
                  {p.label}
                </button>
              ))}
            </div>
            <form onSubmit={handleLocalSubmit} className="space-y-4">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">会话名称 <span className="text-zinc-600">（留空自动生成）</span></label>
                <input autoFocus value={name}
                  onChange={(e) => { setName(e.target.value); setNameManuallyEdited(e.target.value !== ""); }}
                  placeholder="我的项目 / dev 环境 / ..."
                  className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500" />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">命令</label>
                <input value={command} onChange={(e) => setCommand(e.target.value)}
                  placeholder="claude  /  pwsh  /  自定义命令"
                  className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500 font-mono" />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">工作目录 <span className="text-zinc-600">（留空使用默认）</span></label>
                <div className="flex gap-2">
                  <input value={cwd} onChange={(e) => setCwd(e.target.value)}
                    placeholder="C:\Users\me\project"
                    className="flex-1 px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500 font-mono min-w-0" />
                  <button type="button" onClick={pickFolder} title="选择文件夹"
                    className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-md text-zinc-400 hover:text-zinc-100 transition-colors flex-shrink-0">📁</button>
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={onClose}
                  className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors">取消</button>
                <button type="submit" disabled={!command.trim()}
                  className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-md transition-colors">
                  启动
                </button>
              </div>
            </form>
          </>
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

            {/* Scan result */}
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

                {/* Existing sessions to attach */}
                {scanResult.sessions.length > 0 && (
                  <div>
                    <p className="text-xs text-zinc-400 mb-2">选择接入已有会话：</p>
                    <div className="space-y-1.5 max-h-40 overflow-y-auto">
                      {scanResult.sessions.map((rs) => (
                        <div key={rs.id}
                          className="flex items-center justify-between bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2">
                          <div className="min-w-0">
                            <span className="text-sm text-zinc-100 font-mono truncate block">{rs.command}</span>
                            <span className={`text-xs ${rs.status === "running" ? "text-emerald-400" : "text-zinc-500"}`}>
                              {rs.status === "running" ? "● 运行中" : "○ 已退出"}{rs.is_local ? " · 本地" : " · 远端"}{rs.cwd ? ` · ${rs.cwd}` : ""}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleAttach(rs)}
                            className="ml-3 px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors flex-shrink-0"
                          >
                            接入
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* New session on remote */}
                <div className="border-t border-zinc-700 pt-4">
                  <p className="text-xs text-zinc-400 mb-3">或在远端新建会话：</p>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {PRESETS.map((p) => (
                      <button key={p.label} type="button" onClick={() => applyPreset(p, true)}
                        className="px-3 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 rounded-md transition-colors font-mono">
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-zinc-400 mb-1">会话名称 <span className="text-zinc-600">（留空自动生成）</span></label>
                      <input value={rName}
                        onChange={(e) => { setRName(e.target.value); setRNameME(e.target.value !== ""); }}
                        placeholder="办公室 PC · claude"
                        className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500" />
                    </div>
                    <div>
                      <label className="block text-xs text-zinc-400 mb-1">远端命令</label>
                      <input value={rCmd} onChange={(e) => setRCmd(e.target.value)}
                        placeholder="claude  /  pwsh  /  自定义命令"
                        className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500 font-mono" />
                    </div>
                    <div className="flex justify-end gap-3">
                      <button type="button" onClick={onClose}
                        className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors">取消</button>
                      <button type="button" onClick={handleNewRemote} disabled={!rCmd.trim()}
                        className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-md transition-colors">
                        新建
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* Cancel when not yet scanned */}
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

