import { useEffect, useRef, useState } from "react";
import { device } from "./device.js";

// Full-width console: what was sent, what came back, and a prompt to type
// your own command. Timestamps carry milliseconds because the interesting
// question is usually how long the device took to answer.

const stamp = (t) => {
  const d = new Date(t);
  return d.toLocaleTimeString("en-GB", { hour12: false }) + "." +
    String(d.getMilliseconds()).padStart(3, "0");
};

export default function Logs({ log, onClear, live, onNote }) {
  const [autoScroll, setAutoScroll] = useState(true);
  const [cmd, setCmd] = useState("");
  const [history, setHistory] = useState([]);
  const [hIndex, setHIndex] = useState(-1);
  const [busy, setBusy] = useState(false);
  const body = useRef(null);

  useEffect(() => {
    if (!autoScroll) return;
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length, autoScroll]);

  const download = () => {
    const text = log
      .map((l) => `${stamp(l.at)}\t${l.dir === "send" ? "SEND" : "RECEIVE"}\t${l.text}`)
      .join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `anastasia-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const send = async () => {
    const text = cmd.trim();
    if (!text) return;
    setHistory((h) => [text, ...h.filter((x) => x !== text)].slice(0, 50));
    setHIndex(-1);
    setCmd("");
    if (!live) {
      // Echo into the real log path so the console is explorable offline.
      device.log("send", text);
      device.log("recv", `${text}: not connected (demo mode)`);
      return;
    }
    setBusy(true);
    try { await device.send(text); } catch (e) { onNote(e.message); } finally { setBusy(false); }
  };

  // Up/down walk the command history, like a shell.
  const onKey = (e) => {
    if (e.key === "Enter") { e.preventDefault(); send(); return; }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (!history.length) return;
    e.preventDefault();
    const next = e.key === "ArrowUp"
      ? Math.min(hIndex + 1, history.length - 1)
      : Math.max(hIndex - 1, -1);
    setHIndex(next);
    setCmd(next === -1 ? "" : history[next]);
  };

  return (
    <div className="logs">
      <div className="logs__bar">
        <button className="btn" onClick={download} disabled={!log.length}>Download</button>
        <button className="btn" onClick={onClear} disabled={!log.length}>Clear</button>
        <button
          className={"btn" + (autoScroll ? " btn--primary" : "")}
          aria-pressed={autoScroll}
          onClick={() => setAutoScroll((v) => !v)}
        >
          Auto-scroll
        </button>
        <span className="logs__count">Total entries: {log.length}</span>
      </div>

      <div className="logs__body" ref={body}>
        {log.length === 0 && <p className="empty">Nothing sent yet. Commands and replies appear here.</p>}
        {log.map((l, i) => (
          <div key={i} className={"logrow logrow--" + l.dir}>
            <span className="logrow__tag">{l.dir === "send" ? "SEND" : "RECEIVE"}</span>
            <time className="logrow__time">{stamp(l.at)}</time>
            <pre className="logrow__text">{l.text || "(no output)"}</pre>
          </div>
        ))}
      </div>

      <div className="logs__prompt">
        <input
          className="search"
          value={cmd}
          placeholder="Enter command..."
          aria-label="Command to send to the device"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={onKey}
        />
        <button className="btn" onClick={send} disabled={!cmd.trim() || busy}>Send</button>
      </div>
    </div>
  );
}
