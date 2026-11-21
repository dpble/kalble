"use client";

import StrategyTabs from "@/components/StrategyTabs/StrategyTabs";
import styles from "@/components/Compare/Compare.module.css";
import { RESULTS_URL, STRATEGIES } from "@/lib/config";
import { fmtUsd } from "@/lib/format";
import { usePoll } from "@/lib/usePoll";

interface Summary { strategy: string; sessions: number; running: number; net: number; netRange: [number, number] | null; netExSettle: number; maxDrawdown: number; spread: number; inventory: number; settlement: number; rewards: number; fees: number; model: number; worstDay: number; hit: { hits: number; n: number } | null; checklist: { label: string; ok: boolean | null }[]; explain: string }
interface Results { summaries: Summary[]; worstDayAll: number | null; gaps: { games: number; rowsLogged: number; feeBeating: number; medianEdge: number | null; medianFeeBeatingEdge?: number | null; medianFeeBeatingSecs?: number | null } | null }
const usd = (n: number) => fmtUsd(n, 2);
const legacy = (s: string) => s.startsWith("legacy");
const OLD: Record<string, string> = { mock: "Legacy (mock)", jev: "Legacy (jev)" };
/** legacy-<x>: the old mock/jev pair, or a strategy session from before the live fill feed (stale fills, not counted). */
const name = (s: string): string => s.startsWith("legacy-") ? OLD[s.slice(7)] ?? `${name(s.slice(7))} (stale fills, not counted)` : STRATEGIES.find((x) => x.id === s)?.label ?? s;

export default function Page() {
  const d = usePoll<Results>(RESULTS_URL, 60_000);
  const cards = d ? [...d.summaries].sort((a, b) => Number(legacy(a.strategy)) - Number(legacy(b.strategy))) : [];
  return (
    <div className={`card ${styles.page}`}>
      <div className={styles.body}>
        <div className={styles.market}><StrategyTabs current="results" /></div>
        {!d ? <div className={styles.verdict}>Results server is starting.</div> : (
          <>
            {cards.length === 0 ? <div className={styles.verdict}>No sessions recorded yet.</div> : null}
            {d.worstDayAll != null ? <div className={styles.muted} style={{ marginBottom: 8 }}>All bots together, worst point of any day: {usd(d.worstDayAll)} (the $25 daily limit is on this total).</div> : null}
            {cards.map((s) => (
              <section key={s.strategy} className={styles.lane} style={legacy(s.strategy) ? { opacity: 0.55 } : undefined}>
                <div className={styles.laneHead}><span className={styles.laneTitle}>{name(s.strategy)}</span><span className={styles.muted}>{s.sessions} finished{s.running ? ` · ${s.running} running` : ""}</span></div>
                <div className={styles.net} style={{ color: s.net === 0 ? "var(--ink)" : s.net > 0 ? "var(--pnl-pos)" : "var(--pnl-neg)" }}>
                  {usd(s.net)}<span className={styles.netLabel}>{s.netRange ? `95% range ex-settlement ${usd(s.netRange[0])} to ${usd(s.netRange[1])} per session` : "too few sessions for a range"}</span>
                </div>
                <dl className={styles.grid}>
                  {([["net ex-settlement", usd(s.netExSettle)], ["max drawdown", usd(-s.maxDrawdown)], ["rewards", usd(s.rewards)], ["round-trip spread", usd(s.spread)], ["inventory moves", usd(s.inventory)], ["luck after decided", usd(s.settlement)], ["fees", usd(-s.fees)], ["model cost", usd(-s.model)], ["worst point of a day", usd(s.worstDay)], ["hit rate", s.hit && s.hit.n ? `${Math.round((100 * s.hit.hits) / s.hit.n)}%` : "n/a"]] as [string, string][]).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
                </dl>
                <ul style={{ listStyle: "none", padding: 0, margin: "14px 0 8px", fontSize: 13 }}>
                  {s.checklist.map((c) => <li key={c.label}>{c.ok === null ? "check yourself" : c.ok ? "✓" : "✗"} {c.label}</li>)}
                </ul>
                <p className={styles.muted} style={{ margin: 0 }}>{s.explain}</p>
              </section>
            ))}
            {d.gaps ? (
              <section className={styles.lane}>
                <div className={styles.laneHead}><span className={styles.laneTitle}>Gap logger</span></div>
                <p className={styles.muted}>{d.gaps.games} games watched · {d.gaps.rowsLogged} rows · {d.gaps.feeBeating} fee-beating gaps · median edge (all rows) {d.gaps.medianEdge == null ? "n/a" : `${(d.gaps.medianEdge * 100).toFixed(1)}c`}{d.gaps.feeBeating ? ` · fee-beating gaps: median ${((d.gaps.medianFeeBeatingEdge ?? 0) * 100).toFixed(1)}c, lasting about ${Math.round(d.gaps.medianFeeBeatingSecs ?? 0)} s` : ""}</p>
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
