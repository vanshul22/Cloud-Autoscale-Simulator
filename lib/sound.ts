// =============================================================================
// sound.ts  —  Alert sounds, synthesised in the browser (no audio files).
//
// The Web Audio API builds sound from oscillators, like a tiny synthesizer. Each
// alert is a short list of beeps ("tones"), so there is nothing to download, host
// or pay for, and each severity gets a clearly different pattern:
//
//   error   : four alternating high/low square-wave beeps (a siren; urgent)
//   warn    : two even triangle-wave beeps                  (attention)
//   success : a soft rising two-note chime                  (relief: resolved)
//
// BROWSER RULE to know: browsers refuse to play audio until the user has interacted
// with the page (click, key, tap). Until then the AudioContext is "suspended" and
// playSound() silently does nothing. `unlockAudio()` is called from a real click
// to lift that restriction once; after that, alerts can sound at any time.
// =============================================================================

export type SoundKind = "error" | "warn" | "success";

interface Tone {
  freq: number; // pitch in Hz
  at: number; // start offset in seconds
  dur: number; // length in seconds
  type: OscillatorType; // waveform: square = harsh, triangle = softer, sine = pure
  vol: number; // 0..1 peak volume
}

const SOUNDS: Record<SoundKind, Tone[]> = {
  error: [
    { freq: 880, at: 0.0, dur: 0.18, type: "square", vol: 0.18 },
    { freq: 620, at: 0.22, dur: 0.18, type: "square", vol: 0.18 },
    { freq: 880, at: 0.44, dur: 0.18, type: "square", vol: 0.18 },
    { freq: 620, at: 0.66, dur: 0.3, type: "square", vol: 0.18 },
  ],
  warn: [
    { freq: 660, at: 0.0, dur: 0.14, type: "triangle", vol: 0.22 },
    { freq: 660, at: 0.2, dur: 0.14, type: "triangle", vol: 0.22 },
  ],
  success: [
    { freq: 523, at: 0.0, dur: 0.12, type: "sine", vol: 0.2 },
    { freq: 784, at: 0.14, dur: 0.24, type: "sine", vol: 0.2 },
  ],
};

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null; // very old browser: alerts stay silent, everything else works
    }
  }
  return ctx;
}

/** Call from a real user gesture (click/tap/key) so later alerts are allowed to sound. */
export function unlockAudio(): void {
  const c = getContext();
  if (c && c.state === "suspended") void c.resume().catch(() => {});
}

export function playSound(kind: SoundKind): void {
  const c = getContext();
  if (!c || c.state !== "running") return; // locked (no gesture yet): stay silent

  const now = c.currentTime;
  for (const t of SOUNDS[kind]) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = t.type;
    osc.frequency.value = t.freq;

    // A tiny fade-in and a fade-out stop the speaker "click" you get when a
    // tone starts or ends at full volume.
    const start = now + t.at;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(t.vol, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + t.dur);

    osc.connect(gain).connect(c.destination);
    osc.start(start);
    osc.stop(start + t.dur + 0.02);
  }
}
