// memory.js - translation memory and the glossary's terms, for the editor (the translator tool's Stage 5, web-dev/TRANSLATOR-TOOL-PLAN.md). No DOM.
//
// Translation memory: a line whose source is the same as, or close to, a line already translated is shown that translation. The source is the
// line in the language the folder is translated from (language.json "from": Japanese unless it says otherwise), read as words (wordsOf: faces as
// letters, ruby as its base, marks and row breaks out). 4,773 lines of the English repeat another line exactly, 4,290 of the Japanese.
//   Memory.same(id)      the other lines with exactly this source
//   Memory.like(id, ok)  lines whose source is close (character trigrams, Dice's coefficient), best first, among those ok() takes
// The glossary (glossary.json in the translations folder, build_layer.py reads the same): terms with their forms in the source languages and the
// agreed translation. termsIn() finds a line's terms; build_layer.py's Checker warns where a line has a term's source and not its translation.
import { readable } from "./markup.js";

// A line as words: what memory and the glossary compare (build_layer.py plain_line, with spaces closed up).
export function wordsOf(s) {
  return readable(s || "").replace(/<([^<>|]*)\|[^<>]*>/g, "$1").replace(/@(c\d|[a-z])|\[[a-z]+\d*\]/g, "")
    .replace(/[\n^\ue3fe\ue3ff]/g, " ").replace(/[\s\u3000]+/g, " ").trim();
}
const grams = (s) => {
  const t = ` ${s.toLowerCase()} `;
  const out = new Set();
  for (let k = 0; k + 3 <= t.length; k++) out.add(t.slice(k, k + 3));
  return out;
};
export function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const g of a) if (b.has(g)) n++;
  return (2 * n) / (a.size + b.size);
}

export class Memory {
  // source: the source language's text.json; ids: the lines to remember (those the scripts show)
  constructor(source, ids) {
    this.source = source;
    this.words = new Map();
    this.byText = new Map();
    this.grams = new Map();
    this.index = new Map();     // trigram -> lines that have it
    for (const id of ids) {
      const w = wordsOf(source[id]);
      if (!w) continue;
      this.words.set(id, w);
      if (!this.byText.has(w)) this.byText.set(w, []);
      this.byText.get(w).push(id);
      const g = grams(w);
      this.grams.set(id, g);
      for (const x of g) { if (!this.index.has(x)) this.index.set(x, []); this.index.get(x).push(id); }
    }
    // a trigram in more than one line in twenty says little about which lines are alike ("the", "のは"): left out of the search
    this.common = Math.max(50, Math.floor(this.words.size / 20));
  }
  same(id) {
    const w = this.words.get(id);
    return w ? this.byText.get(w).filter((x) => x !== id) : [];
  }
  // [{id, score}]: lines whose source is at least `min` alike (and not the same), best first, `max` of them, among the lines ok(id) takes.
  like(id, ok = () => true, { min = 0.6, max = 5 } = {}) {
    const g = this.grams.get(id);
    if (!g || g.size < 4) return [];
    const hits = new Map();
    for (const x of g) {
      const list = this.index.get(x);
      if (!list || list.length > this.common) continue;
      for (const other of list) if (other !== id) hits.set(other, (hits.get(other) || 0) + 1);
    }
    const w = this.words.get(id);
    const out = [];
    for (const [other, n] of hits) {
      if (n < 2 || this.words.get(other) === w || !ok(other)) continue;
      const score = dice(g, this.grams.get(other));
      if (score >= min) out.push({ id: other, score });
    }
    return out.sort((a, b) => b.score - a.score || a.id - b.id).slice(0, max);
  }
}

// ---- the glossary ------------------------------------------------------------------------------------------------------------------------
const NOT_FORMS = new Set(["target", "also", "note"]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A term's form as build_layer.py form_pattern finds it: a word (any case) where words are spaced, as it is in Japanese and Chinese.
export function formPattern(lang, form) {
  return lang === "ja" || lang === "zh" ? new RegExp(escapeRe(form), "g") : new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(form)}(?![\\p{L}\\p{N}])`, "giu");
}
export const formsOf = (term) => Object.entries(term).filter(([k, v]) => !NOT_FORMS.has(k) && typeof v === "string" && v.trim());
// The terms whose form is in a line's source: [{term, lang, form}] (sources: {lang: its text.json}).
export function termsIn(terms, sources, id) {
  const out = [];
  for (const term of terms || []) {
    if (!term.target) continue;
    for (const [lang, form] of formsOf(term)) {
      const src = sources[lang];
      if (src && src[id] && formPattern(lang, form).test(wordsOf(src[id]))) { out.push({ term, lang, form }); break; }
    }
  }
  return out;
}
// Whether a translation has the term's agreed translation or one of its other forms (any case).
export const hasTarget = (term, text) => [term.target, ...(term.also || [])].some((t) => t && wordsOf(text).toLowerCase().includes(t.toLowerCase()));
