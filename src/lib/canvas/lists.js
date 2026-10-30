/**
 * Bulleted and numbered lists inside rich text. A list item is a line that
 * starts with one tab per nesting level and a marker followed by a space:
 * "• ", "◦ " or "▪ " (by level) for bullets, "1. " for numbers. The markers are
 * ordinary characters of `text`, so lists need no new format field, count
 * toward the size limit like any text, and read naturally when the text is
 * copied or exported. Typing "- " or "* " at the start of a line starts a
 * bulleted list and "1. " a numbered one; Enter continues the list, Enter on
 * an empty item ends it, and Tab / Shift+Tab nest and un-nest the item.
 * Numbers are rewritten on every commit (`renumberLists`), so inserting or
 * moving items keeps each list counting from 1.
 */
export const MAX_LIST_LEVEL = 5;
const BULLETS = ["•", "◦", "▪"];
const ITEM = /^(\t*)(•|◦|▪|\d{1,4}\.) /;

/** The bullet character of a nesting level. */
export function bulletFor(level) {
  return BULLETS[level % BULLETS.length];
}

/** The list item a line is, or null: its level, kind and the length of its prefix (tabs, marker and space). */
export function listItem(line) {
  const match = ITEM.exec(line);
  if (!match) return null;
  const level = Math.min(match[1].length, MAX_LIST_LEVEL);
  const numbered = match[2].endsWith(".");
  return { level, numbered, number: numbered ? Number.parseInt(match[2], 10) : 0, prefix: match[0].length };
}

/** Start and end (exclusive of the newline) of the line holding `offset`. */
export function lineAt(text, offset) {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const newline = text.indexOf("\n", offset);
  return { start, end: newline === -1 ? text.length : newline };
}

function prefixFor(level, numbered, number = 1) {
  return "\t".repeat(level) + (numbered ? `${number}.` : bulletFor(level)) + " ";
}

/**
 * The edit a space typed at `caret` makes: "- " or "* " at the start of a
 * line becomes a bullet. The space is part of the replacement. Null leaves
 * the space to the browser ("1. " is already a numbered item as typed).
 */
export function listOnSpace(text, caret) {
  const { start } = lineAt(text, caret);
  const before = text.slice(start, caret);
  const match = /^(\t*)[-*]$/.exec(before);
  if (!match) return null;
  return { start, end: caret, insert: prefixFor(Math.min(match[1].length, MAX_LIST_LEVEL), false) };
}

/**
 * The edit Enter at `caret` makes in a list item: a new item at the same
 * level (the next number for a numbered list), or, on an item with nothing
 * typed after its marker, the end of the list (the marker is removed). Null
 * for a line that is not a list item.
 */
export function listOnEnter(text, caret) {
  const line = lineAt(text, caret);
  const item = listItem(text.slice(line.start, line.end));
  if (!item || caret < line.start + item.prefix) return null;
  if (line.end === line.start + item.prefix) return { start: line.start, end: line.end, insert: "" };
  return { start: caret, end: caret, insert: "\n" + prefixFor(item.level, item.numbered, item.number + 1) };
}

/** The edit Tab (`outdent` false) or Shift+Tab makes on the list item holding `caret`, or null. */
export function listOnTab(text, caret, outdent) {
  const line = lineAt(text, caret);
  const item = listItem(text.slice(line.start, line.end));
  if (!item) return null;
  const level = item.level + (outdent ? -1 : 1);
  if (level < 0 || level > MAX_LIST_LEVEL) return { start: caret, end: caret, insert: "" };
  return { start: line.start, end: line.start + item.prefix, insert: prefixFor(level, item.numbered, item.number) };
}

/**
 * `text` and `marks` with the edits applied (each `{start, end, insert}`,
 * non-overlapping, in any order). A mark keeps covering the characters it
 * covered; inserted text takes no formatting.
 */
export function applyTextEdits(text, marks, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = "";
  let from = 0;
  for (const edit of sorted) {
    out += text.slice(from, edit.start) + edit.insert;
    from = edit.end;
  }
  out += text.slice(from);
  const map = (offset, isEnd) => {
    let shift = 0;
    for (const edit of sorted) {
      if (offset < edit.start || (isEnd && offset === edit.start)) break;
      if (offset < edit.end || offset === edit.start) {
        // A mark edge inside a replaced range: a start moves past the inserted text, an end before it.
        return edit.start + shift + (isEnd ? 0 : edit.insert.length);
      }
      shift += edit.insert.length - (edit.end - edit.start);
    }
    return offset + shift;
  };
  const nextMarks = [];
  for (const mark of marks ?? []) {
    const start = map(mark[0], false);
    const end = map(mark[1], true);
    if (end > start) nextMarks.push([start, end, ...mark.slice(2)]);
  }
  return { text: out, marks: nextMarks.length ? nextMarks : null };
}

/**
 * Renumbers every numbered list in `text` so each counts from 1. A numbered
 * list is a run of numbered items at one level, which deeper items do not
 * interrupt and any other line ends. Returns the input unchanged when
 * nothing moves.
 */
export function renumberLists(text, marks) {
  if (!text || !/\d\. /.test(text)) return { text, marks };
  const edits = [];
  const counters = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const item = listItem(line);
    if (!item) {
      counters.length = 0;
    } else {
      counters.length = item.level + 1;
      if (item.numbered) {
        const number = (counters[item.level] ?? 0) + 1;
        counters[item.level] = number;
        if (number !== item.number) {
          const markerStart = offset + item.level;
          edits.push({ start: markerStart, end: offset + item.prefix - 1, insert: `${number}.` });
        }
      } else {
        counters[item.level] = 0;
      }
    }
    offset += line.length + 1;
  }
  if (!edits.length) return { text, marks };
  const result = applyTextEdits(text, marks, edits);
  return { text: result.text, marks: result.marks ?? undefined };
}

/**
 * The lines of `text` for display, each `{start, end, level, prefix}` with
 * `level` -1 for a line that is not a list item. Null when no line is one, so
 * plain text keeps rendering as a single run.
 */
export function displayLines(text) {
  if (!text || !/(?:^|\n)\t*(?:•|◦|▪|\d{1,4}\.) /.test(text)) return null;
  const lines = [];
  let start = 0;
  for (const line of text.split("\n")) {
    const item = listItem(line);
    lines.push({ start, end: start + line.length, level: item ? item.level : -1, prefix: item ? item.prefix : 0 });
    start += line.length + 1;
  }
  return lines;
}
