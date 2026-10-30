import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { keepLinksOutOfPanel } from "./Md";
import "./index.css";

keepLinksOutOfPanel();

// An uncaught render/effect error would otherwise leave a blank panel. Show it,
// with a reload, so it can be reported instead of guessed at.
class Crash extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("[nexlify] panel crashed:", error);
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-screen flex-col items-start gap-3 bg-bg p-4 text-fg">
        <p className="text-sm font-semibold">The panel hit an error</p>
        <pre className="max-h-60 w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-elevated p-2.5 font-mono text-[11px] leading-snug text-muted">
          {error.message}
          {error.stack ? `\n\n${error.stack.split("\n").slice(1, 6).join("\n")}` : ""}
        </pre>
        <button
          onClick={() => location.reload()}
          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:opacity-90"
        >
          Reload panel
        </button>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Crash>
      <App />
    </Crash>
  </React.StrictMode>,
);
