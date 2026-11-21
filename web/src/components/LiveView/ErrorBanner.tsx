"use client";

import type { FeedState } from "@/lib/types";
import styles from "./ErrorBanner.module.css";

/** One line under the header when something needs attention: bot offline, no key on the Jev lane, or a recent error. */
export default function ErrorBanner({ feed, apiUrl, lane, onSettings }: { feed: FeedState; apiUrl: string; lane?: string; onSettings?: () => void }) {
  const { meta, connection, lastError } = feed;
  const recent = lastError && Date.now() - lastError.ts < 30_000 ? lastError : null;

  let text: string | null = null;
  let action: string | null = null;
  if (connection !== "live" && !meta) text = `Waiting for a game (nothing on ${apiUrl.replace(/^https?:\/\//, "")}). Between games the app checks every 5 min for the next live game with a reward pool. If the Kalble app is closed, open it.`;
  else if (lane === "jev" && meta && !meta.model.toLowerCase().startsWith("jev")) {
    text = meta.hasKey ? "This lane is running the mock model." : "No TypeSafe key yet, so this lane is running the mock model.";
    action = meta.hasKey ? "switch to jev" : "add key";
  } else if (recent) text = humanize(recent.message);

  if (!text) return null;
  return (
    <div className={styles.banner} role="status">
      <span>{text}</span>
      {action && onSettings ? <button type="button" className={styles.action} onClick={onSettings}>{action}</button> : null}
    </div>
  );
}

function humanize(m: string): string {
  if (/empty book side/.test(m)) return "The book is one-sided (game likely decided). Restart duo to pick a live game.";
  if (/429/.test(m)) return "Rate limited by the venue. Ticks are being skipped.";
  if (/401|403|unauthor|api key/i.test(m)) return "TypeSafe rejected the key. Open settings and paste a new one.";
  return m.length > 140 ? `${m.slice(0, 138)}…` : m;
}
