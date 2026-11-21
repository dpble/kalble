"use client";

import type { BlockEvent } from "@/lib/types";
import { fmtUsd } from "@/lib/format";
import styles from "./Compare.module.css";

const W = 1000, H = 260, PAD = 8;

/** P&L in dollars over wall-clock time for each lane, on one shared scale. */
export default function PnlChart({ lanes }: { lanes: { id: string; name: string; color: string; events: BlockEvent[] }[] }) {
  const all = lanes.flatMap((l) => l.events);
  if (all.length < 2) return <div className={styles.chartEmpty}>waiting for both bots…</div>;

  const t0 = Math.min(...all.map((e) => e.ts)), t1 = Math.max(...all.map((e) => e.ts));
  const vals = all.map((e) => e.totals.pnlUsd);
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  if (hi - lo < 0.5) { const m = (hi + lo) / 2; lo = m - 0.25; hi = m + 0.25; } // keep a flat start from looking dramatic
  const x = (t: number) => PAD + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * PAD);
  const y = (v: number) => PAD + (1 - (v - lo) / (hi - lo)) * (H - 2 * PAD);
  const path = (ev: BlockEvent[]) => ev.map((e, i) => `${i ? "L" : "M"}${x(e.ts).toFixed(1)} ${y(e.totals.pnlUsd).toFixed(1)}`).join(" ");

  return (
    <div className={styles.chart}>
      <div className={styles.axis}>
        <span>{fmtUsd(hi, 2)}</span>
        <span>{fmtUsd(lo, 2)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={styles.svg} role="img" aria-label="P&L over time per model">
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} className={styles.zero} vectorEffect="non-scaling-stroke" />
        {lanes.map((l) => (
          <path key={l.id} d={path(l.events)} fill="none" stroke={l.color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        ))}
      </svg>
      <div className={styles.legend}>
        {lanes.map((l) => (
          <span key={l.id}><i style={{ background: l.color }} />{l.name} {fmtUsd(l.events.at(-1)?.totals.pnlUsd ?? 0, 2)}</span>
        ))}
      </div>
    </div>
  );
}
