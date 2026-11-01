/** The timer's end chime and background music, played in the browser. Browsers may refuse audio before a
 * person has interacted with the page; every call swallows that, since the countdown itself still shows. */

let context = null;

function audioContext() {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  context = context || new Ctor();
  return context;
}

/** Three soft bell tones. */
export function playChime() {
  try {
    const ctx = audioContext();
    if (!ctx) return;
    void ctx.resume?.();
    [523.25, 659.25, 783.99].forEach((frequency, index) => {
      const start = ctx.currentTime + index * 0.28;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.2);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + 1.3);
    });
  } catch {
    // Audio is a nicety.
  }
}

let track = null;
let trackId = null;

/** Loops the bundled track `id` (a TIMER_MUSIC id), or stops the music for null. */
export function setMusic(id) {
  try {
    if (id === trackId) return;
    track?.pause();
    track = null;
    trackId = id;
    if (!id || typeof Audio === "undefined") return;
    track = new Audio(`/timer-music/${id}.mp3`);
    track.loop = true;
    track.volume = 0.5;
    void track.play().catch(() => {});
  } catch {
    track = null;
  }
}
