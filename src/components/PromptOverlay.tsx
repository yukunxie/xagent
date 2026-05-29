interface Props {
  type: "yn" | "anykey" | "input";
  onSend: (text: string) => void;
  onDismiss: () => void;
}

export function PromptOverlay({ type, onSend, onDismiss }: Props) {
  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
      <div className="flex items-center gap-2 bg-zinc-800 border border-zinc-600 rounded-lg px-4 py-2 shadow-xl">
        <span className="text-xs text-zinc-400 mr-1">⚡ 需要确认</span>
        {type === "yn" && (
          <>
            <button
              onClick={() => onSend("y\r")}
              className="px-3 py-1 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-md transition-colors"
            >
              ✅ Yes
            </button>
            <button
              onClick={() => onSend("n\r")}
              className="px-3 py-1 text-sm bg-red-700 hover:bg-red-600 text-white rounded-md transition-colors"
            >
              ❌ No
            </button>
          </>
        )}
        {type === "anykey" && (
          <button
            onClick={() => onSend(" ")}
            className="px-3 py-1 text-sm bg-zinc-600 hover:bg-zinc-500 text-white rounded-md transition-colors"
          >
            ▶ 继续
          </button>
        )}
        {type === "input" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const input = (e.currentTarget.elements.namedItem("text") as HTMLInputElement).value;
              onSend(input + "\r");
            }}
            className="flex gap-2"
          >
            <input
              name="text"
            autoFocus={false}
              className="px-2 py-1 text-sm bg-zinc-700 border border-zinc-500 rounded text-zinc-100 outline-none focus:border-zinc-400 w-48"
              placeholder="输入内容…"
            />
            <button
              type="submit"
              className="px-3 py-1 text-sm bg-zinc-600 hover:bg-zinc-500 text-white rounded-md transition-colors"
            >
              发送
            </button>
          </form>
        )}
        <button
          onClick={onDismiss}
          className="ml-1 text-zinc-500 hover:text-zinc-300 text-xs"
          title="忽略"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
