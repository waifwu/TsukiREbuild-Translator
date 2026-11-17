// markup.js - the text box's markup, read and written back exactly (the translator tool's editor, web-dev/TRANSLATOR-TOOL-PLAN.md Stage 2).
//
// A line is cut into tokens that each keep the characters they came from (`raw`), so joining the tokens gives the line back, every character of
// it. The game's own reading (web/app/js/textbox.js parseMarkup) is not used here: it drops @k, spaces ruby out again, turns tags into dashes and
// reads `^` as a break, which is right for showing a line but loses what was written. These are the same marks, read the same way:
//   it     italic letters: U+E000 plus the ASCII code (U+E020-E07E; U+E020 an italic space). Shown as the letters in italics, typed as such.
//   face   the patch's other faces, a run of one: mirrored (U+E0A0-E0FE), mirrored italic (U+E120-E17E), the archaic serif (U+E1A0-E1FE),
//          upside down (U+E2A0-E2FE), and the one exponent (U+E200). Shown as their letters, kept whole.
//   ruby   <base|reading>
//   mark   @c0-@c9 (colours), @g @t @b @k and any other @ and a small letter; [ber00], [zap00] and other [name00] tags
//   row    ^, the game's row break (a translator's own)
//   nl     a line break: deepLuna's 55-cell wraps, which the port takes out where the row was full (reflow.js), and the corners' rows
//   soft   U+E3FF, a break reflow.js took out (a space on screen)
//   jrow   U+E3FE, a row break the original engine made (Japanese and Chinese: where it wrapped)
//   text   everything else, as it is
// readable() gives a line with each face's letters as their ASCII letters: the same length, character for character, so a place found in it is
// the same place in the line (search and replace work on it).

export const SOFT = "\ue3ff";
export const JROW = "\ue3fe";
export const EXPONENT = "\ue200";
// [first, last, offset to the ASCII letter] of each face
export const FACES = { it: [0xE020, 0xE07E, 0xE000], m: [0xE0A0, 0xE0FE, 0xE080], mi: [0xE120, 0xE17E, 0xE100], a: [0xE1A0, 0xE1FE, 0xE180],
  u: [0xE2A0, 0xE2FE, 0xE280] };
export const FACE_NAMES = { it: "italic", m: "mirrored", mi: "mirrored italic", a: "archaic serif", u: "upside down", s: "exponent (-35)" };

export function faceOf(ch) {
  const c = ch.charCodeAt(0);
  if (c < 0xE000 || c > 0xE2FE) return "";
  for (const [k, [a, b]] of Object.entries(FACES)) if (c >= a && c <= b) return k;
  return c === 0xE200 ? "s" : "";
}
// A face's letter as plain ASCII (the exponent stays itself); any other character as it is.
export function letterOf(ch) {
  const k = faceOf(ch);
  if (!k || k === "s") return ch;
  return String.fromCharCode(ch.charCodeAt(0) - FACES[k][2]);
}
export const isItalic = (ch) => faceOf(ch) === "it";
// ASCII printable letters as italics; anything else (é, —, ...) has no italic form and stays as it is.
export const italic = (s) => s.replace(/[\x20-\x7E]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xE000));
// The same, but spaces kept plain: how the Tsukihimates text writes italic words (a plain space between them; Aniplex's has italic spaces).
export const italicLetters = (s) => s.replace(/[\x21-\x7E]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xE000));
export const unitalic = (s) => s.replace(/[\ue020-\ue07e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xE000));
export const readable = (s) => s.replace(/[\ue020-\ue2fe]/g, letterOf);

const TAG = /^\[[a-z]{2,6}\d{0,3}\]/;
const MARK = /^@(c\d|[a-z])/;

export function tokenize(s) {
  const out = [];
  let i = 0;
  const push = (k, raw, extra) => {
    const last = out[out.length - 1];
    if ((k === "text" || k === "it") && last && last.k === k) last.raw += raw;
    else if (k === "face" && last && last.k === "face" && last.face === extra.face && extra.face !== "s") last.raw += raw;
    else out.push({ k, raw, ...extra });
  };
  while (i < s.length) {
    const c = s[i];
    if (c === "<") {
      const end = s.indexOf(">", i), bar = s.indexOf("|", i);
      if (end > 0 && bar > i && bar < end) {
        const raw = s.slice(i, end + 1);
        push("ruby", raw, { base: s.slice(i + 1, bar), reading: s.slice(bar + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (c === "[") {
      const m = TAG.exec(s.slice(i, i + 12));
      if (m) { push("mark", m[0]); i += m[0].length; continue; }
    }
    if (c === "@") {
      const m = MARK.exec(s.slice(i, i + 3));
      if (m) { push("mark", m[0]); i += m[0].length; continue; }
    }
    if (c === "^") { push("row", c); i++; continue; }
    if (c === "\n") { push("nl", c); i++; continue; }
    if (c === SOFT) { push("soft", c); i++; continue; }
    if (c === JROW) { push("jrow", c); i++; continue; }
    const f = faceOf(c);
    if (f === "it") push("it", c);
    else if (f) push("face", c, { face: f });
    else push("text", c);
    i++;
  }
  return out;
}
export const join = (tokens) => tokens.map((t) => t.raw).join("");
export const ruby = (base, reading) => `<${base}|${reading}>`;

// Every mark of a line (ruby, marks, row breaks; not italics or plain text), in order: what a translation is expected to keep.
export const marksOf = (s) => tokenize(s).filter((t) => t.k === "mark" || t.k === "row" || t.k === "ruby").map((t) => (t.k === "ruby" ? "<|>" : t.raw));

// Italics on [a, b) of a line, or off where all its letters already are: the ASCII letters change, nothing else.
export function toggleItalic(s, a, b) {
  const part = s.slice(a, b);
  const letters = [...part].filter((c) => /[\x21-\x7E]/.test(c) || isItalic(c));
  const allItalic = letters.length > 0 && letters.every(isItalic);
  let out = "";
  // only plain text and italics change: a mark, ruby or face inside the range stays whole
  let at = 0;
  for (const t of tokenize(s)) {
    const t0 = at, t1 = at + t.raw.length;
    at = t1;
    if (t.k !== "text" && t.k !== "it") { out += t.raw; continue; }
    for (let k = 0; k < t.raw.length; k++) {
      const ch = t.raw[k], pos = t0 + k;
      if (pos < a || pos >= b) { out += ch; continue; }
      out += allItalic ? unitalic(ch) : italicLetters(ch);
    }
  }
  return out;
}

// Where [a, b) of a line lies among its tokens: whether it is all plain text and italics (so it can be replaced letter for letter), and whether
// all its letters are italic.
export function spanKind(s, a, b) {
  let at = 0, plain = true;
  for (const t of tokenize(s)) {
    const t0 = at, t1 = at + t.raw.length;
    at = t1;
    if (t1 <= a || t0 >= b) continue;
    if (t.k !== "text" && t.k !== "it") plain = false;
  }
  const letters = [...s.slice(a, b)].filter((c) => c !== " " && c !== "\ue020");
  return { plain, italic: letters.length > 0 && letters.every(isItalic) };
}

// ---- showing a line (no DOM needed: HTML text) -------------------------------------------------------------------------------------------
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const escapeHTML = esc;
// What each mark does, as the game reads it (web/app/js/vm.js parseMessage, textbox.js parseMarkup and colourMarks): shown when the pointer
// rests on a mark, in the edit box or a column.
const MARK_TIPS = {
  "@g": "@g: the rest of this line is set in the game's second face. The English patch shows it in italics; the original game shows no change. Keep it where the English has it.",
  "@t": "@t: the text before @t and the text after it type out at the same time, side by side (the longer part spread over the shorter's time). Keep one where the English has one.",
  "@b": "@b: the line is set from the right end of its row, its letters going leftwards.",
  "@k": "@k: the next message continues this one: it stays bright, not dimmed, while the next one types, as one sentence. No letter of its own. Keep it where the English has it.",
  "@x": "@x: this message goes on the row of the one before it, not on a new row.",
  "@e": "@e: the game goes on by itself once this is typed and its voice has finished, with no click.",
  "@n": "@n: the game goes on at once, without waiting for a click.",
  "@r": "@r: back to the line's own colour after a colour mark.",
  "@c0": "@c0: back to the line's own colour.",
};
export function markTip(raw) {
  if (MARK_TIPS[raw]) return MARK_TIPS[raw];
  const c = /^@c(\d)$/.exec(raw);
  if (c) {
    const n = Number(c[1]);
    if (n >= 1 && n <= 5) return `${raw}: colour ${n} of the game's colour table, from here to the next colour mark (or the whole line, when it comes before any letter).`;
    if (n >= 6) return `${raw}: the outlined face, with a ${["red", "dark grey", "black", "white"][n - 6]} outline.`;
  }
  if (/^\[ber\d+\]$/.test(raw)) return `${raw}: a noise bar. The game draws a strip over it; a run of [ber00] is one strip as long as the run (1 to 21). Keep as many as the English has.`;
  if (/^\[zap\d+\]$/.test(raw)) return `${raw}: a scribbled-out strip; a run of [zap00] is one strip as long as the run (1 to 8). Keep as many as the English has.`;
  if (/^\[/.test(raw)) return `${raw}: a letter of the game's own font that other fonts lack (the port draws a dash).`;
  if (/^@/.test(raw)) return `${raw}: a mark of the game's own; the English never uses it, so the checks call it an error.`;
  return raw;
}
export const markTitle = markTip;   // (the old name)
const TIPS = {
  row: "^: a row break. The text goes on at the start of the next row (Shift+Enter puts one in).",
  nl: "A line break from deepLuna's 55-letter rows: the port takes it out where the row was full (a space then), and keeps it where the row had room. Without deepLuna's rows, use ^ for a row of your own; \"↵ → space\" takes these out of a line.",
  soft: "A deepLuna row break the port took out: a space on screen.",
  jrow: "Where the original engine broke the row (Japanese and Chinese).",
  ruby: (t) => `Ruby: "${readable(t.reading)}" set small over "${readable(t.base)}". In the edit box, click it to change either.`,
  face: { m: "Mirrored letters (a line seen in a mirror): stored back to front, drawn flipped.", mi: "Mirrored italic letters (a line seen in a mirror): stored back to front, drawn flipped.",
    a: "The archaic serif face: these letters are drawn in a calligraphic italic.", u: "Upside-down letters: drawn flipped top to bottom.", s: "The raised -35 (10 to the power -35): one letter of its own." },
};
const tipOf = (t) => (t.k === "mark" ? markTip(t.raw) : t.k === "ruby" ? TIPS.ruby(t) : t.k === "face" ? TIPS.face[t.face] : TIPS[t.k] || "");
// One token's HTML. `opts.breaks`: show nl as a break (else a small mark, which keeps the box flowing as the game wraps it).
export function tokenHTML(t, opts = {}) {
  const raw = esc(t.raw);
  switch (t.k) {
    case "text": return esc(t.raw);
    case "it": return `<i>${esc(unitalic(t.raw))}</i>`;
    case "face": return `<span class="chip face f-${t.face}" contenteditable="false" data-raw="${raw}" data-tip="${esc(tipOf(t))}">${esc(t.face === "s" ? "⁻³⁵" : readable(t.raw))}</span>`;
    case "ruby": return `<span class="chip ruby" contenteditable="false" data-raw="${raw}" data-tip="${esc(tipOf(t))}"><ruby>${esc(readable(t.base))}<rt>${esc(readable(t.reading))}</rt></ruby></span>`;
    case "mark": return `<span class="chip mark" contenteditable="false" data-raw="${raw}" data-tip="${esc(tipOf(t))}">${raw}</span>`;
    case "row": return `<span class="chip row" contenteditable="false" data-raw="^" data-tip="${esc(tipOf(t))}">⏎\n</span>`;
    case "nl": return `<span class="chip nl" contenteditable="false" data-raw="&#10;" data-tip="${esc(tipOf(t))}">↵${opts.breaks ? "\n" : ""}</span>`;
    case "soft": return `<span class="chip soft" contenteditable="false" data-raw="${raw}" data-tip="${esc(tipOf(t))}"> </span>`;
    case "jrow": return `<span class="chip jrow" contenteditable="false" data-raw="${raw}" data-tip="${esc(tipOf(t))}">${opts.breaks ? "\n" : ""}</span>`;
    default: return raw;
  }
}
export const toHTML = (s, opts) => tokenize(s).map((t) => tokenHTML(t, opts)).join("");
// A line as plain words (what a copy gives other programs): the letters of every face as letters, a ruby's base, rows as line breaks, no marks.
export const plainText = (s) => tokenize(s).map((t) => (t.k === "text" ? t.raw : t.k === "it" || t.k === "face" ? readable(t.raw)
  : t.k === "ruby" ? readable(t.base) : t.k === "row" || t.k === "nl" ? "\n" : t.k === "soft" ? " " : "")).join("");
