"use client";

import { useState } from "react";
import DecisionPanel from "@/components/DecisionPanel/DecisionPanel";
import Feed from "@/components/Feed/Feed";
import FlowChart from "@/components/FlowChart/FlowChart";
import Header from "@/components/Header/Header";
import KeyPanel from "@/components/KeyPanel/KeyPanel";
import StatsRow from "@/components/StatsRow/StatsRow";
import ErrorBanner from "@/components/LiveView/ErrorBanner";
import { API, type Lane } from "@/lib/config";
import { useFeed } from "@/lib/useFeed";
import styles from "@/app/page.module.css";

/** One bot's live dashboard: chart, decision, feed. */
export default function LiveView({ lane }: { lane: Lane }) {
  const apiUrl = API[lane];
  const feed = useFeed(apiUrl);
  const [settings, setSettings] = useState(false);

  return (
    <div className="card">
      <Header meta={feed.meta} latest={feed.latest} connection={feed.connection} lane={lane} onSettings={() => setSettings(true)} />
      <ErrorBanner feed={feed} apiUrl={apiUrl} lane={lane} onSettings={() => setSettings(true)} />
      <StatsRow latest={feed.latest} avgLatencyMs={feed.avgLatencyMs} meta={feed.meta} />
      <div className={styles.main}>
        <div className={styles.left}>
          <div className={styles.chartWrap}>
            <FlowChart events={feed.events} latest={feed.latest} market={feed.meta && feed.meta.venue !== "kuru" ? feed.meta.market : undefined} />
          </div>
        </div>
        <div className={styles.right}>
          <DecisionPanel latest={feed.latest} market={feed.meta?.market} venue={feed.meta?.venue} />
          <Feed events={feed.events} />
        </div>
      </div>
      {settings ? <KeyPanel apiUrl={apiUrl} hasKey={!!feed.meta?.hasKey} hasOddsKey={!!feed.meta?.hasOddsKey} model={feed.meta?.model ?? ""} onClose={() => setSettings(false)} /> : null}
    </div>
  );
}
