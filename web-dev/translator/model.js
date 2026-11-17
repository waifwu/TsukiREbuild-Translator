// model.js - what the editor shows, worked out from the line map and the translations folder (the translator tool, Stage 2). No DOM: the tests
// run it in Node (web-dev/tests/translator.test.mjs).
//
// The line map (web-dev/tools/line_map.py, made by the server from the app's own scripts) says where each line is: its scene, its command, its page.
// A scene shows its lines in the order its script names them (the command, then the place in it), not by number. A line two scenes show (one does)
// is kept in one file: the file that has it already, else the scene it is edited in.
import { readable, spanKind, italicLetters } from "./markup.js";

export const STATUSES = ["empty", "draft", "reviewed", "final"];
export const ROUTES = [["prologue", "Prologue"], ["arcueid", "Arcueid"], ["ciel", "Ciel"], ["qa", "Ciel-sensei's corner"], ["system", "System"]];
export const LABELS = { en: "Tsukihimates", ja: "Japanese", zh: "Chinese", aniplex: "Aniplex", pt: "Portuguese", es: "Spanish" };
export const labelOf = (code) => LABELS[code] || code;

// Per scene (by script index), its lines in the order the script names them: [{id, page, dead}], each line once.
export function sceneLines(map) {
  const per = map.scenes.map(() => new Map());
  for (const ln of map.lines) {
    for (const a of ln.at) {
      const seen = per[a.s].get(ln.id);
      const key = [a.dead ? 1 : 0, a.pc, a.nth];
      if (!seen || cmp(key, seen.key) < 0) per[a.s].set(ln.id, { id: ln.id, page: a.page ?? null, dead: !!a.dead, key });
    }
  }
  return per.map((m) => [...m.values()].sort((x, y) => cmp(x.key, y.key)).map(({ id, page, dead }) => ({ id, page, dead })));
}
const cmp = (a, b) => { for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1; return 0; };

// The scenes that show lines, by route and day: [{route, label, groups: [{key, label, scenes: [script index]}]}].
export function sceneTree(map, lines = sceneLines(map)) {
  const routes = new Map(ROUTES.map(([r, label]) => [r, { route: r, label, groups: new Map() }]));
  map.scenes.forEach((sc, s) => {
    if (!lines[s].length) return;
    const r = routes.get(sc.route) || routes.get("system");
    let key, label;
    if (sc.route === "arcueid" || sc.route === "ciel") {
      key = `${String(sc.day).padStart(2, "0")}${sc.part || ""}`;
      label = `Day ${sc.day}${sc.part ? ` (${sc.part})` : ""}`;
    } else if (sc.route === "qa") { key = "qa"; label = "Episodes"; }
    else { key = sc.route; label = r.label; }
    if (!r.groups.has(key)) r.groups.set(key, { key, label, scenes: [] });
    r.groups.get(key).scenes.push(s);
  });
  return [...routes.values()].filter((r) => r.groups.size)
    .map((r) => ({ ...r, groups: [...r.groups.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) }));
}

// The translations folder as the editor keeps it: every line's row, and the file that has it.
export class Book {
  constructor(files = {}) {
    this.rows = new Map();    // line -> its row (as edited)
    this.disk = new Map();    // line -> its row as the folder has it (null: not in any file)
    this.owner = new Map();   // line -> the scene file that has it
    for (const [scene, rows] of Object.entries(files)) {
      for (const r of rows) {
        if (this.owner.has(r.id)) continue;   // (the build refuses a line given twice; the first is shown)
        this.owner.set(r.id, scene);
        this.rows.set(r.id, structuredClone(r));
        this.disk.set(r.id, structuredClone(r));
      }
    }
  }
  statusOf(id) {
    const r = this.rows.get(id);
    return !r || !r.text || r.status === "empty" ? "empty" : r.status;
  }
  // The file a line is saved in: the one that has it, else the scene it is edited in.
  fileOf(id, scene) { return this.owner.get(id) || scene; }
}

export function counts(ids, book) {
  const c = { empty: 0, draft: 0, reviewed: 0, final: 0, total: ids.length };
  for (const id of ids) c[book.statusOf(id)]++;
  return c;
}
export const done = (c) => c.total - c.empty;

// The row a line gets when its text, status or note is changed: its keys kept in order, the status set by the text where it was not chosen (text
// written in an empty line is a draft; a line emptied is empty), and `from` naming what it was translated from.
export function edited(row, id, change, from) {
  const r = row ? structuredClone(row) : { id, text: "", status: "empty" };
  if ("text" in change) {
    r.text = change.text;
    if (!change.text) r.status = "empty";
    else if (r.status === "empty" && !("status" in change)) r.status = "draft";
    if (from) r.from = from;
  }
  if ("status" in change) r.status = change.status;
  if ("note" in change) { if (change.note) r.note = change.note; else delete r.note; }
  if ("from" in change) r.from = change.from;
  return r;
}

// ---- search and replace ---------------------------------------------------------------------------------------------------------------
export function compile(find, { regex = false, caseSensitive = false, word = false } = {}) {
  if (!find) return null;
  let src = regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (word) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  return new RegExp(src, `gu${caseSensitive ? "" : "i"}`);
}
// The places a line matches, on its readable form (each face's letters as ASCII, the same length): [{a, b, m}] (empty matches left out).
export function matchesIn(raw, re) {
  const out = [];
  for (const m of readable(raw).matchAll(re)) if (m[0].length) out.push({ a: m.index, b: m.index + m[0].length, m });
  return out;
}
// "$&", "$1", "$<name>", "$$" in a replacement, as String.replace has them.
export function expand(repl, m) {
  return repl.replace(/\$(\$|&|\d{1,2}|<[^>]*>)/g, (all, k) => {
    if (k === "$") return "$";
    if (k === "&") return m[0];
    if (k[0] === "<") return m.groups?.[k.slice(1, -1)] ?? "";
    const n = Number(k);
    return n > 0 && n < m.length ? m[n] ?? "" : all;
  });
}
// A line with the chosen matches replaced, last first. A match that crosses a mark, ruby or face is left (it cannot be replaced letter for letter);
// a match all in italics is replaced in italics. Returns {text, done, left}.
export function replaceIn(raw, matches, repl) {
  let text = raw, doneN = 0, left = 0;
  for (const x of [...matches].sort((p, q) => q.a - p.a)) {
    const k = spanKind(raw, x.a, x.b);
    if (!k.plain) { left++; continue; }
    const r = expand(repl, x.m);
    text = text.slice(0, x.a) + (k.italic ? italicLetters(r) : r) + text.slice(x.b);
    doneN++;
  }
  return { text, done: doneN, left };
}
