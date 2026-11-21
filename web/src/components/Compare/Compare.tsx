"use client";

import { useMemo, useState } from "react";
import Header from "@/components/Header/Header";
import KeyPanel from "@/components/KeyPanel/KeyPanel";
import ErrorBanner from "@/components/LiveView/ErrorBanner";
import { apiFor, SLOTS, STRATEGIES, type Strategy } from "@/lib/config";
import { fmtInt, fmtPrice, fmtUsd, hhmmss } from "@/lib/format";
import { laneStats, type LaneStats } from "@/lib/stats";
import type { BlockEvent, FeedState } from "@/lib/types";
import { useFeed } from "@/lib/useFeed";
import StrategyTabs from "@/components/StrategyTabs/StrategyTabs";
import PnlChart from "./PnlChart";
import styles from "./Compare.module.css";

const COLORS = { mock: "var(--muted-2)", jev: "var(--link)" };

/** The reward farmer vs one strategy on the same game (mock = farmer, jev = the test lane); a strategy with no test lane shows one card. */
export default function Compare({ slot = 1, strategy = "farmer" }: { slot?: number; strategy?: Strategy }) {
  const { base, test } = apiFor(slot, strategy);
  const API = { mock: base, jev: test ?? base };
  const label = STRATEGIES.find((x) => x.id === strategy)!.label;
  const mock = useFeed(base);
  const jev = useFeed(test ?? "");
  const [settings, setSettings] = useState(false);

  // Only compare the window both sessions cover (a model swap resets a session).
  const since = test ? Math.max(mock.meta?.startedAt ?? 0, jev.meta?.startedAt ?? 0) : mock.meta?.startedAt ?? 0;
  const ev = useMemo(() => ({ mock: mock.events.filter((e) => e.ts >= since), jev: jev.events.filter((e) => e.ts >= since) }), [mock.events, jev.events, since]);
  const horizon = jev.meta?.horizonBlocks ?? mock.meta?.horizonBlocks ?? 30;
  const jevIsJev = !!jev.meta?.model.toLowerCase().startsWith("jev");
  const s = { mock: laneStats(ev.mock, horizon, true), jev: laneStats(ev.jev, horizon, !jevIsJev) };
  const sameMarket = !test || !mock.meta || !jev.meta || mock.meta.market === jev.meta.market;
  const game = (jev.latest ?? mock.latest)?.game;
  const head = test ? jev : mock;
  const halted = !!(mock.meta?.halted || (test && jev.meta?.halted));
  const [haltErr, setHaltErr] = useState("");
  async function setHalt(on: boolean) {
    setHaltErr("");
    const r = await Promise.allSettled((test ? [base, test] : [base]).map((u) => fetch(`${u.replace(/\/+$/, "")}/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ halt: on }) }).then((x) => { if (!x.ok) throw new Error(`http ${x.status}`); })));
    if (r.some((x) => x.status === "rejected")) setHaltErr("could not reach a bot");
  }

  return (
    <div className={`card ${styles.page}`}>
      <Header meta={head.meta ?? mock.meta} latest={head.latest ?? mock.latest} connection={head.connection} lane="compare" onSettings={() => setSettings(true)} />
      <ErrorBanner feed={head} apiUrl={API.jev} lane={strategy === "jev" ? "jev" : undefined} onSettings={() => setSettings(true)} />
      {!test || !jev.meta ? null : <ErrorBanner feed={mock} apiUrl={API.mock} />}

      <div className={styles.body}>
        <div className={styles.market}>
          {SLOTS[strategy] > 1 ? (
            <span className={styles.games}>
              {Array.from({ length: SLOTS[strategy] }, (_, i) => i + 1).map((n) => (
                <a key={n} href={`?s=${strategy}&game=${n}`} className={n === slot ? styles.gameOn : styles.game}>{strategy === "longdated" || strategy === "lip" || strategy === "polyus" ? "market" : "game"} {n}</a>
              ))}
            </span>
          ) : null}
          <StrategyTabs current={strategy} slot={slot} />
          <span className={styles.marketName}>{mock.meta?.market ?? jev.meta?.market ?? "-"}</span>
          {mock.latest ? <span className={styles.price}>{fmtPrice(mock.latest.mid)}</span> : null}
          <span className={styles.muted}>window {hhmmss(since ? Date.now() - since : 0)} · horizon {horizon} ticks</span>
          {game?.score ? <span className={styles.muted}>score {game.score}{game.period ? ` · ${game.period}` : ""}{game.elapsed ? ` ${game.elapsed}` : ""}</span> : null}
          {!sameMarket ? <span className={styles.warn}>the two bots are on different markets, restart with bun run duo</span> : null}
          <span className={styles.spacer} />
          {haltErr ? <span className={styles.warn}>{haltErr}</span> : null}
          <button type="button" className={halted ? styles.resume : styles.kill} onClick={() => void setHalt(!halted)}>
            {halted ? "resume quoting" : "kill switch"}
          </button>
        </div>

        {strategy === "jev" ? <Verdict mock={s.mock} jev={s.jev} jevIsJev={jevIsJev} /> : null}

        <div className={styles.lanes} style={test ? undefined : { gridTemplateColumns: "1fr" }}>
          <LaneCard title={test ? "Reward farmer" : label} sub={test ? "baseline" : ""} color={COLORS.mock} stats={s.mock} feed={mock} />
          {test ? <LaneCard title={strategy === "jev" ? (jevIsJev ? jev.meta!.model : "jev lane") : label} sub={strategy === "jev" ? (jevIsJev ? "TypeSafe Jev" : "waiting for a key, running mock") : jev.meta?.fairSource ? `fair value: ${jev.meta.fairSource}` : ""} color={COLORS.jev} stats={s.jev} feed={jev} /> : null}
        </div>

        <section className={styles.chartCard}>
          <div className={styles.sectionLabel}>P&amp;L OVER TIME</div>
          <PnlChart lanes={[{ id: "mock", name: test ? "Reward farmer" : label, color: COLORS.mock, events: thin(ev.mock) }, ...(test ? [{ id: "jev", name: label, color: COLORS.jev, events: thin(ev.jev) }] : [])]} />
        </section>
      </div>

      {settings ? <KeyPanel apiUrl={API.jev} hasKey={!!jev.meta?.hasKey} hasOddsKey={!!jev.meta?.hasOddsKey} model={jev.meta?.model ?? ""} strategy={jev.meta?.strategy} onClose={() => setSettings(false)} /> : null}
    </div>
  );
}

function Verdict({ mock, jev, jevIsJev }: { mock: LaneStats; jev: LaneStats; jevIsJev: boolean }) {
  if (!jevIsJev) return <div className={styles.verdict}>Add your TypeSafe key to start the real comparison. Until then both lanes run the mock model.</div>;
  const n = Math.min(mock.scored, jev.scored);
  if (n === 0) return <div className={styles.verdict}>Jev is running. Waiting for the first calls to be scored (one per horizon window, once it has passed).</div>;
  const net = jev.netUsd - mock.netUsd;
  const hit = jev.hitRate !== null && mock.hitRate !== null ? jev.hitRate - mock.hitRate : null;
  // A gap only counts once the two 95% ranges stop overlapping.
  const early = !jev.ci || !mock.ci || (jev.ci[0] <= mock.ci[1] && mock.ci[0] <= jev.ci[1]);
  return (
    <div className={`${styles.verdict} ${early ? "" : net >= 0 ? styles.verdictUp : styles.verdictDown}`}>
      <strong>{net >= 0 ? "Jev ahead" : "Jev behind"} by {fmtUsd(Math.abs(net), 2)}</strong> net of inference cost
      {hit !== null ? <>, hit rate {hit >= 0 ? "+" : "−"}{Math.abs(hit * 100).toFixed(1)} pts</> : null}.{" "}
      <span className={styles.muted}>{early ? `The hit-rate ranges still overlap (${n} independent calls each), so this could be luck.` : `Hit-rate ranges no longer overlap after ${fmtInt(n)} independent calls each.`}</span>
    </div>
  );
}

function LaneCard({ title, sub, color, stats, feed }: { title: string; sub: string; color: string; stats: LaneStats; feed: FeedState }) {
  const pos = feed.latest?.position;
  const cents = Math.round(stats.netUsd * 100);
  const cells: [string, string][] = [
    // the flat model always says 50/50, so a hit rate would only count up-moves
    ["hit rate", feed.meta?.model === "flat" || stats.hitRate === null ? "n/a" : `${Math.round(stats.hitRate * 100)}%`],
    ["95% range", feed.meta?.model !== "flat" && stats.ci ? `${Math.round(stats.ci[0] * 100)}-${Math.round(stats.ci[1] * 100)}%` : "n/a"],
    ["scored calls", fmtInt(stats.scored)],
    ["fills", fmtInt(stats.fills)],
    ["position", !pos || pos.side === "flat" ? "flat" : `${pos.side} ${fmtInt(pos.size)}`],
    ["avg latency", `${stats.avgLatencyMs} ms`],
    ["skipped ticks", fmtInt(stats.late)],
    ["gross p&l", fmtUsd(stats.pnlUsd, 2)],
    ["inference cost", fmtUsd(stats.costUsd, 4)],
    ["rewards (est.)", fmtUsd(feed.latest?.totals.rewardsUsd ?? 0, 2)],
  ];
  return (
    <section className={styles.lane}>
      <div className={styles.laneHead}>
        <i className={styles.swatch} style={{ background: color }} />
        <span className={styles.laneTitle}>{title}</span>
        <span className={styles.muted}>{sub}</span>
        <span className={styles.spacer} />
        {feed.meta?.halted ? <span className={styles.warn}>halted</span> : null}
        <span className={feed.connection === "live" ? styles.live : styles.muted}>{feed.connection}</span>
      </div>
      <div className={styles.net} style={{ color: cents === 0 ? "var(--ink)" : cents > 0 ? "var(--pnl-pos)" : "var(--pnl-neg)" }}>
        {cents === 0 ? "" : cents > 0 ? "+" : "−"}{fmtUsd(Math.abs(stats.netUsd), 2)}
        <span className={styles.netLabel}>net p&amp;l (exit price, after costs)</span>
      </div>
      <dl className={styles.grid}>
        {cells.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
    </section>
  );
}

/** At most ~400 points per line; the chart does not need every tick. */
function thin(ev: BlockEvent[]) {
  const step = Math.ceil(ev.length / 400);
  return step <= 1 ? ev : ev.filter((_, i) => i % step === 0 || i === ev.length - 1);
}
