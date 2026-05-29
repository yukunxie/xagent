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

export function TerminalView({ sessionId, isActive, wsUrl, wsSessionId, historyMode, command, args, cwd }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef      = useRef<Terminal | null>(null);
  const fitRef       = useRef<FitAddon | null>(null);
  const wsRef        = useRef<WebSocket | null>(null);
  const offsetRef    = useRef<number>(0);   // total bytes received (for delta reconnect)

  // Write queue: incoming bytes are enqueued; a RAF loop drains ≤64 KB per frame
  // This prevents the browser from freezing when replaying large history bursts.
  const writeQueueRef  = useRef<Uint8Array[]>([]);
  const rafRef         = useRef<number | null>(null);

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
    const t = setTimeout(() => {
      fitRef.current?.fit();
      termRef.current?.focus();
      const rows = termRef.current?.rows ?? 24;
      const cols = termRef.current?.cols ?? 80;
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

    const term = new Terminal({
      theme: {
        background: "#09090b", foreground: "#e4e4e7", cursor: "#a1a1aa",
        selectionBackground: "#3f3f46",
        black: "#18181b", red: "#f87171", green: "#4ade80", yellow: "#facc15",
        blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#e4e4e7",
        brightBlack: "#52525b", brightRed: "#fca5a5", brightGreen: "#86efac",
        brightYellow: "#fde047", brightBlue: "#93c5fd", brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9", brightWhite: "#f4f4f5",
      },
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
      fitAddon.fit();
      term.focus();
      if (ws) {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "resize", rows: term.rows, cols: term.cols }));
      } else {
        invoke("resize_session", { sessionId, rows: term.rows, cols: term.cols }).catch(() => {});
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
          ws.send(JSON.stringify({
            type:       "attach",
            session_id: wsSessionId,
            rows:       term.rows,
            cols:       term.cols,
            offset:     offsetRef.current, // 0 on first connect; delta on reconnect
            history:    historyMode ?? "1M",
          }));
        } else {
          ws.send(JSON.stringify({
            type:    "init",
            command: command ?? "pwsh",
            args:    args ?? [],
            cwd:     cwd ?? "",
            rows:    term.rows,
            cols:    term.cols,
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
            setLastText(new TextDecoder().decode(bytes));
          } else if (msg.type === "history_done") {
            setLoadingHistory(false);
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
      const observer = new ResizeObserver(() => {
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
      const observer = new ResizeObserver(() => {
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

  return (
    <div className="absolute inset-0 overflow-hidden" onClick={() => termRef.current?.focus()}>
      <div ref={containerRef} className="w-full h-full" />
      {loadingHistory && (
        <div style={{
          position: "absolute", top: 8, right: 12,
          background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
          border: "1px solid #3f3f46", borderRadius: "0.375rem",
          padding: "2px 10px", fontSize: "0.75rem", color: "#a1a1aa",
          pointerEvents: "none", zIndex: 10,
        }}>
          ⏳ 加载历史…
        </div>
      )}
      {prompt && (
        <PromptOverlay type={prompt} onSend={sendInput} onDismiss={clearPrompt} />
      )}
    </div>
  );
}
