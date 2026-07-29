"use client";

import { useEffect } from "react";

// Registers the hand-written public/sw.js. Production only - dev keeps
// hitting the network directly so edits show up without a stale cache.
// Network-first navigations live inside sw.js itself.
export default function RegisterSW() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Offline support is a progressive enhancement - a failed
      // registration should never block the game from loading.
    });
  }, []);

  return null;
}
