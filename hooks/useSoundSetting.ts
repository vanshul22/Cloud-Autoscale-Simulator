"use client";

// The "alert sound on/off" preference.
//
// This is a personal preference, not part of the view, so it goes in localStorage
// (it follows YOU across refreshes) rather than in the URL (which is for things
// you would want a shared link to reproduce, like the tab and filters).

import { useCallback, useEffect, useState } from "react";
import { playSound, unlockAudio } from "@/lib/sound";

const KEY = "sim:sound";

export function useSoundSetting(): [boolean, (on: boolean) => void] {
  // Start "on" on both server and first client render so they match (no hydration
  // warning), then apply the saved preference once we are in the browser.
  const [on, setOn] = useState(true);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(KEY) === "off") setOn(false);
    } catch {
      // storage blocked (private mode): keep the default
    }
    // Browsers only allow audio after a user gesture. Unlock on the very first
    // click/tap/key anywhere, so alerts can sound even if the user never touches
    // the sound button.
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  const set = useCallback((next: boolean) => {
    setOn(next);
    try {
      window.localStorage.setItem(KEY, next ? "on" : "off");
    } catch {
      // ignore: the setting just will not persist
    }
    if (next) {
      unlockAudio(); // this call comes from a click, so it is allowed
      playSound("success"); // a short test chime so you can hear that it works
    }
  }, []);

  return [on, set];
}
