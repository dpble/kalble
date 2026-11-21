"use client";

import { useEffect, useState } from "react";

/** GET `url` every `ms`; `data` is null when the server is unreachable or answers non-2xx (e.g. 503 before the first compute). */
export function usePoll<T>(url: string, ms: number): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    const go = () => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => { if (live) setData(d); });
    go();
    const t = setInterval(go, ms);
    return () => { live = false; clearInterval(t); };
  }, [url, ms]);
  return data;
}
