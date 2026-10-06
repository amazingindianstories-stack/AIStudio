import { parseVideoMentionIndices, parseAudioMentionIndices } from "./mentions.js";

/** Media subsets are sent in selected-index order; provider tags use that order. */
export function remapSubmittedMediaTags(prompt, videos = [], audio = []) {
  const map = (indices, length) => new Map(indices.filter((n) => n <= length).map((n, i) => [n, i + 1]));
  const videoMap = map(parseVideoMentionIndices(prompt), videos.length);
  const audioMap = map(parseAudioMentionIndices(prompt), audio.length);
  return prompt.replace(/@vid(\d+)/gi, (tag, n) => videoMap.has(Number(n)) ? `@vid${videoMap.get(Number(n))}` : tag)
    .replace(/@audio(\d+)/gi, (tag, n) => audioMap.has(Number(n)) ? `@audio${audioMap.get(Number(n))}` : tag);
}
