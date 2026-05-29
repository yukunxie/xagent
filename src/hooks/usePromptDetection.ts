import { useState, useCallback, useRef } from "react";

// Strip ANSI escape codes for plain-text pattern matching
const ANSI_STRIP = /\x1b\[[0-9;]*[mGKHFJABCDEFGSTsu]/g;

const PATTERNS: Array<{ regex: RegExp; type: "yn" | "anykey" | "input" }> = [
  { regex: /\(y\/n\)\s*[?:]?\s*$/i, type: "yn" },
  { regex: /\[y\/n\]\s*$/i, type: "yn" },
  { regex: /\[Y\/n\]\s*$/i, type: "yn" },
  { regex: /\[y\/N\]\s*$/i, type: "yn" },
  { regex: /\(yes\/no\)\s*[?:]?\s*$/i, type: "yn" },
  { regex: /press any key/i, type: "anykey" },
  { regex: /\?\s*$/, type: "input" },
  { regex: /:\s*$/, type: "input" },
];

const DEBOUNCE_MS = 300;

export function usePromptDetection() {
  const [prompt, setPrompt] = useState<"yn" | "anykey" | "input" | null>(null);
  const bufferRef = useRef("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setLastText = useCallback((text: string) => {
    bufferRef.current = (bufferRef.current + text).slice(-512); // keep last 512 chars
    const plain = bufferRef.current.replace(ANSI_STRIP, "");

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      for (const { regex, type } of PATTERNS) {
        if (regex.test(plain)) {
          setPrompt(type);
          return;
        }
      }
    }, DEBOUNCE_MS);
  }, []);

  const clearPrompt = useCallback(() => {
    setPrompt(null);
    bufferRef.current = "";
  }, []);

  return { prompt, setLastText, clearPrompt };
}
