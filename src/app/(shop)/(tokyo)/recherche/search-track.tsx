"use client";

import { useEffect } from "react";

import { track } from "@/lib/tracking/funnel";

/**
 * Client bridge that fires the GA4 `search` event from the server-rendered
 * search page. Renders nothing. `search_term` is the query; `results` is the hit
 * count (0 for a no-results page). No PII.
 */
export function SearchTrack({ term, results }: { term: string; results: number }) {
  useEffect(() => {
    if (!term) return;
    track("search", { meta: { search_term: term, results } });
  }, [term, results]);
  return null;
}
