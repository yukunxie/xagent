import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import AgentApp from "./agent/AgentApp";

export default function App() {
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const appWindowRef = useRef(getCurrentWindow());

  useEffect(() => {
    const unlistenClose = appWindowRef.current.onCloseRequested((event) => {
      event.preventDefault();
      setShowCloseConfirm(true);
    });
    return () => { unlistenClose.then((fn) => fn()); };
  }, []);

  return (
    <>
      <AgentApp />

      {showCloseConfirm && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)",
          }}
        >
          <div
            style={{
              background: "#161b22", border: "1px solid #30363d",
              borderRadius: "0.75rem", boxShadow: "0 25px 50px rgba(0,0,0,0.5)",
              width: "20rem", padding: "1.5rem",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.75rem" }}>
              <span style={{ fontSize: "1.5rem" }}>⚠️</span>
              <h2 style={{ color: "#e6edf3", fontWeight: 600, fontSize: "0.9rem" }}>关闭 xAgent</h2>
            </div>
            <p style={{ color: "#7d8590", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
              确认关闭 xAgent？
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
              <button
                autoFocus
                onClick={() => setShowCloseConfirm(false)}
                style={{
                  padding: "0.5rem 1rem", fontSize: "0.875rem",
                  color: "#7d8590", background: "transparent", border: "none", cursor: "pointer",
                }}
              >
                取消
              </button>
              <button
                onClick={() => invoke("exit_app")}
                style={{
                  padding: "0.5rem 1rem", fontSize: "0.875rem",
                  background: "#da3633", color: "#fff",
                  border: "none", borderRadius: "0.375rem", cursor: "pointer",
                }}
              >
                确认关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

