/**
 * A small client-side syntax highlighter for the board's code block. It splits source into comment, string,
 * number, keyword and plain tokens per language; no markup is built from the code, so the renderer can
 * only ever put text into the page.
 */

const C_LIKE = "if else for while do switch case break continue return function class new this const let var static void int long float double char bool boolean true false null undefined import export from as default try catch finally throw async await yield typeof instanceof in of extends implements interface enum struct public private protected package namespace using fn mut impl trait pub use mod match loop where self super type func go defer chan range select map string byte";
const KEYWORDS = {
  javascript: C_LIKE,
  typescript: C_LIKE,
  java: C_LIKE,
  c: C_LIKE,
  cpp: C_LIKE,
  csharp: C_LIKE,
  go: C_LIKE,
  rust: C_LIKE,
  php: `${C_LIKE} echo foreach endforeach elseif`,
  swift: `${C_LIKE} let var guard protocol extension`,
  kotlin: `${C_LIKE} val fun when object companion`,
  python: "def class if elif else for while return import from as try except finally raise with lambda pass break continue yield in is not and or None True False async await global nonlocal assert del",
  ruby: "def class module if elsif else unless for while until do end return begin rescue ensure yield nil true false self require include then case when",
  sql: "select from where join left right inner outer on group by order having limit offset insert into values update set delete create table drop alter add index primary key foreign references null not and or as distinct union all case when then else end like in is exists between asc desc",
  yaml: "true false null yes no on off",
  json: "true false null",
  html: "html head body div span a p ul ol li h1 h2 h3 h4 h5 h6 img script style link meta table tr td th form input button section nav header footer main",
  css: "important",
  bash: "if then else elif fi for while do done case esac function return in echo export local cd ls cat grep sed awk exit set unset source",
  mermaid: "graph flowchart sequenceDiagram classDiagram stateDiagram erDiagram gantt pie journey subgraph end participant actor loop alt opt TD LR TB BT RL",
};

const COMMENTS = {
  python: ["#"], ruby: ["#"], yaml: ["#"], bash: ["#"], sql: ["--"], mermaid: ["%%"], html: [], json: [], css: [],
  php: ["//", "#"],
};
const BLOCK_COMMENT = { html: ["<!--", "-->"], css: ["/*", "*/"] };
const SLASH_LANGS = new Set(["javascript", "typescript", "java", "c", "cpp", "csharp", "go", "rust", "swift", "kotlin", "php"]);

const sets = new Map();
function keywordSet(language) {
  if (!sets.has(language)) {
    const words = KEYWORDS[language] ?? "";
    // SQL and mermaid keywords match in any letter case.
    sets.set(language, { words: new Set(words.split(" ")), fold: language === "sql" });
  }
  return sets.get(language);
}

/** Tokens `{ text, kind }` covering `code` exactly (joining the texts gives `code` back). */
export function highlight(code, language = "text") {
  if (language === "text" || typeof code !== "string") return [{ text: String(code ?? ""), kind: "plain" }];
  const tokens = [];
  const line = COMMENTS[language] ?? (SLASH_LANGS.has(language) ? ["//"] : []);
  const block = BLOCK_COMMENT[language] ?? (SLASH_LANGS.has(language) || language === "css" ? ["/*", "*/"] : null);
  const { words, fold } = keywordSet(language);
  let plain = "";
  const flush = () => {
    if (plain) tokens.push({ text: plain, kind: "plain" });
    plain = "";
  };
  const push = (text, kind) => {
    flush();
    tokens.push({ text, kind });
  };
  let i = 0;
  while (i < code.length) {
    const rest = code.startsWith.bind(code);
    if (block && rest(block[0], i)) {
      const end = code.indexOf(block[1], i + block[0].length);
      const stop = end === -1 ? code.length : end + block[1].length;
      push(code.slice(i, stop), "comment");
      i = stop;
      continue;
    }
    const marker = line.find((m) => rest(m, i));
    if (marker) {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      push(code.slice(i, stop), "comment");
      i = stop;
      continue;
    }
    const ch = code[i];
    if (ch === '"' || ch === "'" || (ch === "`" && language !== "sql")) {
      let j = i + 1;
      while (j < code.length && code[j] !== ch && (ch === "`" || code[j] !== "\n")) j += code[j] === "\\" ? 2 : 1;
      const stop = Math.min(code.length, j + 1);
      push(code.slice(i, stop), "string");
      i = stop;
      continue;
    }
    const number = /^-?(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)/.exec(code.slice(i, i + 40));
    if (number && !/[A-Za-z0-9_]/.test(code[i - 1] ?? "")) {
      push(number[0], "number");
      i += number[0].length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(code.slice(i, i + 80));
    if (word) {
      push(word[0], words.has(fold ? word[0].toLowerCase() : word[0]) ? "keyword" : "plain");
      i += word[0].length;
      continue;
    }
    plain += ch;
    i += 1;
  }
  flush();
  // Merge neighbouring plain runs the word splitter produced.
  return tokens.reduce((merged, token) => {
    const last = merged[merged.length - 1];
    if (last && last.kind === "plain" && token.kind === "plain") last.text += token.text;
    else merged.push({ ...token });
    return merged;
  }, []);
}

export const LANGUAGE_LABELS = {
  text: "Plain text", javascript: "JavaScript", typescript: "TypeScript", python: "Python", java: "Java", c: "C", cpp: "C++",
  csharp: "C#", go: "Go", rust: "Rust", php: "PHP", ruby: "Ruby", swift: "Swift", kotlin: "Kotlin", sql: "SQL",
  yaml: "YAML", json: "JSON", html: "HTML", css: "CSS", bash: "Bash", mermaid: "Mermaid",
};
