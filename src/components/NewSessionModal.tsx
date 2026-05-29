import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

const LAST_CWD_KEY = "xagent:last_cwd";

interface Props {
  onCreate: (name: string, command: string, args: string[], cwd: string) => void;
  onClose: () => void;
}

const PRESETS = [
  { label: "claude", command: "claude", args: [] },
  { label: "copilot-cli", command: "gh", args: ["copilot"] },
  { label: "PowerShell", command: "pwsh", args: [] },
  { label: "cmd", command: "cmd", args: [] },
];

export function NewSessionModal({ onCreate, onClose }: Props) {
  const [name, setName] = useState("");
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState(() => localStorage.getItem(LAST_CWD_KEY) ?? "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const [cmd, ...args] = command.trim().split(/\s+/);
    if (cmd) {
      const finalName = name.trim() || cmd.split(/[\\/]/).pop() || cmd;
      if (cwd.trim()) localStorage.setItem(LAST_CWD_KEY, cwd.trim());
      onCreate(finalName, cmd, args, cwd);
    }
  };

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setCommand([preset.command, ...preset.args].join(" "));
    if (!nameManuallyEdited) setName(preset.label);
  };

  const pickFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
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
        className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[480px] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-zinc-100 mb-5">新建会话</h2>

        {/* Presets */}
        <div className="flex flex-wrap gap-2 mb-5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => applyPreset(p)}
              className="px-3 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 rounded-md transition-colors font-mono"
            >
              {p.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Session name */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1">
              会话名称 <span className="text-zinc-600">（留空自动生成）</span>
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameManuallyEdited(e.target.value !== "");
              }}
              placeholder="我的项目 / dev 环境 / ..."
              className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500"
            />
          </div>

          {/* Command */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1">命令</label>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="claude  /  pwsh  /  自定义命令"
              className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500 font-mono"
            />
          </div>

          {/* Working directory */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1">
              工作目录 <span className="text-zinc-600">（留空使用默认）</span>
            </label>
            <div className="flex gap-2">
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="C:\Users\me\project"
                className="flex-1 px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 placeholder-zinc-600 outline-none focus:border-zinc-500 font-mono min-w-0"
              />
              <button
                type="button"
                onClick={pickFolder}
                title="选择文件夹"
                className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-md text-zinc-400 hover:text-zinc-100 transition-colors flex-shrink-0"
              >
                📁
              </button>
            </div>
          </div>

          {/* Buttons */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={!command.trim()}
              className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-md transition-colors"
            >
              启动
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
