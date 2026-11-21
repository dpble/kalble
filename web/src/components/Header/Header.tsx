"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BlockEvent, ConnectionState, Meta } from "@/lib/types";
import Link from "next/link";
import { fmtInt, isPredictionMarket, shortAddr } from "@/lib/format";
import styles from "./Header.module.css";

export interface HeaderProps {
  meta: Meta | null;
  latest: BlockEvent | null;
  connection: ConnectionState;
  /** which page is showing, for the nav */
  lane?: "mock" | "jev" | "compare";
  /** opens the model/key panel */
  onSettings?: () => void;
}

/** Only shown when we are NOT live. Live is the silent, default state. */
const OFFLINE_LABEL: Partial<Record<ConnectionState, string>> = {
  connecting: "connecting",
  reconnecting: "reconnecting",
};

export default function Header({ meta, latest, connection, lane, onSettings }: HeaderProps) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const wallet = meta?.wallet ?? null;

  const onCopy = useCallback(() => {
    if (!wallet) return;
    try {
      void navigator.clipboard?.writeText(wallet)?.catch(() => {});
    } catch {
      /* clipboard unavailable, still flash "copied" so the click feels alive */
    }
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1200);
  }, [wallet]);

  const model = meta?.model ?? null;
  const isJev = (model ?? "").toLowerCase().startsWith("jev");
  const offline = OFFLINE_LABEL[connection] ?? null;

  return (
    <div className={styles.header}>
      <span className={styles.brand}>‖ Kalble</span>

      {lane ? (
        <nav className={styles.nav} aria-label="views">
          <Link href="/" className={lane === "mock" ? styles.navOn : styles.navLink}>mock</Link>
          <Link href="/jev" className={lane === "jev" ? styles.navOn : styles.navLink}>jev</Link>
          <Link href="/compare" className={lane === "compare" ? styles.navOn : styles.navLink}>compare</Link>
        </nav>
      ) : null}

      {latest ? (
        <span className={styles.block}>{isPredictionMarket() ? "tick" : "block"} {fmtInt(latest.block)}</span>
      ) : null}

      <span className={styles.spacer} />

      {offline ? <span className={styles.offline}>{offline}</span> : null}

      <button
        type="button"
        className={styles.wallet}
        onClick={onCopy}
        disabled={!wallet}
        title={wallet ?? "no wallet, dry run"}
        aria-label={wallet ? `Copy wallet address ${wallet}` : "Dry run"}
      >
        {copied ? "copied" : wallet ? shortAddr(wallet) : "dry run"}
      </button>

      {onSettings ? (
        <button type="button" className={styles.wallet} onClick={onSettings} title="TypeSafe key and model">
          {meta?.hasKey ? "settings" : "add key"}
        </button>
      ) : null}

      {model ? (
        <span
          className={styles.badge}
          style={{
            background: isJev
              ? "var(--badge-jev-bg)"
              : "var(--badge-standin-bg)",
            color: isJev ? "var(--badge-jev-fg)" : "var(--badge-standin-fg)",
          }}
        >
          {model}
        </span>
      ) : null}
    </div>
  );
}
