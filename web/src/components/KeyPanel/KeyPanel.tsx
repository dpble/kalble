"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./KeyPanel.module.css";

/**
 * Paste the TypeSafe key and pick the model for one bot. The key goes to that bot's local
 * /settings endpoint, which saves it to .env; it is never read back into the browser.
 */
export default function KeyPanel({ apiUrl, hasKey, hasOddsKey = false, model, strategy = "legacy", onClose }: { apiUrl: string; hasKey: boolean; hasOddsKey?: boolean; model: string; strategy?: string; onClose: () => void }) {
  const [key, setKey] = useState("");
  const [oddsKey, setOddsKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const isJev = model.toLowerCase().startsWith("jev");

  useEffect(() => {
    input.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  async function post(body: Record<string, string>, done: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`${apiUrl.replace(/\/+$/, "")}/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `http ${r.status}`);
      setKey("");
      setOddsKey("");
      setMsg({ ok: true, text: done });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "could not reach the bot" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.panel} role="dialog" aria-modal="true" aria-labelledby="keypanel-title">
        <div className={styles.head}>
          <h2 id="keypanel-title" className={styles.title}>Model settings</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>bot</span>
          <span className={styles.mono}>{apiUrl.replace(/^https?:\/\//, "")}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>model</span>
          <span className={styles.mono}>{model || "-"}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>typesafe key</span>
          <span className={hasKey ? styles.ok : styles.muted}>{hasKey ? "saved" : "not set"}</span>
        </div>

        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) void post({ apiKey: key.trim() }, "Key saved. This bot switches to Jev if it was waiting for one.");
          }}
        >
          <label className={styles.label} htmlFor="tsk">{hasKey ? "replace key" : "paste key"}</label>
          <div className={styles.inputRow}>
            <input
              id="tsk"
              ref={input}
              className={styles.input}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="from console.typesafe.ai/keys"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <button type="submit" className={styles.primary} disabled={busy || !key.trim()}>Save</button>
          </div>
        </form>

        <div className={styles.row}>
          <span className={styles.label}>odds api key</span>
          <span className={hasOddsKey ? styles.ok : styles.muted}>{hasOddsKey ? "saved" : "not set"}</span>
        </div>

        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (oddsKey.trim()) void post({ oddsKey: oddsKey.trim() }, "Odds API key saved. Odds-anchored bots pick it up on their next fetch.");
          }}
        >
          <label className={styles.label} htmlFor="oddsk">{hasOddsKey ? "replace odds key" : "paste odds key"}</label>
          <div className={styles.inputRow}>
            <input
              id="oddsk"
              className={styles.input}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="from the-odds-api.com"
              value={oddsKey}
              onChange={(e) => setOddsKey(e.target.value)}
            />
            <button type="submit" className={styles.primary} disabled={busy || !oddsKey.trim()}>Save</button>
          </div>
        </form>

        {/* Model switching resets the session, so only the Jev and legacy bots offer it: on a strategy tab it would relabel the bot and hide its losses. */}
        {["jev", "legacy"].includes(strategy) ? <div className={styles.switch}>
          <span className={styles.label}>run this bot on</span>
          <div className={styles.seg}>
            <button type="button" className={!isJev ? styles.segOn : styles.segOff} disabled={busy || !isJev} onClick={() => void post({ model: "mock" }, "Switched to mock. Stats reset.")}>mock</button>
            <button type="button" className={isJev ? styles.segOn : styles.segOff} disabled={busy || isJev || !hasKey} title={hasKey ? "" : "save a key first"} onClick={() => void post({ model: "jev" }, "Switched to Jev. Stats reset.")}>jev</button>
          </div>
        </div> : null}

        <p className={styles.note}>Switching model starts a fresh session on this bot. Settings only work from this computer.</p>
        {msg ? <p className={msg.ok ? styles.ok : styles.err} role="status">{msg.text}</p> : null}
      </div>
    </div>
  );
}
