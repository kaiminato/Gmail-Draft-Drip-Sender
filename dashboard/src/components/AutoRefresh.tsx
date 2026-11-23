"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Re-fetches the server-rendered page on a timer so the table follows the
// heartbeats without any client-side state.
//
// The timer is tied to the data, not to the screen. Installs report at most
// once a minute (idle ones every five), so refreshing faster than that only
// duplicates the same numbers: the default is one beat, and everything this
// costs is one request per tab per minute instead of four. A hidden tab does
// not fetch at all - a tab left open overnight was the other half of the
// traffic - and one brought forward refreshes at once, so it never looks
// stale after being in the background.
export function AutoRefresh({ seconds = 60 }: { seconds?: number }) {
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
