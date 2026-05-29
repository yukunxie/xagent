import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { PromptOverlay } from "./PromptOverlay";
import { usePromptDetection } from "../hooks/usePromptDetection";
import { HistoryMode } from "../types";

interface Props {
  sessionId:    string;
  isActive?:    boolean;      // controlled by parent — triggers fit/focus on tab switch
  wsUrl?:       string;       // if set: remote WebSocket session
  wsSessionId?: string;       // if set: attach to existing remote session
  historyMode?: HistoryMode;  // how much history to sync on attach
  clientCount?: number;       // remote clients attached to this local session
  command?:     string;
  args?:        string[];
  cwd?:         string;
}

// Encode a JS string to base64 (UTF-8 safe)
function encodeBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

// ── Terminal themes ───────────────────────────────────────────────────────────
// Local: near-black "Zinc" dark theme
const LOCAL_THEME = {
  background:          "#09090b",
  foreground:          "#e4e4e7",
  cursor:              "#a1a1aa",
  selectionBackground: "#3f3f46",
  black:               "#18181b", red:           "#f87171", green:     "#4ade80", yellow:       "#facc15",
  blue:                "#60a5fa", magenta:       "#c084fc", cyan:      "#22d3ee", white:        "#e4e4e7",
  brightBlack:         "#52525b", brightRed:     "#fca5a5", brightGreen: "#86efac", brightYellow: "#fde047",
  brightBlue:          "#93c5fd", brightMagenta: "#d8b4fe", brightCyan: "#67e8f9", brightWhite:  "#f4f4f5",
};

// Remote: PyCharm Darcula theme
const REMOTE_THEME = {
  background:          "#2b2b2b",
  foreground:          "#a9b7c6",
  cursor:              "#bbbbbb",
  selectionBackground: "#214283",
  black:               "#3c3f41", red:           "#cc666e", green:     "#629755", yellow:       "#bbb529",
  blue:                "#6897bb", magenta:       "#b55b8f", cyan:      "#629755", white:        "#bbbbbb",
  brightBlack:         "#808080", brightRed:     "#ff6b68", brightGreen: "#57a64a", brightYellow: "#ffe400",
  brightBlue:          "#4e9ee7", brightMagenta: "#c878be", brightCyan: "#00e2e2", brightWhite:  "#ffffff",
};

export function TerminalView({ sessionId, isActive, wsUrl, wsSessionId, historyMode, clientCount = 0, command, args, cwd }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef      = useRef<Terminal | null>(null);
  const fitRef       = useRef<FitAddon | null>(null);
  const wsRef        = useRef<WebSocket | null>(null);
  const offsetRef    = useRef<number>(0);   // total bytes received (for delta reconnect)

  // Write queue: incoming bytes are enqueued; a RAF loop drains ≤64 KB per frame
  // This prevents the browser from freezing when replaying large history bursts.
  const writeQueueRef  = useRef<Uint8Array[]>([]);
  const rafRef         = useRef<number | null>(null);

  const loadingHistoryRef = useRef(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const { prompt, setLastText, clearPrompt } = usePromptDetection();

  // ── Write-queue helpers ────────────────────────────────────────────────────
  const flushQueue = () => {
    const term  = termRef.current;
    const queue = writeQueueRef.current;
    if (!term || queue.length === 0) { rafRef.current = null; return; }

    const MAX_PER_FRAME = 64 * 1024; // 64 KB per animation frame
    let written = 0;
    while (queue.length > 0 && written < MAX_PER_FRAME) {
      const chunk = queue.shift()!;
      term.write(chunk);
      written += chunk.length;
    }
    if (queue.length > 0) {
      rafRef.current = requestAnimationFrame(flushQueue);
    } else {
      rafRef.current = null;
    }
  };

  const enqueueWrite = (bytes: Uint8Array) => {
    writeQueueRef.current.push(bytes);
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(flushQueue);
    }
  };

  // ── isActive: fit + focus when tab becomes visible ────────────────────────
  useEffect(() => {
    if (!isActive || !fitRef.current) return;
    // Give the browser one paint cycle to un-hide the container before measuring
    const t = setTimeout(() => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      fitRef.current?.fit();
      termRef.current?.focus();
      const rows = termRef.current?.rows ?? 24;
      const cols = termRef.current?.cols ?? 80;
      if (rows === 0 || cols === 0) return;
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "resize", rows, cols }));
      } else if (!wsRef.current) {
        invoke("resize_session", { sessionId, rows, cols }).catch(() => {});
      }
    }, 50);
    return () => clearTimeout(t);
  }, [isActive, sessionId]);

  // ── Main terminal setup (runs once per session) ───────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const isRemote = !!wsUrl;

    const term = new Terminal({
      theme: isRemote ? REMOTE_THEME : LOCAL_THEME,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Menlo, Monaco, Consolas, monospace",
      cursorBlink: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    term.focus();
    termRef.current = term;
    fitRef.current  = fitAddon;

    const syncSize = (ws?: WebSocket) => {
      // Guard: don't resize when container is hidden (display:none → 0×0 → PTY corruption)
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      fitAddon.fit();
      const { rows, cols } = term;
      if (rows === 0 || cols === 0) return;
      term.focus();
      if (ws) {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "resize", rows, cols }));
      } else {
        invoke("resize_session", { sessionId, rows, cols }).catch(() => {});
      }
    };

    let cleanup: () => void;

    if (wsUrl) {
      // ── Remote WebSocket path ────────────────────────────────────────────
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        fitAddon.fit();
        if (wsSessionId) {
          setLoadingHistory(true);
          loadingHistoryRef.current = true;
          ws.send(JSON.stringify({
            type:       "attach",
            session_id: wsSessionId,
            rows:       term.rows || 24,
            cols:       term.cols || 80,
            offset:     offsetRef.current,
            history:    historyMode ?? "1M",
          }));
        } else {
          ws.send(JSON.stringify({
            type:    "init",
            command: command ?? "pwsh",
            args:    args ?? [],
            cwd:     cwd ?? "",
            rows:    term.rows || 24,
            cols:    term.cols || 80,
          }));
        }
        term.focus();
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string);
          if (msg.type === "output") {
            const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
            offsetRef.current += bytes.length;
            enqueueWrite(bytes);
            // Skip prompt detection during history replay to avoid excessive re-renders
            if (!loadingHistoryRef.current) setLastText(new TextDecoder().decode(bytes));
          } else if (msg.type === "history_done") {
            loadingHistoryRef.current = false;
            setLoadingHistory(false);
            if (msg.total_bytes > 0) {
              // Separator so user can see where history ends and live output begins
              const kb = Math.round((msg.total_bytes as number) / 1024);
              const sep = new TextEncoder().encode(
                `\r\n\x1b[90m─── 历史回放完成 (${kb} KB) ───\x1b[0m\r\n`
              );
              enqueueWrite(sep);
            }
            // Ensure terminal is scrolled to show the latest output
            setTimeout(() => termRef.current?.scrollToBottom(), 100);
          } else if (msg.type === "exit") {
            term.writeln("\r\n\x1b[90m[remote process exited]\x1b[0m");
          } else if (msg.type === "error") {
            term.writeln(`\r\n\x1b[31m[error] ${msg.message}\x1b[0m`);
          }
        } catch { /* ignore */ }
      };

      ws.onerror = () => { setLoadingHistory(false); term.writeln("\r\n\x1b[31m[connection error]\x1b[0m"); };
      ws.onclose = () => { setLoadingHistory(false); term.writeln("\r\n\x1b[90m[disconnected]\x1b[0m"); };

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "input", data: encodeBase64(data) }));
      });

      const initTimer = setTimeout(() => syncSize(ws), 50);
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const observer = new ResizeObserver((entries) => {
        // Ignore when container is hidden (display:none → 0×0 → would corrupt PTY size)
        const entry = entries[0];
        if (!entry || entry.contentRect.width === 0 || entry.contentRect.height === 0) return;
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => syncSize(ws), 150);
      });
      observer.observe(containerRef.current!);

      cleanup = () => {
        clearTimeout(initTimer);
        if (resizeTimer) clearTimeout(resizeTimer);
        if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
        writeQueueRef.current = [];
        observer.disconnect();
        ws.close();
        term.dispose();
      };

    } else {
      // ── Local PTY path ────────────────────────────────────────────────────
      term.onData((data) => {
        invoke("write_to_session", {
          sessionId,
          data: Array.from(new TextEncoder().encode(data)),
        }).catch(console.error);
      });

      const unlistenData = listen<{ session_id: string; data: string }>("pty_data", (event) => {
        if (event.payload.session_id !== sessionId) return;
        const bytes = Uint8Array.from(atob(event.payload.data), (c) => c.charCodeAt(0));
        enqueueWrite(bytes);
        setLastText(new TextDecoder().decode(bytes));
      });

      const unlistenExit = listen<{ session_id: string }>("pty_exit", (event) => {
        if (event.payload.session_id !== sessionId) return;
        term.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
      });

      const initTimer = setTimeout(() => syncSize(), 50);
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry || entry.contentRect.width === 0 || entry.contentRect.height === 0) return;
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => syncSize(), 150);
      });
      observer.observe(containerRef.current!);

      cleanup = () => {
        clearTimeout(initTimer);
        if (resizeTimer) clearTimeout(resizeTimer);
        if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
        writeQueueRef.current = [];
        unlistenData.then((fn) => fn());
        unlistenExit.then((fn) => fn());
        observer.disconnect();
        term.dispose();
      };
    }

    return cleanup;
  }, [sessionId, wsUrl, wsSessionId]); // stable deps — terminal lives for the session's lifetime

  const sendInput = (text: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "input", data: encodeBase64(text) }));
    } else {
      invoke("write_to_session", {
        sessionId,
        data: Array.from(new TextEncoder().encode(text)),
      }).catch(console.error);
    }
    clearPrompt();
    termRef.current?.focus();
  };

  const isRemote = !!wsUrl;

  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={isRemote ? {
        background:  "#2b2b2b",
        borderTop:   "2px solid #4e7cbf",
      } : {
        background: "#09090b",
      }}
      onClick={() => termRef.current?.focus()}
    >
      <div ref={containerRef} className="w-full h-full" />

      {/* Top-right badge area */}
      <div style={{
        position: "absolute", top: 6, right: 10,
        display: "flex", gap: "6px", alignItems: "center",
        pointerEvents: "none", zIndex: 10,
      }}>
        {/* Loading history spinner */}
        {loadingHistory && (
          <div style={{
            background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
            border: "1px solid #3f3f46", borderRadius: "0.25rem",
            padding: "1px 8px", fontSize: "0.7rem", color: "#a1a1aa",
          }}>
            ⏳ 加载历史…
          </div>
        )}

        {/* Remote session indicator */}
        {isRemote && (
          <div style={{
            background: "#214283", border: "1px solid #4e7cbf",
            borderRadius: "0.25rem", padding: "1px 7px",
            fontSize: "0.7rem", color: "#a9c9f5", letterSpacing: "0.04em",
          }}>
            ⚡ REMOTE
          </div>
        )}

        {/* Local session with connected clients */}
        {!isRemote && clientCount > 0 && (
          <div style={{
            background: "rgba(250,204,21,0.12)", border: "1px solid #a16207",
            borderRadius: "0.25rem", padding: "1px 7px",
            fontSize: "0.7rem", color: "#fde047", letterSpacing: "0.04em",
          }}>
            🔗 {clientCount} 远端已连接
          </div>
        )}
      </div>

      {prompt && (
        <PromptOverlay type={prompt} onSend={sendInput} onDismiss={clearPrompt} />
      )}
    </div>
  );
}
