import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { PromptOverlay } from "./PromptOverlay";
import { usePromptDetection } from "../hooks/usePromptDetection";

interface Props {
  sessionId: string;
}

export function TerminalView({ sessionId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const { prompt, setLastText, clearPrompt } = usePromptDetection();

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: {
        background: "#09090b",
        foreground: "#e4e4e7",
        cursor: "#a1a1aa",
        selectionBackground: "#3f3f46",
        black: "#18181b",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e4e4e7",
        brightBlack: "#52525b",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde047",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#f4f4f5",
      },
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Menlo, Monaco, Consolas, monospace",
      cursorBlink: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);
    term.focus(); // ensure keyboard input works immediately
    termRef.current = term;
    fitRef.current = fitAddon;

    // Fit and immediately sync PTY size so TUI apps render correctly
    const syncSize = () => {
      fitAddon.fit();
      term.focus(); // fitAddon.fit() may steal focus; restore it immediately
      invoke("resize_session", {
        sessionId,
        rows: term.rows,
        cols: term.cols,
      }).catch(() => {/* session may not exist yet on first call */});
    };

    // Small delay to let the DOM settle before measuring
    const initTimer = setTimeout(syncSize, 50);

    // Send keyboard input to PTY
    term.onData((data) => {
      invoke("write_to_session", {
        sessionId,
        data: Array.from(new TextEncoder().encode(data)),
      }).catch(console.error);
    });

    // Receive PTY output
    const unlistenData = listen<{ session_id: string; data: string }>(
      "pty_data",
      (event) => {
        if (event.payload.session_id !== sessionId) return;
        const bytes = Uint8Array.from(
          atob(event.payload.data),
          (c) => c.charCodeAt(0)
        );
        term.write(bytes);
        setLastText(new TextDecoder().decode(bytes));
      }
    );

    const unlistenExit = listen<{ session_id: string }>("pty_exit", (event) => {
      if (event.payload.session_id !== sessionId) return;
      term.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
    });

    // Resize both xterm and PTY when container resizes (debounced to avoid focus thrash)
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(syncSize, 150);
    });
    observer.observe(containerRef.current);

    return () => {
      clearTimeout(initTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      unlistenData.then((fn) => fn());
      unlistenExit.then((fn) => fn());
      observer.disconnect();
      term.dispose();
    };
  }, [sessionId]);

  const sendInput = (text: string) => {
    invoke("write_to_session", {
      sessionId,
      data: Array.from(new TextEncoder().encode(text)),
    }).catch(console.error);
    clearPrompt();
    termRef.current?.focus();
  };

  return (
    <div className="absolute inset-0 overflow-hidden" onClick={() => termRef.current?.focus()}>
      <div ref={containerRef} className="w-full h-full" />
      {prompt && (
        <PromptOverlay
          type={prompt}
          onSend={sendInput}
          onDismiss={clearPrompt}
        />
      )}
    </div>
  );
}
