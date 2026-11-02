/**
 * The bundled emoji and sticker set: no network, no provider. Each entry is `[emoji, search words, tone]`
 * where `tone` marks emoji that take a skin tone. Recents and the chosen tone are personal preferences, so
 * they live in localStorage, not in the board.
 */

const T = 1;
export const EMOJI = [
  ["😀", "grin smile happy"], ["😂", "laugh joy tears"], ["🙂", "smile"], ["😉", "wink"], ["😍", "love heart eyes"],
  ["🤔", "think hmm question"], ["😎", "cool sunglasses"], ["😅", "sweat smile"], ["😢", "cry sad"], ["😡", "angry mad"],
  ["😴", "sleep tired"], ["🤯", "mind blown"], ["🥳", "party celebrate"], ["😬", "grimace awkward"], ["🙃", "upside down"],
  ["👍", "thumbs up yes agree like", T], ["👎", "thumbs down no disagree", T], ["👏", "clap applause", T], ["🙌", "raised hands praise", T],
  ["👋", "wave hello", T], ["🙏", "pray thanks please", T], ["💪", "strong muscle", T], ["✌️", "peace victory", T], ["👌", "ok perfect", T],
  ["👀", "eyes look watch"], ["🧠", "brain think"], ["❤️", "heart love red"], ["🧡", "orange heart"], ["💛", "yellow heart"],
  ["💚", "green heart"], ["💙", "blue heart"], ["💜", "purple heart"], ["💔", "broken heart"], ["🔥", "fire hot"],
  ["⭐", "star favorite"], ["✨", "sparkles new magic"], ["🎉", "tada party celebrate"], ["🎯", "target goal bullseye"],
  ["🚀", "rocket launch fast"], ["💡", "idea light bulb"], ["⚡", "lightning fast energy"], ["💯", "hundred perfect score"],
  ["✅", "check done yes complete"], ["❌", "cross no wrong"], ["⚠️", "warning caution risk"], ["❓", "question"],
  ["❗", "exclamation important"], ["➕", "plus add"], ["➖", "minus remove"], ["➡️", "arrow right next"], ["⬅️", "arrow left back"],
  ["⬆️", "arrow up"], ["⬇️", "arrow down"], ["🔄", "refresh cycle repeat"], ["🔒", "lock secure private"], ["🔓", "unlock open"],
  ["🔔", "bell notify"], ["📌", "pin"], ["📎", "paperclip attach"], ["📝", "memo note write"], ["📅", "calendar date"],
  ["⏰", "alarm clock time"], ["⏳", "hourglass wait"], ["📈", "chart up growth"], ["📉", "chart down decline"], ["📊", "bar chart data"],
  ["💰", "money bag"], ["💵", "dollar cash"], ["🏆", "trophy win"], ["🥇", "gold medal first"], ["🎁", "gift present"],
  ["🛠️", "tools build fix"], ["🔧", "wrench fix"], ["⚙️", "gear settings"], ["🔍", "search magnify find"], ["📣", "megaphone announce"],
  ["💬", "speech chat comment"], ["🗳️", "ballot vote"], ["📷", "camera photo"], ["🎬", "clapper film video"], ["🎵", "music note"],
  ["🎨", "art palette design"], ["📚", "books read"], ["🧪", "test tube experiment"], ["🧩", "puzzle piece"], ["🧭", "compass direction"],
  ["🌍", "earth world global"], ["🌱", "seedling grow"], ["🌈", "rainbow"], ["☀️", "sun"], ["🌙", "moon night"],
  ["☁️", "cloud"], ["🌧️", "rain"], ["❄️", "snow cold"], ["🍕", "pizza food"], ["☕", "coffee break"], ["🍺", "beer drink"],
  ["🐛", "bug"], ["🦄", "unicorn"], ["🐢", "turtle slow"], ["🐇", "rabbit fast"], ["🏁", "finish flag race"], ["🚧", "construction wip"],
  ["🚨", "siren alert urgent"], ["🛑", "stop"], ["🟢", "green circle go"], ["🟡", "yellow circle caution"], ["🔴", "red circle stop"],
  ["🔵", "blue circle"], ["⬛", "black square"], ["⬜", "white square"], ["🏠", "home house"], ["🏢", "office building"],
  ["🚗", "car"], ["✈️", "airplane travel"], ["🚲", "bike"], ["📱", "phone mobile"], ["💻", "laptop computer"],
  ["🖥️", "desktop monitor"], ["🔗", "link chain"], ["🔖", "bookmark"], ["🏷️", "tag label"], ["🗂️", "folder index"],
  ["🧑‍💻", "developer coder", T], ["🧑‍🎨", "artist designer", T], ["🧑‍💼", "business worker", T], ["🤝", "handshake deal", T],
];

export const SKIN_TONES = [
  { id: "default", label: "Default", modifier: "" },
  { id: "light", label: "Light", modifier: "\u{1F3FB}" },
  { id: "medium-light", label: "Medium light", modifier: "\u{1F3FC}" },
  { id: "medium", label: "Medium", modifier: "\u{1F3FD}" },
  { id: "medium-dark", label: "Medium dark", modifier: "\u{1F3FE}" },
  { id: "dark", label: "Dark", modifier: "\u{1F3FF}" },
];

const VARIATION = "️";
const ZWJ = "‍";

/** `emoji` with the skin tone applied; only emoji that take a tone change. */
export function withTone(emoji, toneId) {
  const tone = SKIN_TONES.find((t) => t.id === toneId);
  if (!tone || !tone.modifier) return emoji;
  const entry = EMOJI.find(([e]) => e === emoji);
  if (!entry || !entry[2]) return emoji;
  const base = emoji.replace(VARIATION, "");
  // Sequences like person + ZWJ + object take the tone right after the person.
  const joiner = base.indexOf(ZWJ);
  return joiner === -1 ? base + tone.modifier : base.slice(0, joiner) + tone.modifier + base.slice(joiner);
}

/** Entries matching every word of `query` (an empty query matches all), with `toneId` applied. */
export function searchEmoji(query, toneId = "default") {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return EMOJI.filter(([, name]) => words.every((word) => name.includes(word))).map(([emoji, name]) => ({
    emoji: withTone(emoji, toneId),
    base: emoji,
    name,
  }));
}

const RECENTS_KEY = "veevee-board-emoji-recents-v1";
const MAX_RECENTS = 16;

export function readRecents(storage = typeof localStorage === "undefined" ? null : localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v) => typeof v === "string" && v.length <= 32).slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

/** Puts `emoji` first in the recents (without duplicates) and returns the new list. */
export function rememberRecent(emoji, storage = typeof localStorage === "undefined" ? null : localStorage) {
  const next = [emoji, ...readRecents(storage).filter((e) => e !== emoji)].slice(0, MAX_RECENTS);
  try {
    storage?.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Recents are a convenience; a blocked store just forgets them.
  }
  return next;
}

const TONE_KEY = "veevee-board-emoji-tone-v1";
export function readTone(storage = typeof localStorage === "undefined" ? null : localStorage) {
  try {
    const id = storage?.getItem(TONE_KEY);
    return SKIN_TONES.some((t) => t.id === id) ? id : "default";
  } catch {
    return "default";
  }
}
export function saveTone(id, storage = typeof localStorage === "undefined" ? null : localStorage) {
  try {
    storage?.setItem(TONE_KEY, id);
  } catch {
    // Same as recents.
  }
}
