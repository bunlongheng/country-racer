"use client";

import { useEffect, useState } from "react";
import { sound } from "@/lib/sound";

// Small always-present speaker toggle, bottom-right. Persists to localStorage.
export default function SoundToggle() {
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    setMuted(sound.isMuted());
    const unsub = sound.subscribe(setMuted);
    return () => {
      unsub();
    };
  }, []);

  return (
    <button
      onClick={() => sound.toggle()}
      aria-label={muted ? "Unmute sound" : "Mute sound"}
      aria-pressed={muted}
      className="fixed bottom-4 right-4 z-30 flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-white/10 text-white/80 backdrop-blur transition hover:bg-white/20 active:scale-95"
    >
      {muted ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 5 6 9H2v6h4l5 4z" />
          <line x1="23" y1="9" x2="17" y2="15" />
          <line x1="17" y1="9" x2="23" y2="15" />
        </svg>
      ) : (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 5 6 9H2v6h4l5 4z" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
      )}
    </button>
  );
}
