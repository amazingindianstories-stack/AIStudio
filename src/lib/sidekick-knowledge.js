// Knowledge files for a custom Sidekick are read in the browser as text and sent with the Sidekick (the server keeps
// the text). PDF is not accepted: there is no PDF text extraction on the server yet.
export const KNOWLEDGE_EXTENSIONS = [".txt", ".md", ".csv"];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_KNOWLEDGE_CHARS = 200_000;
export const MAX_KNOWLEDGE_FILES = 20;

/** About one token per four characters. */
export function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

/** Why `file` (a `{ name, size }`) cannot be knowledge, or null. */
export function knowledgeFileProblem(file) {
  const name = String(file?.name ?? "");
  if (!KNOWLEDGE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))) {
    return name.toLowerCase().endsWith(".pdf") ? `${name}: PDF files are not supported yet. Paste the text into a .txt or .md file.` : `${name}: use a .txt, .md or .csv file.`;
  }
  if (file.size > MAX_FILE_BYTES) return `${name} is over 10 MB.`;
  return null;
}

/** `[{ name, text }]` added to `current`, or `{ error }` when a file or the total does not fit. */
export function addKnowledge(current, added) {
  const next = [...current];
  for (const item of added) {
    if (next.length >= MAX_KNOWLEDGE_FILES) return { error: `At most ${MAX_KNOWLEDGE_FILES} files.` };
    next.push(item);
  }
  const chars = next.reduce((sum, item) => sum + item.text.length, 0);
  if (chars > MAX_KNOWLEDGE_CHARS) return { error: `Knowledge is limited to about ${estimateTokens(MAX_KNOWLEDGE_CHARS).toLocaleString()} tokens in all; this is about ${estimateTokens(chars).toLocaleString()}.` };
  return { files: next, chars };
}
