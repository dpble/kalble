import Link from "next/link";
import { STRATEGIES } from "@/lib/config";
import styles from "../Compare/Compare.module.css";

/** The seven tabs. `current` is a strategy id, "gaps" or "results". */
export default function StrategyTabs({ current, slot = 1 }: { current: string; slot?: number }) {
  return (
    <span className={styles.games}>
      {STRATEGIES.map((t) => (
        <Link key={t.id} href={t.id === "gaps" || t.id === "results" ? `/${t.id}` : `/compare?s=${t.id}&game=${slot}`} className={t.id === current ? styles.gameOn : styles.game}>{t.label}</Link>
      ))}
    </span>
  );
}
