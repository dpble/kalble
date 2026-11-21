"use client";

import StrategyTabs from "@/components/StrategyTabs/StrategyTabs";
import styles from "@/components/Compare/Compare.module.css";
import { GAPS_URL } from "@/lib/config";
import { usePoll } from "@/lib/usePoll";

interface Row { ts: number; label: string; polyBid: number; polyAsk: number; kalBid: number; kalAsk: number; gap: number; edge: number; dir: string }
interface Gaps { rows: Row[]; summary: { games: number; rowsLogged: number; feeBeating: number; medianEdge: number | null } }
const c = (n: number) => `${(n * 100).toFixed(1)}c`;

export default function Page() {
  const d = usePoll<Gaps>(GAPS_URL, 10_000);
  return (
    <div className={`card ${styles.page}`}>
      <div className={styles.body}>
        <div className={styles.market}><StrategyTabs current="gaps" /></div>
        {!d ? <div className={styles.verdict}>Gap logger is off or starting.</div> : (
          <>
            <div className={styles.verdict}>
              {d.summary.games} games watched · {d.summary.rowsLogged} rows · {d.summary.feeBeating} fee-beating gaps · median edge (all rows) {d.summary.medianEdge == null ? "n/a" : c(d.summary.medianEdge)}
            </div>
            <section className={styles.chartCard}>
              <div className={styles.sectionLabel}>LAST 50 ROWS</div>
              <table style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 12, borderCollapse: "collapse" }}>
                <thead><tr>{["time", "market", "poly bid", "poly ask", "kalshi bid", "kalshi ask", "gap", "edge", "dir"].map((h) => <th key={h} style={{ textAlign: "left", color: "var(--muted)", fontWeight: 400 }}>{h}</th>)}</tr></thead>
                <tbody>
                  {d.rows.slice(-50).reverse().map((r, i) => (
                    <tr key={i}>
                      <td>{new Date(r.ts).toLocaleTimeString()}</td><td>{r.label}</td><td>{c(r.polyBid)}</td><td>{c(r.polyAsk)}</td><td>{c(r.kalBid)}</td><td>{c(r.kalAsk)}</td><td>{c(r.gap)}</td>
                      <td style={{ color: r.edge > 0 ? "var(--pnl-pos)" : "var(--pnl-neg)" }}>{c(r.edge)}</td><td>{r.dir}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
