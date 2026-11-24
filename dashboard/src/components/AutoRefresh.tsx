"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Re-fetches the server-rendered page on a timer so the table follows the
// heartbeats without any client-side state.
//
// The timer is tied to the data, not to the screen. Installs report a minute
// around a send and every ten minutes otherwise (1.6.22+), so anything faster
// duplicates numbers that cannot have changed: a page asks twice as often as a
// sending fleet updates at most, and once every ten while nothing is sending.
// A hidden tab does not fetch at all - a tab left open overnight was the other
// half of the traffic - and one brought forward refreshes at once, so it never
// looks stale after being in the background.
export function AutoRefresh({ seconds = 120 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const id = setInterval(tick, seconds * 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router, seconds]);
  return null;
}
