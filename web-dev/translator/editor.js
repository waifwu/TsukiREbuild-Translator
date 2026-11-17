// editor.js - the translator tool's editor (web-dev/TRANSLATOR-TOOL-PLAN.md, Stage 2). Served by web-dev/tools/dev_server.py at /translator/.
//
// Scenes by route and day with their progress; a scene's lines in the order the game shows them, page by page, each beside the versions chosen
// as columns (Japanese and Tsukihimates to begin with); the translation's edit box, its status and a note. The edit box shows the text box's
// markup readably (markup.js): italics in italics, ruby over its base, marks and row breaks as small tags. What is written back is the line as
// the edit box holds it, character for character: a tag stands for exactly the characters it came from, and a line nobody touched is never
// written again. Changes are saved to the translations folder a moment after they are made (POST /translator/api/save), with the line as it was
// loaded, so a line someone else changed meanwhile is not overwritten.
import { tokenize, toHTML, italic, readable, toggleItalic, ruby as rubyOf, escapeHTML as esc, unitalic, plainText } from "./markup.js";
import { sceneLines, sceneTree, Book, counts, done, edited, compile, matchesIn, replaceIn, labelOf, STATUSES } from "./model.js";
import { Memory, wordsOf, formsOf, formPattern, termsIn, hasTarget } from "./memory.js";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const MOD = (e) => e.ctrlKey || e.metaKey;
const MARKUP_TYPE = "application/x-tsuki-markup";
const prefs = {
  get(k, d) { try { const v = localStorage.getItem(`translator.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`translator.${k}`, JSON.stringify(v)); } catch { /* (a private window) */ } },
};

// ---- the server --------------------------------------------------------------------------------------------------------------------------
const api = {
  token: null,
  async get(path) {
    const r = await fetch(path, { cache: "no-store" });
    const body = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
    if (!r.ok) throw Object.assign(new Error(body.error || r.statusText), { status: r.status, body });
    return body;
  },
  async post(path, data, retry = true) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Translator-Token": api.token }, body: JSON.stringify(data) });
    const body = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
    if (r.status === 403 && retry && /token/.test(body.error || "")) {   // the server was started again: its new token
      api.token = (await api.get("/translator/api/state")).token;
      return api.post(path, data, false);
    }
    return { status: r.status, body };
  },
};

// ---- what the editor holds ------------------------------------------------------------------------------------------------------------
const app = {
  state: null, map: null, lines: null, tree: null, book: new Book(), language: null, folder: null,
  texts: new Map(),        // language -> its text.json (a promise until loaded)
  columns: [], scene: null, filter: "all",
  dirty: new Map(),        // line -> the scene file it is saved in
  version: new Map(),      // line -> how many times it was changed (a save done while it changed again leaves it dirty)
  hashing: new Set(),      // promises of `from` hashes not in yet
  saving: false, error: null, timer: 0,
};
const sceneName = (s) => app.map.scenes[s].name;
const sceneIndex = new Map();
const scenesOfLine = (id) => [...new Set(app.map.lines[id].at.map((a) => a.s))];

function textOf(lang) {
  if (!app.texts.has(lang)) {
    const url = lang === "en" ? "/assets/text.json" : `/assets/${lang}/text.json`;
    app.texts.set(lang, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((t) => { app.texts.set(lang, t); return t; }));
  }
  return app.texts.get(lang);
}
const loaded = (lang) => { const t = app.texts.get(lang); return Array.isArray(t) ? t : null; };

const hashes = new Map();
async function hash12(s) {
  if (hashes.has(s)) return hashes.get(s);
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  const h = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
  hashes.set(s, h);
  return h;
}

// ---- the edit box's DOM: the line in, the line out ----------------------------------------------------------------------------------------
function render(el, raw) { el.innerHTML = toHTML(raw); }
// The line an edit box (or a column) holds: its text, italics as the italic letters, each tag as the characters it stands for.
export function serialize(root) {
  let out = "";
  const walk = (node, it) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) out += it ? italic(n.data) : n.data;
      else if (n.nodeType === 1) {
        if (n.dataset.raw !== undefined) out += n.dataset.raw;
        else if (n.tagName === "BR" || n.classList.contains("use")) continue;
        else walk(n, it || n.tagName === "I" || n.tagName === "EM");
      }
    }
  };
  walk(root, false);
  return out;
}
// Something the browser put in that the edit box does not make (a <div> or <b> from a key, a style): the box is drawn again from its line.
const tidy = (el) => !$$("*", el).some((n) => !(n.dataset.raw !== undefined || n.closest("[data-raw]") !== null && n.closest("[data-raw]") !== n
  || (n.tagName === "I" && [...n.childNodes].every((c) => c.nodeType === 3)) || (n.tagName === "BR" && n === el.lastChild)));
const chipOf = (node, el) => { const c = node.nodeType === 1 ? node.closest("[data-raw]") : node.parentElement?.closest("[data-raw]"); return c && el.contains(c) ? c : null; };
// A place in the box (node, offset) as a place in its line.
function offsetOf(el, node, off) {
  const chip = chipOf(node, el);
  if (chip) { node = chip.parentNode; off = [...node.childNodes].indexOf(chip) + 1; }
  let n = 0, found = false;
  const walk = (cur) => {
    if (cur.nodeType === 3) { if (cur === node) { n += off; found = true; } else n += cur.data.length; return; }
    if (cur !== el && cur.dataset?.raw !== undefined) { n += cur.dataset.raw.length; return; }
    const kids = cur.childNodes;
    for (let k = 0; k < kids.length; k++) {
      if (cur === node && k === off) { found = true; return; }
      if (kids[k].nodeType === 1 && kids[k].classList.contains("use")) continue;
      walk(kids[k]);
      if (found) return;
    }
    if (cur === node) found = true;
  };
  walk(el);
  return n;
}
// A place in the line as a place in the box.
function pointAt(el, x) {
  let n = 0, hit = null;
  const walk = (cur) => {
    for (let k = 0; k < cur.childNodes.length && !hit; k++) {
      const c = cur.childNodes[k];
      if (c.nodeType === 3) { if (x <= n + c.data.length) { hit = [c, x - n]; return; } n += c.data.length; }
      else if (c.dataset?.raw !== undefined) {
        if (x <= n) { hit = [cur, k]; return; }
        n += c.dataset.raw.length;
        if (x === n && !(c.nextSibling && (c.nextSibling.nodeType === 3 || c.nextSibling.tagName === "I"))) { hit = [cur, k + 1]; return; }
      } else if (c.tagName !== "BR") walk(c);
    }
  };
  walk(el);
  return hit || [el, el.childNodes.length];
}
function caret(el) {
  const sel = getSelection();
  if (!sel.rangeCount || !el.contains(sel.anchorNode)) { const n = serialize(el).length; return [n, n]; }
  const r = sel.getRangeAt(0);
  return [offsetOf(el, r.startContainer, r.startOffset), offsetOf(el, r.endContainer, r.endOffset)];
}
function setCaret(el, a, b = a) {
  const r = document.createRange();
  r.setStart(...pointAt(el, a));
  r.setEnd(...pointAt(el, b));
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

// ---- undo, a line at a time ------------------------------------------------------------------------------------------------------------
function hist(el) {
  if (!el._hist) el._hist = { stack: [{ raw: serialize(el), a: 0, b: 0 }], at: 0, t: 0 };
  return el._hist;
}
function remember(el, raw, a, b, typing = false) {
  const h = hist(el);
  const now = performance.now();
  h.stack.length = h.at + 1;
  if (typing && h.typing && now - h.t < 1000 && h.at > 0) h.stack[h.at] = { raw, a, b };
  else { h.stack.push({ raw, a, b }); h.at++; }
  h.t = now;
  h.typing = typing;
}
function travel(el, step) {
  const h = hist(el);
  const to = h.at + step;
  if (to < 0 || to >= h.stack.length) return;
  h.at = to;
  h.typing = false;
  const s = h.stack[to];
  render(el, s.raw);
  setCaret(el, s.a, s.b);
  changed(el, s.raw);
}
// Replace [a, b) of the box's line with `s` (a line's characters), and put the caret after it.
function insertRaw(el, s, range = caret(el)) {
  const raw = serialize(el);
  const [a, b] = range;
  const next = raw.slice(0, a) + s + raw.slice(b);
  render(el, next);
  setCaret(el, a + s.length);
  remember(el, next, a + s.length, a + s.length);
  changed(el, next);
}

// ---- changes to a line ---------------------------------------------------------------------------------------------------------------
const lineEl = (id) => document.querySelector(`.line[data-id="${id}"]`);
function changed(el, raw) {
  const id = Number(el.closest(".line").dataset.id);
  change(id, { text: raw });
}
function fromFor(id) {
  const lang = app.language?.from || "ja";
  const from = { lang };
  const src = loaded(lang);
  if (src && typeof src[id] === "string") {
    const p = hash12(src[id]).then((h) => {
      const r = app.book.rows.get(id);
      if (r?.from === from) from.hash = h;
    }).finally(() => app.hashing.delete(p));
    app.hashing.add(p);
  }
  return from;
}
function change(id, ch, s = app.scene) {
  if (!app.folder) return;
  const scene = sceneName(s);
  const before = app.book.rows.get(id) || null;
  const row = edited(before, id, ch, "text" in ch ? fromFor(id) : null);
  app.book.rows.set(id, row);
  app.dirty.set(id, app.book.fileOf(id, scene));
  app.version.set(id, (app.version.get(id) || 0) + 1);
  const el = lineEl(id);
  if (el) {
    el.classList.add("dirty");
    const sel = $("select", el);
    if (sel && sel.value !== app.book.statusOf(id)) sel.value = app.book.statusOf(id);
    if (sel) sel.className = `s-${app.book.statusOf(id)}`;
    staleBadge(id);
  }
  progressOf(scenesOfLine(id));
  saveSoon();
  if (pv.win && "text" in ch) previewLine(id);
  if ("text" in ch && hints.line && Number(hints.line.dataset.id) === id) { clearTimeout(hints.timer); hints.timer = setTimeout(() => drawHints(hints.line), 300); }
}

// ---- saving ---------------------------------------------------------------------------------------------------------------------------
function saveSoon(ms = 700) {
  clearTimeout(app.timer);
  showSave();
  app.timer = setTimeout(flush, ms);
}
async function flush() {
  clearTimeout(app.timer);
  if (app.saving || !app.dirty.size) { showSave(); return; }
  app.saving = true;
  showSave();
  try {
    await Promise.all([...app.hashing]);
    const byFile = new Map();
    const sent = new Map();
    for (const [id, file] of app.dirty) {
      const after = app.book.rows.get(id) ?? null;
      const before = app.book.disk.get(id) ?? null;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push({ id, before, after });
      sent.set(id, { version: app.version.get(id), after: structuredClone(after) });
    }
    const { status, body } = await api.post("/translator/api/save", { files: [...byFile].map(([scene, changes]) => ({ scene, changes })) });
    if (status === 200) {
      app.error = null;
      if (body.findings) takeLineFindings(body.findings);
      for (const [id, s] of sent) {
        app.book.disk.set(id, s.after);
        if (s.after) app.book.owner.set(id, app.dirty.get(id) || app.book.owner.get(id));
        if (app.version.get(id) === s.version) { app.dirty.delete(id); lineEl(id)?.classList.remove("dirty"); }
      }
    } else if (status === 409 && body.conflicts) {
      app.error = body.error;
      conflicts(body.conflicts);
    } else {
      app.error = body.error || `${status}`;
      banner(`Not saved: ${esc(app.error)}${body.errors ? `<br>${body.errors.slice(0, 5).map(esc).join("<br>")}` : ""}`, true);
    }
  } catch (e) {
    app.error = `the server did not answer (${e.message}): is dev_server.py still running?`;
  } finally {
    app.saving = false;
    showSave();
    if (app.dirty.size && !app.error) saveSoon();
  }
}
function showSave() {
  const el = $("#save-state");
  if (!app.folder) { el.textContent = "read only"; el.className = "save-state"; return; }
  el.className = `save-state${app.error ? " error" : app.dirty.size ? " unsaved" : ""}`;
  el.textContent = app.error ? "Not saved" : app.saving ? "Saving…" : app.dirty.size ? `Unsaved: ${app.dirty.size}` : "All saved";
  el.title = app.error || "Lines are saved to the translations folder a moment after you change them (Ctrl+S: now)";
}
function conflicts(list) {
  const lines = list.map((c) => `line ${c.id} (${esc(c.scene)}): ${esc(c.why)}`).join("<br>");
  banner(`${list.length === 1 ? "A line was" : `${list.length} lines were`} changed on disk since loaded (another editor, or lines pulled with git). Nothing was saved.<br>${lines}
    <br><button type="button" data-act="theirs">Take the disk's</button><button type="button" data-act="mine">Keep mine</button>`, true, (act) => {
    for (const c of list) {
      if (c.owner) { app.book.owner.set(c.id, c.owner); app.dirty.set(c.id, c.owner); continue; }
      if (act === "theirs") {
        app.book.rows.set(c.id, structuredClone(c.current));
        app.book.disk.set(c.id, structuredClone(c.current));
        app.dirty.delete(c.id);
        redrawLine(c.id);
      } else app.book.disk.set(c.id, c.current ? structuredClone(c.current) : null);
    }
    app.error = null;
    banner(null);
    progressOf(list.flatMap((c) => scenesOfLine(c.id)));
    saveSoon(0);
  });
}
function banner(html, bad = false, onAct = null) {
  const el = $("#banner");
  el.hidden = !html;
  if (!html) return;
  el.className = `banner${bad ? " bad" : ""}`;
  el.innerHTML = html;
  el.onclick = (e) => { const b = e.target.closest("button[data-act]"); if (b && onAct) onAct(b.dataset.act); };
}
addEventListener("beforeunload", (e) => { if (app.dirty.size) { e.preventDefault(); e.returnValue = ""; } });

// ---- progress --------------------------------------------------------------------------------------------------------------------------
function barHTML(c, wide = false) {
  const t = c.total || 1;
  return `<span class="bar${wide ? " wide" : ""}" title="${c.final} final, ${c.reviewed} reviewed, ${c.draft} draft, ${c.empty} not translated">`
    + ["final", "reviewed", "draft"].map((k) => `<i class="${k}" style="width:${(100 * c[k]) / t}%"></i>`).join("") + "</span>";
}
const sceneCounts = new Map();
function progressOf(scenes) {
  for (const s of new Set(scenes)) {
    const c = counts(app.lines[s].map((x) => x.id), app.book);
    sceneCounts.set(s, c);
    const row = $(`.scene[data-s="${s}"]`);
    if (row) { $(".bar", row).outerHTML = barHTML(c); $(".num", row).textContent = `${done(c)}/${c.total}`; row.classList.toggle("done", c.empty === 0); }
  }
  for (const g of $$(".group[data-scenes]")) {
    const ss = g.dataset.scenes.split(",").map(Number);
    if (!ss.some((s) => scenes.includes(s))) continue;
    groupBar(g, ss);
  }
  for (const r of $$(".route[data-scenes]")) {
    const ss = r.dataset.scenes.split(",").map(Number);
    if (ss.some((s) => scenes.includes(s))) groupBar(r, ss);
  }
  totals();
  if (scenes.includes(app.scene)) sceneHeadCounts();
}
function groupBar(el, ss) {
  const c = { empty: 0, draft: 0, reviewed: 0, final: 0, total: 0 };
  for (const s of ss) for (const [k, v] of Object.entries(sceneCounts.get(s))) c[k] += v;
  const head = el.firstElementChild;
  $(".bar", head).outerHTML = barHTML(c);
  $(".num", head).textContent = `${Math.floor((100 * done(c)) / (c.total || 1))}%`;
}
function totals() {
  const ids = app.map.lines.filter((l) => l.at.length).map((l) => l.id);
  const c = counts(ids, app.book);
  $("#total").innerHTML = `${barHTML(c, true)}<span class="num">${done(c).toLocaleString()} of ${c.total.toLocaleString()} lines</span>`;
  refreshHome();
}

// ---- the scene list --------------------------------------------------------------------------------------------------------------------
function drawTree() {
  const open = prefs.get("open", {});
  const html = app.tree.map((r) => {
    const rs = r.groups.flatMap((g) => g.scenes);
    const groups = r.groups.map((g) => `<div class="group${open[`${r.route}/${g.key}`] ? "" : " closed"}" data-key="${r.route}/${g.key}" data-scenes="${g.scenes.join(",")}">
      <div class="head"><span class="caret">▾</span><span class="name">${esc(g.label)}</span><span class="bar"></span><span class="num"></span></div>
      <div class="kids">${g.scenes.map((s) => `<div class="scene" data-s="${s}"><span class="name" title="${esc(sceneName(s))}">${esc(sceneName(s))}</span><span class="bar"></span><span class="num"></span></div>`).join("")}</div></div>`).join("");
    return `<div class="route${open[r.route] === false ? " closed" : ""}" data-key="${r.route}" data-scenes="${rs.join(",")}"><div class="head"><span class="caret">▾</span><span class="name">${esc(r.label)}</span><span class="bar"></span><span class="num"></span></div><div class="kids">${groups}</div></div>`;
  }).join("");
  $("#tree").innerHTML = html;
  progressOf(app.map.scenes.map((_, s) => s).filter((s) => app.lines[s].length));
  filterTree();
}
function filterTree() {
  const q = $("#scene-filter").value.trim().toLowerCase();
  const hide = $("#hide-done").checked;
  for (const row of $$(".scene")) {
    const s = Number(row.dataset.s);
    const c = sceneCounts.get(s);
    row.hidden = (q && !sceneName(s).toLowerCase().includes(q)) || (hide && c && c.empty === 0);
  }
  for (const g of $$(".group")) {
    g.hidden = $$(".scene", g).every((r) => r.hidden);
    if (q) g.classList.remove("closed");
  }
}
$("#tree").addEventListener("click", (e) => {
  const sc = e.target.closest(".scene");
  if (sc) { goScene(Number(sc.dataset.s)); return; }
  const head = e.target.closest(".head");
  if (!head) return;
  const box = head.parentElement;
  box.classList.toggle("closed");
  const open = prefs.get("open", {});
  open[box.dataset.key] = !box.classList.contains("closed");
  prefs.set("open", open);
});
$("#scene-filter").addEventListener("input", filterTree);
$("#hide-done").addEventListener("change", filterTree);

// ---- a scene ------------------------------------------------------------------------------------------------------------------------
// The line columns: the number, each reference column and the translation, the status. The ones between are shared out by weights the
// header's handles move (remembered per set of columns).
const colKey = () => `cols:${app.columns.join(",")}`;
function weights() {
  const w = prefs.get(colKey(), null);
  return Array.isArray(w) && w.length === app.columns.length + 1 && w.every((x) => x > 0) ? w : [...app.columns.map(() => 1), 1.25];
}
const gridCols = (w = weights()) => `64px ${w.map((x) => `minmax(0, ${x.toFixed(3)}fr)`).join(" ")} 104px`;
const applyCols = (w) => document.documentElement.style.setProperty("--cols", gridCols(w));
function sceneHeadCounts() {
  const c = sceneCounts.get(app.scene);
  const el = $("#scene-head .counts");
  if (el && c) el.innerHTML = `${barHTML(c, true)}<span class="num">${done(c)} of ${c.total} lines</span>`;
}
function where(sc) {
  if (sc.route === "qa") return `Ciel-sensei's corner, episode ${sc.episode}`;
  if (sc.route === "arcueid" || sc.route === "ciel") return `${sc.route === "arcueid" ? "Arcueid" : "Ciel"}, day ${sc.day}${sc.part ? ` (${sc.part})` : ""}`;
  return sc.route === "prologue" ? "Prologue" : "System";
}
async function openScene(s, focusId = null) {
  if (app.dirty.size) flush();
  app.scene = s;
  for (const row of $$(".scene.on")) row.classList.remove("on");
  const row = $(`.scene[data-s="${s}"]`);
  if (row) {
    row.classList.add("on");
    for (let p = row.parentElement; p && p !== $("#tree"); p = p.parentElement) p.classList.remove("closed");
    row.scrollIntoView({ block: "nearest" });
  }
  const sc = app.map.scenes[s];
  // (the address names the scene, so a reload comes back to it; not while Help is up)
  if (!homeOn()) window.history.replaceState(null, "", `#${encodeURIComponent(sc.name)}${focusId !== null ? `/${focusId}` : ""}`);
  if (!homeOn() || focusId !== null) prefs.set("last", { scene: sc.name, id: focusId });
  const list = app.lines[s];
  $("#scene-head").innerHTML = `<div class="scene-title"><h2>${esc(sc.name)}</h2><span class="where">${esc(where(sc))}</span><span class="counts"></span></div>
    <div class="scene-tools">Show <select id="line-filter">${[["all", "every line"], ["empty", "not translated"], ["draft", "draft"], ["reviewed", "reviewed"],
      ["final", "final"], ["stale", "stale"], ["note", "with a note"]].map(([v, l]) => `<option value="${v}"${app.filter === v ? " selected" : ""}>${l}</option>`).join("")}</select>
      <span class="num">${list.length} lines on ${new Set(list.map((x) => x.page)).size} pages</span></div>
    <div class="cols"><span>Line</span>${app.columns.map((c, k) => `<span>${esc(labelOf(c))}<i class="split-c" data-k="${k}" title="Drag to share the width between these columns; double-click: as they were"></i></span>`).join("")}<span>${esc(app.language?.name || app.language?.code || "Translation")}</span><span>Status</span></div>`;
  applyCols();
  sceneHeadCounts();
  $("#line-filter").onchange = (e) => { app.filter = e.target.value; applyFilter(); };
  await Promise.all(app.columns.map(textOf));
  if (app.scene !== s) return;
  let html = "", page = undefined;
  app.pageOf = new Map(list.map((x) => [x.id, x.page]));
  for (const x of list) {
    if (x.page !== page) {
      page = x.page;
      html += page === null ? `<div class="page" data-page="">not on a page the game plays</div>`
        : `<div class="page" data-page="${page}"><span>page ${app.map.pages[page].k + 1}</span><span class="fitv"></span><button type="button" class="play" title="Play the game from this page in the translation (a new tab)">▶ play</button></div>`;
    }
    html += lineHTML(x);
  }
  const box = $("#lines");
  box.innerHTML = html || `<div class="empty-note">This scene shows no lines.</div>`;
  box.scrollTop = 0;
  $("#main").scrollTop = 0;
  applyFilter();
  markTerms(box);
  Promise.all(list.map((x) => staleBadge(x.id))).then(() => { if (app.filter === "stale") applyFilter(); });
  if (focusId !== null) focusLine(focusId);
  if (pv.ready) fitScene(s);
}
function lineHTML(x) {
  const id = x.id, ln = app.map.lines[id], row = app.book.rows.get(id);
  const st = app.book.statusOf(id);
  const badges = [ln.choice && `<span class="badge" title="a choice: one row, no row break">choice</span>`,
    ln.glued && `<span class="badge" title="set on the row of the line before it">glued</span>`,
    ln.voice && `<span class="badge" title="voiced: ${esc(ln.voice)}">voice</span>`,
    x.dead && `<span class="badge never" title="only in the PlayStation 4's part of the script: never played">PS4</span>`,
    !ln.at.length && `<span class="badge never">never shown</span>`].filter(Boolean).join("");
  const other = app.book.owner.get(id) && app.book.owner.get(id) !== sceneName(app.scene) ? `<span class="badge" title="kept in ${esc(app.book.owner.get(id))}.json">in ${esc(app.book.owner.get(id))}</span>` : "";
  const refs = app.columns.map((lang) => {
    const t = loaded(lang);
    if (!t) return `<div class="ref none">${esc(labelOf(lang))} is not in this app</div>`;
    return `<div class="ref" lang="${esc(lang)}">${toHTML(t[id] ?? "")}<button type="button" class="use" data-lang="${esc(lang)}" title="Put this line in the edit box (its marks too)">use</button></div>`;
  }).join("");
  const note = row?.note || "";
  return `<div class="line${app.dirty.has(id) ? " dirty" : ""}" data-id="${id}">
    <div class="meta"><span class="id" title="Line ${id}: click to copy its link">#${id}</span>${badges}${other}<span class="stale-slot"></span><span class="ck-slot">${ckBadge(id)}</span></div>
    ${refs}
    <div class="edit"><div class="ed" contenteditable="${app.folder ? "true" : "false"}" spellcheck="true" lang="${esc(app.language?.code || "")}" data-placeholder="not translated">${toHTML(row?.text || "")}</div>
      <div class="tools"><button type="button" data-do="italic" title="Italics on the chosen letters, or off (Ctrl+I)"><i>I</i></button><button type="button" data-do="ruby" title="Ruby over the chosen letters">ruby</button><button type="button" data-do="row" title="A row break of your own, ^ (Shift+Enter)">⏎ row</button><span class="sep"></span>${["@g", "@k", "[ber00]", "[zap00]"].map((m) => `<button type="button" data-do="mark" data-mark="${m}" title="${m}">${m}</button>`).join("")}<span class="sep"></span><button type="button" data-do="unwrap" title="Line breaks (↵) to spaces: deepLuna's rows, which no longer fall where a row is full once the line is changed">↵ → space</button><button type="button" data-do="note" title="A note on this line, kept in the translation">note</button></div>
      <textarea class="note" rows="1" placeholder="note" ${note ? "" : "hidden"}>${esc(note)}</textarea><div class="line-ck">${ckList(id)}</div><div class="hints"></div></div>
    <div class="state"><select class="s-${st}" ${app.folder ? "" : "disabled"} title="empty: not translated (the English is shown); draft, reviewed, final">${STATUSES.map((v) => `<option value="${v}"${v === st ? " selected" : ""}>${v}</option>`).join("")}</select></div></div>`;
}
function redrawLine(id) {
  const el = lineEl(id);
  if (!el) return;
  const x = app.lines[app.scene].find((y) => y.id === id);
  el.outerHTML = lineHTML(x);
  staleBadge(id);
}
function applyFilter() {
  const f = app.filter;
  for (const el of $$(".line")) {
    const id = Number(el.dataset.id);
    const st = app.book.statusOf(id);
    const show = f === "all" || f === st || (f === "note" && app.book.rows.get(id)?.note) || (f === "stale" && el.dataset.stale === "1");
    el.classList.toggle("hidden", !show);
  }
}
function focusLine(id, end = true) {
  const el = lineEl(id);
  if (!el) return;
  el.classList.remove("hidden");
  const ed = $(".ed", el);
  ed.focus();
  el.scrollIntoView({ block: "center" });
  if (end) { const n = serialize(ed).length; setCaret(ed, n); }
}
function nextLine(el, step) {
  let n = el;
  do n = step > 0 ? n.nextElementSibling : n.previousElementSibling; while (n && (!n.classList.contains("line") || n.classList.contains("hidden")));
  if (n) focusLine(Number(n.dataset.id));
}

// Stale: the line it was translated from has changed since (its hash is not that line's any more).
async function staleBadge(id) {
  const el = lineEl(id);
  const r = app.book.rows.get(id);
  const slot = el && $(".stale-slot", el);
  if (!slot) return;
  const src = r?.from?.hash && r.text ? await textOf(r.from.lang) : null;
  const now = src && typeof src[id] === "string" ? await hash12(src[id]) : null;
  const stale = !!(now && now !== r.from.hash);
  el.dataset.stale = stale ? "1" : "";
  slot.innerHTML = stale ? `<span class="badge stale" title="Its ${esc(labelOf(r.from.lang))} line has changed since this was translated. Click when you have checked it.">stale</span>` : "";
}

// ---- the edit box's keys, pointer and clipboard ---------------------------------------------------------------------------------------
const lines = $("#lines");
lines.addEventListener("focusin", (e) => {
  const line = e.target.closest(".line");
  for (const l of $$(".line.focus")) if (l !== line) l.classList.remove("focus");
  if (line) line.classList.add("focus");
  if (line && previewOn()) showPage(app.pageOf.get(Number(line.dataset.id)));
  if (line && line !== hints.line) drawHints(line);
  if (e.target.classList.contains("ed")) {
    hist(e.target);
    window.history.replaceState(null, "", `#${encodeURIComponent(sceneName(app.scene))}/${line.dataset.id}`);
  }
});
lines.addEventListener("beforeinput", (e) => {
  const ed = e.target.closest?.(".ed");
  if (!ed) return;
  const t = e.inputType;
  if (t === "historyUndo" || t === "historyRedo") { e.preventDefault(); travel(ed, t === "historyUndo" ? -1 : 1); return; }
  if (t.startsWith("format") || t === "insertParagraph" || t === "insertLineBreak" || t === "insertFromDrop") e.preventDefault();
});
lines.addEventListener("input", (e) => {
  const ed = e.target.closest?.(".ed");
  if (ed) {
    const [a, b] = caret(ed);
    const raw = serialize(ed);
    if (!tidy(ed)) { render(ed, raw); setCaret(ed, a, b); }
    remember(ed, raw, a, b, e.inputType === "insertText" || e.inputType?.startsWith("delete"));
    changed(ed, raw);
    return;
  }
  if (e.target.classList.contains("note")) {
    const id = Number(e.target.closest(".line").dataset.id);
    change(id, { note: e.target.value });
  }
});
lines.addEventListener("change", (e) => {
  if (e.target.tagName !== "SELECT") return;
  const id = Number(e.target.closest(".line").dataset.id);
  const v = e.target.value;
  const r = app.book.rows.get(id);
  if (v !== "empty" && !r?.text) { e.target.value = "empty"; return; }   // (a status needs a line: write it first)
  change(id, { status: v });
  applyFilter();
});
lines.addEventListener("keydown", (e) => {
  const ed = e.target.closest?.(".ed");
  if (!ed) return;
  const line = ed.closest(".line");
  if (e.key === "Enter" && !e.shiftKey && !e.altKey) { e.preventDefault(); nextLine(line, 1); return; }
  if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); insertRaw(ed, "^"); return; }
  if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); nextLine(line, e.key === "ArrowDown" ? 1 : -1); return; }
  if (!MOD(e)) return;
  const k = e.key.toLowerCase();
  if (k === "i") { e.preventDefault(); italics(ed); }
  else if (k === "b" || k === "u") e.preventDefault();
  else if (k === "z") { e.preventDefault(); travel(ed, e.shiftKey ? 1 : -1); }
  else if (k === "y") { e.preventDefault(); travel(ed, 1); }
});
function italics(ed) {
  const [a, b] = caret(ed);
  if (a === b) return;
  const next = toggleItalic(serialize(ed), a, b);
  render(ed, next);
  setCaret(ed, a, b);
  remember(ed, next, a, b);
  changed(ed, next);
}
lines.addEventListener("paste", (e) => {
  const ed = e.target.closest?.(".ed");
  if (!ed) return;
  e.preventDefault();
  const d = e.clipboardData;
  const s = (d.getData(MARKUP_TYPE) || d.getData("text/plain")).replace(/\r\n?/g, "\n");
  if (s) insertRaw(ed, s);
});
lines.addEventListener("drop", (e) => { if (e.target.closest?.(".ed")) e.preventDefault(); });
function copyOut(e, cut) {
  const sel = getSelection();
  if (!sel.rangeCount) return;
  const cell = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest(".ed, .ref");
  if (!cell || !cell.contains(sel.focusNode)) return;
  const r = sel.getRangeAt(0);
  const a = offsetOf(cell, r.startContainer, r.startOffset), b = offsetOf(cell, r.endContainer, r.endOffset);
  const raw = serialize(cell).slice(a, b);
  e.preventDefault();
  e.clipboardData.setData("text/plain", plainText(raw));
  e.clipboardData.setData(MARKUP_TYPE, raw);
  if (cut && cell.classList.contains("ed")) insertRaw(cell, "", [a, b]);
}
document.addEventListener("copy", (e) => copyOut(e, false));
document.addEventListener("cut", (e) => copyOut(e, true));
lines.addEventListener("mousedown", (e) => { if (e.target.closest(".tools button")) e.preventDefault(); });   // (the edit box keeps its caret)
lines.addEventListener("click", (e) => {
  const play = e.target.closest(".page .play");
  if (play) { playFrom(Number(play.closest(".page").dataset.page)); return; }
  const line = e.target.closest(".line");
  if (!line) return;
  const id = Number(line.dataset.id);
  const ed = $(".ed", line);
  const use = e.target.closest(".use");
  if (use && app.folder) {
    const src = loaded(use.dataset.lang)?.[id] ?? "";
    const old = serialize(ed);
    if (old && !confirm("Put this line in the edit box in place of what it has?")) return;
    render(ed, src);
    remember(ed, src, src.length, src.length);
    changed(ed, src);
    focusLine(id);
    return;
  }
  if (e.target.closest(".meta .id")) {
    navigator.clipboard?.writeText(`${location.origin}/translator/#${encodeURIComponent(sceneName(app.scene))}/${id}`).catch(() => {});
    return;
  }
  if (e.target.closest(".badge.stale")) { checked(id); return; }
  const chip = e.target.closest(".ed .chip.ruby");
  if (chip && app.folder) { rubyPop(ed, chip); return; }
  const b = e.target.closest(".tools button");
  if (!b || !app.folder) return;
  const d = b.dataset.do;
  if (d === "italic") italics(ed);
  else if (d === "row") insertRaw(ed, "^");
  else if (d === "mark") insertRaw(ed, b.dataset.mark);
  else if (d === "ruby") rubyPop(ed, null);
  else if (d === "unwrap") {
    const raw = serialize(ed);
    const next = raw.replace(/ ?\n ?/g, " ");
    if (next !== raw) { render(ed, next); remember(ed, next, next.length, next.length); changed(ed, next); }
  } else if (d === "note") { const t = $(".note", line); t.hidden = false; t.focus(); }
});
async function checked(id) {
  const r = app.book.rows.get(id);
  const src = await textOf(r.from.lang);
  if (!src) return;
  change(id, { from: { ...r.from, hash: await hash12(src[id]) } });
}

// Ruby: over the chosen letters (chip null), or a ruby already there.
function rubyPop(ed, chip) {
  const raw = serialize(ed);
  let a, b, base, reading;
  if (chip) {
    a = offsetOf(ed, chip.parentNode, [...chip.parentNode.childNodes].indexOf(chip));
    b = a + chip.dataset.raw.length;
    const t = tokenize(chip.dataset.raw)[0];
    base = t.base; reading = t.reading;
  } else {
    [a, b] = caret(ed);
    base = raw.slice(a, b); reading = "";
  }
  const italicBase = base && [...base].every((c) => /[\ue020-\ue07e]/.test(c));
  const italicReading = reading && [...reading].every((c) => /[\ue020-\ue07e]/.test(c));
  const pop = $("#pop");
  pop.innerHTML = `<label>Base (the letters in the line)<input name="base" value="${esc(readable(base))}"></label>
    <label>Reading (over them)<input name="reading" value="${esc(readable(reading))}"></label>
    <div class="btns">${chip ? `<button type="button" data-act="remove">Remove ruby</button>` : ""}<button type="button" data-act="cancel">Cancel</button><button type="button" class="primary" data-act="ok">OK</button></div>`;
  const r = (chip || ed).getBoundingClientRect();
  pop.style.left = `${Math.min(r.left, innerWidth - 300)}px`;
  pop.style.top = `${Math.min(r.bottom + 6, innerHeight - 160)}px`;
  pop.hidden = false;
  $("input[name=reading]", pop).focus();
  const done = (act) => {
    pop.hidden = true;
    pop.onclick = pop.onkeydown = null;
    ed.focus();
    if (act === "cancel") return;
    const fieldBase = $("input[name=base]", pop).value, fieldReading = $("input[name=reading]", pop).value;
    // fields are shown as plain letters: what was all italics goes back in italics, what was not is written as typed
    const nb = fieldBase === readable(base) ? base : italicBase ? italic(fieldBase) : fieldBase;
    const nr = fieldReading === readable(reading) ? reading : italicReading ? italic(fieldReading) : fieldReading;
    const s = act === "remove" ? base : nb ? rubyOf(nb, nr) : "";
    insertRaw(ed, s, [a, b]);
  };
  pop.onclick = (e) => { const x = e.target.closest("button[data-act]"); if (x) done(x.dataset.act); };
  pop.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); done("ok"); } else if (e.key === "Escape") done("cancel"); };
}

// ---- columns and the language ----------------------------------------------------------------------------------------------------------
function drawColumns() {
  const menu = $("#columns");
  menu.innerHTML = app.state.languages.map((l) => `<label class="check"><input type="checkbox" value="${esc(l)}"${app.columns.includes(l) ? " checked" : ""}> ${esc(labelOf(l))} <span class="num">${esc(l)}</span></label>`).join("")
    + `<span class="hint">Japanese and Tsukihimates are shown to begin with.</span>`;
}
$("#b-columns").addEventListener("click", () => { $("#columns").hidden = !$("#columns").hidden; });
document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) $("#columns").hidden = true; });
$("#columns").addEventListener("change", () => {
  const order = app.state.languages;
  app.columns = $$("#columns input:checked").map((i) => i.value).sort((a, b) => colRank(a, order) - colRank(b, order));
  prefs.set("columns", app.columns);
  if (app.scene !== null) openScene(app.scene);
});
const colRank = (l, order) => (l === "ja" ? -2 : l === "en" ? -1 : order.indexOf(l));
function showLanguage() {
  const l = app.language || {};
  $("#lang-name").textContent = app.folder ? `${l.name || "(no name)"}${l.code ? ` · ${l.code}` : ""} · ${app.folder}` : "no translations folder";
  $("#lang-name").title = app.folder ? `Translations folder: ${app.folder}\nTranslated from: ${labelOf(l.from || "ja")}` : "";
}
$("#b-language").addEventListener("click", () => {
  if (!app.folder) return;
  const f = $("#lang-form").elements;
  const l = app.language || {};
  f.namedItem("code").value = l.code || app.state.code || "";
  f.namedItem("name").value = l.name || "";
  f.namedItem("breaks").value = l.breaks || "none";
  f.namedItem("from").innerHTML = app.state.languages.map((x) => `<option value="${esc(x)}">${esc(labelOf(x))} (${esc(x)})</option>`).join("");
  f.namedItem("from").value = l.from || "ja";
  $("#lang-dialog").showModal();
});
$("#lang-dialog").addEventListener("close", async () => {
  if ($("#lang-dialog").returnValue !== "ok") return;
  const f = $("#lang-form").elements;
  const after = { ...(app.language || {}), code: f.namedItem("code").value, name: f.namedItem("name").value, breaks: f.namedItem("breaks").value,
    from: f.namedItem("from").value };
  if (!after.name) delete after.name;
  const { status, body } = await api.post("/translator/api/language", { before: app.language, after });
  if (status === 200) { app.language = body.language; showLanguage(); if (/language\.json yet/.test($("#banner").textContent)) banner(null); if (app.scene !== null) openScene(app.scene); refreshHome(); }
  else banner(`language.json not saved: ${esc(body.error || status)}`, true);
});

// ---- search and replace ------------------------------------------------------------------------------------------------------------------
const search = { results: [], re: null };
// The side panels share one place: one at a time. Closing Search or Checks brings the preview back where it was on.
function sidePanel(id) {
  for (const d of ["checks", "search", "glossary", "exchange"]) $(`#${d}`).hidden = d !== id;
  $("#preview").classList.toggle("off", id !== "preview");
  keepRoom();
}
function closePanel(id) {
  if (id === "preview") $("#preview").classList.add("off");
  else $(`#${id}`).hidden = true;
  if (id !== "preview" && prefs.get("preview", true)) togglePreview(true);
}
function openSearch() {
  sidePanel("search");
  const sel = $("#o-in");
  const keep = sel.value;
  sel.innerHTML = `<option value="tl">the translation</option><option value="note">the notes</option>` + app.state.languages.map((l) => `<option value="ref:${esc(l)}">${esc(labelOf(l))}</option>`).join("");
  if (keep) sel.value = keep;
  $("#find").focus();
  $("#find").select();
}
$("#b-search").addEventListener("click", openSearch);
$("#search-close").addEventListener("click", () => closePanel("search"));
document.addEventListener("keydown", (e) => {
  if (MOD(e) && e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); openSearch(); }
  else if (MOD(e) && e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); togglePreview(); }
  else if (MOD(e) && e.key.toLowerCase() === "s") { e.preventDefault(); flush(); }
  else if (e.key === "Escape" && !$("#pop").hidden) $("#pop").hidden = true;
  else if (e.key === "Escape" && !$("#search").hidden) closePanel("search");
  else if (e.key === "Escape" && !$("#checks").hidden) closePanel("checks");
  else if (e.key === "Escape" && !$("#glossary").hidden) closePanel("glossary");
  else if (e.key === "Escape" && !$("#exchange").hidden) closePanel("exchange");
  else if (e.key === "Escape" && homeOn() && !document.querySelector("dialog[open]")) showHome(false);
});
for (const id of ["find", "repl"]) $(`#${id}`).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runSearch(); } });
$("#do-find").addEventListener("click", runSearch);
$("#do-replace").addEventListener("click", doReplace);
async function runSearch() {
  let re;
  try { re = compile($("#find").value, { regex: $("#o-regex").checked, caseSensitive: $("#o-case").checked, word: $("#o-word").checked }); }
  catch (e) { $("#search-sum").textContent = `Not a regular expression: ${e.message}`; return; }
  if (!re) return;
  const where = $("#o-in").value, status = $("#o-status").value, scope = $("#o-scope").value;
  const ref = where.startsWith("ref:") ? await textOf(where.slice(4)) : null;
  let scenes = app.map.scenes.map((_, s) => s).filter((s) => app.lines[s].length);
  if (scope === "scene") scenes = [app.scene];
  else if (scope === "route") scenes = scenes.filter((s) => app.map.scenes[s].route === app.map.scenes[app.scene].route);
  const out = [];
  const seen = new Set();
  for (const s of scenes) {
    for (const { id } of app.lines[s]) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (status && app.book.statusOf(id) !== status) continue;
      const row = app.book.rows.get(id);
      const text = where === "tl" ? row?.text : where === "note" ? row?.note : ref?.[id];
      if (!text) continue;
      const m = matchesIn(text, re);
      if (m.length) out.push({ s, id, text, m });
    }
  }
  search.results = out;
  search.re = re;
  drawResults();
}
function drawResults() {
  const where = $("#o-in").value;
  const repl = $("#repl").value;
  const canReplace = where === "tl" && !!app.folder;
  const MAX = 1500;
  let n = 0, html = "";
  for (const r of search.results) {
    if (n >= MAX) break;
    n++;
    const ok = r.m.some((x) => replaceIn(r.text, [x], "").done);
    let ctx = "";
    let at = 0;
    const read = readable(r.text);
    for (const x of r.m) {
      ctx += esc(read.slice(at, x.a)) + `<mark class="hit">${esc(read.slice(x.a, x.b))}</mark>`;
      at = x.b;
    }
    ctx += esc(read.slice(at));
    const after = canReplace ? replaceIn(r.text, r.m, repl) : null;
    html += `<div class="res" data-id="${r.id}" data-s="${r.s}"><input type="checkbox" ${canReplace && ok ? "checked" : "disabled"} title="${ok ? "replace in this line" : "the match crosses a mark or ruby: change it by hand"}">
      <span class="where">${esc(sceneName(r.s))} · #${r.id} · ${r.m.length} match${r.m.length > 1 ? "es" : ""}</span>
      <div class="ctx">${ctx}${after && after.done ? `<br><span class="new">→ ${esc(readable(after.text))}</span>` : ""}</div>
      ${after && after.left ? `<div class="no">${after.left} match${after.left > 1 ? "es cross" : " crosses"} a mark or ruby: not replaced</div>` : ""}</div>`;
  }
  const total = search.results.reduce((k, r) => k + r.m.length, 0);
  $("#results").innerHTML = html + (search.results.length > MAX ? `<div class="res-more">${search.results.length - MAX} more lines not shown: narrow the search</div>` : "");
  $("#search-sum").textContent = `${total} matches in ${search.results.length} lines`;
  $("#do-replace").disabled = !canReplace || !search.results.length;
}
$("#repl").addEventListener("input", () => { if (search.results.length) drawResults(); });
$("#results").addEventListener("click", (e) => {
  const w = e.target.closest(".where");
  if (!w) return;
  const res = w.closest(".res");
  goScene(Number(res.dataset.s), Number(res.dataset.id));
});
function doReplace() {
  const repl = $("#repl").value;
  const ticked = new Set($$("#results .res").filter((r) => $("input", r).checked).map((r) => Number(r.dataset.id)));
  let lines = 0, made = 0, left = 0;
  for (const r of search.results) {
    if (!ticked.has(r.id)) continue;
    const out = replaceIn(r.text, r.m, repl);
    left += out.left;
    if (!out.done) continue;
    change(r.id, { text: out.text }, r.s);   // (a line no file has yet goes in the scene it was found in)
    lines++;
    made += out.done;
    const el = lineEl(r.id);
    if (el) render($(".ed", el), out.text);
  }
  const said = `Replaced ${made} in ${lines} line${lines === 1 ? "" : "s"}${left ? `; ${left} crossing marks left` : ""}`;
  $("#search-sum").textContent = `${said}. Saving…`;
  search.results = [];
  $("#results").innerHTML = "";
  $("#do-replace").disabled = true;
  flush().then(() => { $("#search-sum").textContent = app.error ? `${said}, not saved: ${app.error}` : `${said}, saved.`; });
}

// ---- the page in the game's text box, and playing it (Stage 3) -------------------------------------------------------------------------
// The fit page (web-dev/fit, Stage 0) in a frame: the game's own VM, TextBox and styles, which lay a page out exactly as the game does. Its lines are
// the draft (/assets/draft/text.json: the folder laid over the English), and every change made here goes into them at once, saved or not. A page
// is measured as the game would show it in the translation: the rows it takes (12 fit the screen), each choice row's width, and in the corners
// whether every letter is on its balloon.
const pv = { win: null, ready: null, queue: Promise.resolve(), shown: null, widest: null, results: new Map() };
const ROWS = 12;
const previewOn = () => !$("#preview").classList.contains("off");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function gameLine(id, en) {
  const r = app.book.rows.get(id);
  return r && r.text && r.status !== "empty" ? r.text : en[id];
}
function loadPreview() {
  if (pv.ready) return pv.ready;
  const f = $("#fit-frame");
  pv.ready = (async () => {
    // (with no translation folder there is no draft: the English, as it reads)
    f.src = `/fit/?text=${app.folder ? "/assets/draft/text.json" : "/assets/text.json"}&lang=en&english=tsukihimates`;
    let w = null;
    for (let i = 0; i < 1200; i++) {
      await sleep(100);
      w = f.contentWindow;
      if (w?.fit?.ready) break;
      const o = w?.document?.getElementById("o")?.textContent || "";
      if (/error|Error/.test(o)) throw new Error(o);
    }
    if (!w?.fit?.ready) throw new Error("the fit page did not start");
    const en = await textOf("en");
    // the widest choice row in English, which a translation's should not pass
    const vm = w.fit.vm;
    const keep = vm.lines;
    vm.lines = en;
    const choicePages = [...new Set(app.map.lines.filter((l) => l.choice).flatMap((l) => l.at.map((a) => a.page)).filter((p) => p !== null))];
    let widest = 0;
    for (const p of choicePages) {
      await forget(w, p);
      const r = await w.fit.page(p);
      for (const c of r.choices || []) for (const row of c.rows) widest = Math.max(widest, row.width);
    }
    vm.lines = keep;
    pv.widest = widest;
    for (const id of app.dirty.keys()) vm.lines[id] = gameLine(id, en);
    for (const s of await Promise.all([...w.fit.vm.scripts.values()].map((p) => p.catch(() => null)))) if (s) delete s.wrap;
    pv.win = w;
    return w;
  })();
  pv.ready.catch((e) => { $("#pv-verdict").textContent = `The page cannot be shown: ${e.message}`; });
  return pv.ready;
}
// A script's rows are worked out once from its lines (reflow.js wrapContext): changed lines, worked out again.
async function forget(w, p) {
  const sc = await w.fit.vm.getScript(app.map.pages[p].s);
  delete sc.wrap;
}
function measure(p, keep = false) {
  const job = pv.queue.then(async () => {
    const w = await loadPreview();
    await forget(w, p);
    const r = await w.fit.page(p, keep);
    pv.results.set(p, r);
    return r;
  });
  pv.queue = job.catch(() => null);
  return job;
}
function verdict(r) {
  const bad = [], said = [`${r.rows} row${r.rows === 1 ? "" : "s"}${r.ways > 1 ? ` (the fullest of ${r.ways} ways through it)` : ""}`];
  if (r.rows > ROWS) bad.push(`runs off the screen: ${r.rows} rows, 12 fit`);
  for (const c of r.choices || []) {
    const w = Math.max(...c.rows.map((x) => x.width));
    said.push(`choice${c.rows.length > 1 ? "s" : ""} ${c.rows.map((x) => Math.round(x.width)).join(", ")} px wide`);
    if (pv.widest && w > pv.widest + 0.5) bad.push(`a choice ${Math.round(w)} px wide, wider than the widest English one (${Math.round(pv.widest)} px)`);
    if (c.room < 0) bad.push("the choices are pushed up over the text");
  }
  if (r.balloon && r.balloon.out > 0) bad.push(`${r.balloon.out} letter${r.balloon.out === 1 ? "" : "s"} off the balloon`);
  return { bad, said };
}
function pageChip(p, r) {
  const el = $(`.page[data-page="${p}"] .fitv`);
  if (!el) return;
  const v = verdict(r);
  el.textContent = v.bad.length ? `${r.rows} rows · ${v.bad.length > 1 ? `${v.bad.length} problems` : v.bad[0]}` : `${r.rows} rows`;
  el.className = `fitv${v.bad.length ? " bad" : ""}`;
  el.title = [...v.said, ...v.bad].join("\n");
}
async function showPage(p) {
  if (p === undefined || p === null) return;
  pv.shown = p;
  for (const el of $$(".page.shown")) el.classList.remove("shown");
  $(`.page[data-page="${p}"]`)?.classList.add("shown");
  try {
    const r = await measure(p, true);
    if (pv.shown !== p) return;
    pageChip(p, r);
    const v = verdict(r);
    const pg = app.map.pages[p];
    $("#pv-verdict").innerHTML = `<span>${esc(sceneName(pg.s))}, page ${pg.k + 1}: ${esc(v.said.join("; "))}</span>`
      + (v.bad.length ? v.bad.map((b) => `<span class="bad">${esc(b)}</span>`).join("") : `<span class="ok">fits</span>`);
    compareShow(p);
  } catch (e) {
    $("#pv-verdict").textContent = `The page cannot be shown: ${e.message}`;
  }
}
async function fitScene(s) {
  const pages = [...new Set(app.lines[s].map((x) => x.page).filter((p) => p !== null))];
  for (const p of pages) {
    if (app.scene !== s) return;
    try { pageChip(p, await measure(p, false)); } catch { return; }
  }
  if (pv.shown !== null && pages.includes(pv.shown)) showPage(pv.shown);
}
let lineTimer = 0;
async function previewLine(id) {
  const en = await textOf("en");
  pv.win.fit.vm.lines[id] = gameLine(id, en);
  clearTimeout(lineTimer);
  lineTimer = setTimeout(() => {
    const p = app.pageOf?.get(id);
    if (p === undefined || p === null) return;
    if (p === pv.shown) showPage(p);
    else measure(p).then((r) => pageChip(p, r)).catch(() => {});
  }, 150);
}
function fitFrame() {
  for (const [box, frame] of [["#pv-frame", "#fit-frame"], ["#pv-frame2", "#fit-frame2"]]) $(frame).style.transform = `scale(${$(box).clientWidth / 1920})`;
}
new ResizeObserver(fitFrame).observe($("#pv-frame"));
new ResizeObserver(fitFrame).observe($("#pv-frame2"));
function togglePreview(on = !previewOn()) {
  if (on) sidePanel("preview");
  else $("#preview").classList.add("off");
  prefs.set("preview", on);
  if (!on) return;
  fitFrame();
  loadPreview().then(() => {
    if (app.scene !== null) fitScene(app.scene);
    const line = document.activeElement?.closest?.(".line") || $(".line");
    if (line) showPage(app.pageOf.get(Number(line.dataset.id)));
  }).catch(() => {});
}
$("#b-preview").addEventListener("click", () => togglePreview());
$("#preview-close").addEventListener("click", () => togglePreview(false));
// The second text box: the same page in another language, laid out by its own fit page. English-family texts (Tsukihimates, Aniplex,
// Portuguese, any other layer) as the game sets them in English, on the same page; Japanese and Chinese in the original's way (html.ja, its
// face), on their own script's page that holds the same lines (241 scripts are their own: the line map's `ja.at` says where a line is there).
const cmp = { lang: null, win: null, ready: null, queue: Promise.resolve() };
function compareURL(lang) {
  const text = lang === "en" ? "/assets/text.json" : `/assets/${lang}/text.json`;
  const mode = lang === "ja" || lang === "zh" ? lang : "en";
  return `/fit/?text=${encodeURIComponent(text)}&lang=${mode}&english=${lang === "aniplex" ? "aniplex" : "tsukihimates"}`;
}
function compareChoices() {
  const sel = $("#cmp-lang");
  sel.innerHTML = `<option value="">(none)</option>` + app.state.languages.map((l) => `<option value="${esc(l)}">${esc(labelOf(l))}</option>`).join("");
  const want = prefs.get("compare", "en");
  sel.value = app.state.languages.includes(want) || want === "" ? want : "en";
}
function loadCompare(lang) {
  cmp.lang = lang;
  $("#pv-frame2").hidden = !lang;
  $("#cmp-note").textContent = "";
  if (!lang) { cmp.ready = null; cmp.win = null; $("#fit-frame2").src = "about:blank"; return null; }
  const f = $("#fit-frame2");
  const want = lang;
  cmp.win = null;
  cmp.ready = (async () => {
    f.src = compareURL(lang);
    let w = null;
    for (let i = 0; i < 1200; i++) {
      await sleep(100);
      if (cmp.lang !== want) throw new Error("another language chosen");
      w = f.contentWindow;
      if (w?.fit?.ready) break;
      const o = w?.document?.getElementById("o")?.textContent || "";
      if (/error|Error/.test(o)) throw new Error(o);
    }
    if (!w?.fit?.ready) throw new Error("the fit page did not start");
    cmp.win = w;
    fitFrame();
    return w;
  })();
  cmp.ready.catch((e) => { if (cmp.lang === want) $("#cmp-note").textContent = `cannot be shown: ${e.message}`; });
  return cmp.ready;
}
function compareShow(p) {
  if (!cmp.lang || p === undefined || p === null) return;
  const lang = cmp.lang;
  const job = cmp.queue.then(async () => {
    const w = await (cmp.ready || loadCompare(lang));
    if (cmp.lang !== lang) return;
    let r;
    if (lang === "ja" || lang === "zh") {
      const at = originalPage(p);
      if (!at) { $("#cmp-note").textContent = "not in the original"; return; }
      r = await w.fit.range(at.s, at.first, at.last, app.map.pages[p].w);
    } else {
      await forget(w, p);
      r = await w.fit.page(p, true);
    }
    if (cmp.lang === lang && pv.shown === p) $("#cmp-note").textContent = `${r.rows} row${r.rows === 1 ? "" : "s"}${r.rows > ROWS ? " (past 12)" : ""}`;
  });
  cmp.queue = job.catch(() => null);
}
// Where page p's lines are in the original's scripts (Japanese and Chinese play Japanese's commands): the script and the first and last command.
let idsOnPage = null;
function originalPage(p) {
  if (!idsOnPage) {
    idsOnPage = new Map();
    for (const ln of app.map.lines) for (const a of ln.at) if (a.page !== null && !a.dead) { if (!idsOnPage.has(a.page)) idsOnPage.set(a.page, []); idsOnPage.get(a.page).push([ln.id, a]); }
  }
  let s = null, first = Infinity, last = -1;
  for (const [id, a] of idsOnPage.get(p) || []) {
    const there = app.map.ja?.at?.[String(id)];
    const pos = there ? there[0] : a;   // (a line not listed is where the English has it)
    if (!pos) continue;
    if (s === null) s = pos.s;
    if (pos.s !== s) continue;
    first = Math.min(first, pos.pc);
    last = Math.max(last, pos.pc);
  }
  return s === null ? null : { s, first, last };
}
$("#cmp-lang").addEventListener("change", (e) => {
  prefs.set("compare", e.target.value);
  loadCompare(e.target.value);
  compareShow(pv.shown);
});

// Play from here: the game in another tab, from the page's first command, in the translation as saved (/assets/draft/, dev_server.py).
async function playFrom(p) {
  if (!app.state.play) {
    banner(app.folder ? "Playing the draft needs an app from 17 November 2026 or later (its js/languages.js): open the app once so that it takes its update, or fetch the game into a web/ folder." : "Playing the draft needs a translations folder (--translations).", true);
    return;
  }
  await flush();
  const pg = app.map.pages[p];
  window.open(`/?script=${encodeURIComponent(sceneName(pg.s))}&pc=${pg.a}&lang=draft`, "tsukihime-play");
}
$("#b-play").addEventListener("click", () => {
  const line = document.activeElement?.closest?.(".line") || $(".line.focus");
  const p = line ? app.pageOf.get(Number(line.dataset.id)) : pv.shown;
  if (p !== undefined && p !== null) playFrom(p);
});

// ---- checks (Stage 4) ----------------------------------------------------------------------------------------------------------------------
// The server runs build_layer.py's checks: on every line saved (by itself), and on the whole folder when asked (as a build does). A finding is
// {level: error | warning | note, kind, what, id}; errors stop a build. The page-fit checks run here, in the preview's frame (every page that has
// a translated line), as the fit runner runs them before a build.
const FOLDER_KINDS = new Set(["quote shape", "page partly translated", "translated two ways", "never shown"]);
const FIT_KINDS = new Set(["page past 12 rows", "choice wider than the English's widest", "choices over the text", "letters off a balloon"]);
const LEVEL_RANK = { error: 0, warning: 1, note: 2 };
app.checks = [];      // every finding, [{level, kind, what, id, file, page}]
app.byLine = new Map();
function indexChecks() {
  app.byLine = new Map();
  for (const f of app.checks) if (f.id !== null && f.id !== undefined) { if (!app.byLine.has(f.id)) app.byLine.set(f.id, []); app.byLine.get(f.id).push(f); }
  const n = app.checks.filter((f) => f.level !== "note").length, errors = app.checks.filter((f) => f.level === "error").length;
  const b = $("#b-checks");
  b.textContent = n ? `Checks (${n})` : "Checks";
  b.classList.toggle("bad", errors > 0);
  b.title = `${errors} errors, ${n - errors} warnings, ${app.checks.length - n} notes. Errors stop a build.`;
}
const shownChecks = (id) => (app.byLine.get(id) || []).filter((f) => f.level !== "note" || $("#ck-notes").checked);
function ckBadge(id) {
  const fs = shownChecks(id);
  if (!fs.length) return "";
  const worst = fs.reduce((a, f) => (LEVEL_RANK[f.level] < LEVEL_RANK[a] ? f.level : a), "note");
  return `<span class="badge ck ${worst}" title="${esc(fs.map((f) => `${f.kind}: ${f.what}`).join("\n"))}">${worst === "error" ? "✖" : worst === "warning" ? "⚠" : "·"} ${fs.length}</span>`;
}
function ckList(id) {
  return shownChecks(id).map((f) => `<span class="${f.level}">${esc(f.kind)}: ${esc(f.what)}</span>`).join("");
}
function redrawChecks(ids) {
  for (const id of ids) {
    const el = lineEl(id);
    if (!el) continue;
    $(".ck-slot", el).innerHTML = ckBadge(id);
    $(".line-ck", el).innerHTML = ckList(id);
  }
}
// "QA_01.json id 42768: the same as ..." -> "the same as ..."
const bare = (what, id) => what.replace(new RegExp(`^[^:]*? id ${id}: `), "");
async function loadChecks() {
  $("#ck-sum").textContent = "checking…";
  try {
    const r = await api.get("/translator/api/check");
    const fit = app.checks.filter((f) => FIT_KINDS.has(f.kind));
    app.checks = [...r.findings.map((f) => ({ ...f, what: f.id !== null ? bare(f.what, f.id) : f.what })), ...fit];
    app.untranslated = r.untranslated;
  } catch (e) {
    $("#ck-sum").textContent = `not checked: ${e.message}`;
    return;
  }
  indexChecks();
  drawChecks();
  if (app.scene !== null) redrawChecks(app.lines[app.scene].map((x) => x.id));
}
// A save's answer: each saved line's own checks again (the folder's stay until the next full check).
function takeLineFindings(found) {
  const ids = Object.keys(found).map(Number);
  const keep = app.checks.filter((f) => !ids.includes(f.id) || FOLDER_KINDS.has(f.kind) || FIT_KINDS.has(f.kind));
  for (const id of ids) for (const [level, kind, what] of found[id]) keep.push({ level, kind, what, id, file: `${app.book.owner.get(id) || ""}.json` });
  app.checks = keep;
  indexChecks();
  redrawChecks(ids);
  if (!$("#checks").hidden) drawChecks();
}
function drawChecks() {
  const notes = $("#ck-notes").checked;
  const kinds = new Map();
  for (const f of app.checks) {
    if (f.level === "note" && !notes) continue;
    const k = `${f.level}|${f.kind}`;
    if (!kinds.has(k)) kinds.set(k, []);
    kinds.get(k).push(f);
  }
  const order = [...kinds.entries()].sort((a, b) => LEVEL_RANK[a[1][0].level] - LEVEL_RANK[b[1][0].level] || b[1].length - a[1].length);
  const MAX = 400;
  $("#ck-list").innerHTML = order.map(([, fs]) => `<details class="ck-kind"${order.length === 1 ? " open" : ""}><summary><span class="lv ${fs[0].level}">${fs[0].level}</span>${esc(fs[0].kind)}<span class="n">${fs.length}</span></summary>`
    + fs.slice(0, MAX).map((f) => `<div class="ck-item" data-id="${f.id ?? ""}" data-file="${esc(f.file || "")}"><span class="at">${f.id !== null && f.id !== undefined ? `#${f.id}` : ""} ${esc((f.file || "").replace(/\.json$/, ""))}</span> ${esc(f.what)}</div>`).join("")
    + (fs.length > MAX ? `<div class="res-more">${fs.length - MAX} more</div>` : "") + "</details>").join("") || `<div class="res-more">Nothing found.</div>`;
  const u = app.untranslated;
  const c = { error: 0, warning: 0, note: 0 };
  for (const f of app.checks) c[f.level]++;
  const many = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
  $("#ck-sum").textContent = `${many(c.error, "error")}, ${many(c.warning, "warning")}, ${many(c.note, "note")}${u ? `; ${many(u.lines, "line")} not translated` : ""}`;
}
$("#b-checks").addEventListener("click", () => { if ($("#checks").hidden) { sidePanel("checks"); drawChecks(); } else closePanel("checks"); });
$("#checks-close").addEventListener("click", () => closePanel("checks"));
$("#ck-again").addEventListener("click", loadChecks);
$("#ck-notes").addEventListener("change", () => { drawChecks(); if (app.scene !== null) redrawChecks(app.lines[app.scene].map((x) => x.id)); });
$("#ck-list").addEventListener("click", (e) => {
  const it = e.target.closest(".ck-item");
  if (!it || it.dataset.id === "") return;
  const id = Number(it.dataset.id);
  const file = it.dataset.file.replace(/\.json$/, "");
  const s = sceneIndex.has(file) && app.lines[sceneIndex.get(file)].some((x) => x.id === id) ? sceneIndex.get(file) : app.map.lines[id]?.at.find((a) => !a.dead)?.s;
  if (s !== undefined) goScene(s, id);
});
// Every page with a translated line, laid out in the preview's frame: what the fit runner finds before a build.
$("#ck-fit").addEventListener("click", async () => {
  const b = $("#ck-fit");
  b.disabled = true;
  try {
    await loadPreview();
    const pages = new Set();
    for (const [id] of app.book.rows) if (app.book.statusOf(id) !== "empty") for (const a of app.map.lines[id]?.at || []) if (a.page !== null && !a.dead) pages.add(a.page);
    const list = [...pages].sort((x, y) => x - y);
    const found = [];
    let n = 0;
    for (const p of list) {
      const r = await measure(p);
      const pg = app.map.pages[p];
      const first = app.lines[pg.s]?.find((x) => x.page === p)?.id ?? null;
      const at = { id: first, file: `${app.book.owner.get(first) || sceneName(pg.s)}.json`, page: p };
      const where = `${sceneName(pg.s)} page ${pg.k + 1}`;
      if (r.rows > ROWS) found.push({ level: "warning", kind: "page past 12 rows", what: `${where}: ${r.rows} rows; 12 fit the screen`, ...at });
      for (const c of r.choices || []) {
        const w = Math.max(...c.rows.map((x) => x.width));
        if (pv.widest && w > pv.widest + 0.5) found.push({ level: "warning", kind: "choice wider than the English's widest", what: `${where}: ${Math.round(w)} px; the English's widest is ${Math.round(pv.widest)} px`, ...at, id: c.ids[0] ?? first });
        if (c.room < 0) found.push({ level: "warning", kind: "choices over the text", what: `${where}: the choices are pushed up over the text`, ...at });
      }
      if (r.balloon && r.balloon.out > 0) found.push({ level: "warning", kind: "letters off a balloon", what: `${where}: ${r.balloon.out} letter boxes off the balloon`, ...at });
      if (++n % 50 === 0) $("#ck-sum").textContent = `laying pages out: ${n} of ${list.length}`;
    }
    app.checks = [...app.checks.filter((f) => !FIT_KINDS.has(f.kind)), ...found];
    indexChecks();
    drawChecks();
    if (app.scene !== null) { redrawChecks(app.lines[app.scene].map((x) => x.id)); fitScene(app.scene); }
    $("#ck-sum").textContent += ` (${list.length} pages laid out)`;
  } catch (e) {
    $("#ck-sum").textContent = `pages not laid out: ${e.message}`;
  } finally { b.disabled = false; }
});

// ---- glossary and memory (Stage 5) ----------------------------------------------------------------------------------------------------------
// The glossary (glossary.json): its terms are marked in the columns (their translation on hover) and listed under the line you are on, a click
// putting the translation at the caret; build_layer.py's checks warn where a line has a term and not its translation. Translation memory
// (memory.js): under the line you are on, the lines with the same source already translated, those close to it, and the lines with the same
// source not translated yet, which one click fills with this line's translation.
app.glossary = null;
const terms = () => app.glossary?.terms || [];
const hints = { line: null, timer: 0 };
let memory = null, memoryFrom = null;
async function memoryOf() {
  const from = app.language?.from || "ja";
  if (!memory || memoryFrom !== from) {
    const src = await textOf(from);
    if (!src) return null;
    memory = new Memory(src, app.map.lines.filter((l) => l.at.length).map((l) => l.id));
    memoryFrom = from;
  }
  return memory;
}
const firstScene = (id) => app.map.lines[id]?.at.find((a) => !a.dead)?.s ?? app.map.lines[id]?.at[0]?.s;
function sourcesLoaded() {
  const out = {};
  for (const [lang, t] of app.texts) if (Array.isArray(t)) out[lang] = t;
  return out;
}
// The glossary's forms marked in the columns of the lines in `root` (text nodes only: a form split by a mark is not marked).
function markTerms(root) {
  const list = terms();
  if (!list.length) return;
  for (const ref of $$(".ref[lang]", root)) {
    const lang = ref.getAttribute("lang");
    const pats = list.flatMap((t) => formsOf(t).filter(([l]) => l === lang).map(([, f]) => [formPattern(lang, f), t]));
    if (!pats.length) continue;
    const walker = document.createTreeWalker(ref, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest(".chip, .use, mark") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const hits = [];
      for (const [re, t] of pats) for (const m of node.data.matchAll(re)) hits.push([m.index, m.index + m[0].length, t]);
      hits.sort((x, y) => x[0] - y[0]);
      let cur = node, at = 0;
      for (const [a, b, t] of hits) {
        if (a < at) continue;
        const mid = cur.splitText(a - at);
        const after = mid.splitText(b - a);
        const mk = document.createElement("mark");
        mk.className = "gl";
        mk.title = `→ ${t.target}${t.also?.length ? ` (or ${t.also.join(", ")})` : ""}${t.note ? `\n${t.note}` : ""}`;
        mid.replaceWith(mk);
        mk.append(mid);
        cur = after;
        at = b;
      }
    }
  }
}
async function drawHints(line) {
  hints.line = line;
  const box = $(".hints", line);
  if (!box) return;
  const id = Number(line.dataset.id);
  const rows = [];
  // the glossary's terms in this line's sources
  const srcs = sourcesLoaded();
  for (const l of new Set(terms().flatMap((t) => formsOf(t).map(([lang]) => lang)))) if (!srcs[l]) { const t = await textOf(l); if (t) srcs[l] = t; }
  const found = termsIn(terms(), srcs, id);
  const text = app.book.rows.get(id)?.text || "";
  const fromName = labelOf(app.language?.from || "ja");
  if (found.length) {
    rows.push(`<div class="hint-row"><span class="what" data-tip="Terms of the Glossary found in this line's source, with their agreed translation. Click one to put it at the caret; one in orange is not in your line yet.">Glossary</span>${found.map(({ term, form }, k) => `<span class="term-chip${text && !hasTarget(term, text) ? " missing" : ""}" data-term="${terms().indexOf(term)}" title="${esc(term.note || "")} Click: put it at the caret.">${esc(form)} → ${esc(term.target)}</span>`).join("")}</div>`);
  }
  // memory
  const mem = await memoryOf();
  if (mem && hints.line === line) {
    const same = mem.same(id);
    const done = same.filter((x) => app.book.statusOf(x) !== "empty");
    const open = same.filter((x) => app.book.statusOf(x) === "empty");
    const ways = new Map();
    for (const x of done) { const t = app.book.rows.get(x).text; if (!ways.has(t)) ways.set(t, x); }
    for (const [t, x] of [...ways].slice(0, 3)) {
      if (t === text) continue;
      rows.push(`<div class="hint-row"><span class="what" data-tip="${esc(`Translation memory: line #${x} has exactly the same ${fromName} line as this one, and is translated like this. "use" puts it in your box.`)}">Same</span><span class="tm">${toHTML(t)}</span><span class="num">#${x}</span><button type="button" data-use="${x}" title="Put this translation in the edit box">use</button></div>`);
    }
    if (open.length && text) rows.push(`<div class="hint-row"><span class="what" data-tip="${esc(`These lines have exactly the same ${fromName} line as this one and are not translated yet. "fill" gives them your translation, as drafts.`)}">Same</span><span>${open.length} more line${open.length > 1 ? "s have" : " has"} this source, not translated yet</span><button type="button" data-fill="${open.join(",")}" title="Give them this line's translation (as drafts)">fill ${open.length > 1 ? "them" : "it"}</button></div>`);
    for (const { id: x, score } of mem.like(id, (o) => app.book.statusOf(o) !== "empty", { max: 3 })) {
      const t = app.book.rows.get(x).text;
      if (t === text) continue;
      const pc = Math.round(score * 100);
      rows.push(`<div class="hint-row"><span class="what" data-tip="${esc(`Translation memory: line #${x}'s ${fromName} line is ${pc}% like this one's (by their words), and it is already translated like this. The number is how alike the two source lines are, not the translations. "use" puts it in your box, to change.`)}">${pc}% like</span><span class="tm" data-tip="${esc(`Its ${fromName} line: ${wordsOf(mem.source[x])}`)}">${toHTML(t)}</span><span class="num">#${x}</span><button type="button" data-use="${x}" title="Put this translation in the edit box">use</button></div>`);
    }
  }
  if (hints.line === line) box.innerHTML = rows.join("");
}
lines.addEventListener("click", (e) => {
  const line = e.target.closest(".line");
  if (!line || !app.folder) return;
  const ed = $(".ed", line);
  const id = Number(line.dataset.id);
  const chip = e.target.closest(".term-chip");
  if (chip) { insertRaw(ed, terms()[Number(chip.dataset.term)].target, hints.caret?.id === id ? hints.caret.at : caret(ed)); ed.focus(); return; }
  const use = e.target.closest("button[data-use]");
  if (use) {
    const t = app.book.rows.get(Number(use.dataset.use))?.text || "";
    if (serialize(ed) && !confirm("Put this translation in the edit box in place of what it has?")) return;
    render(ed, t);
    remember(ed, t, t.length, t.length);
    changed(ed, t);
    return;
  }
  const fill = e.target.closest("button[data-fill]");
  if (fill) {
    const t = serialize(ed);
    const ids = fill.dataset.fill.split(",").map(Number);
    for (const x of ids) if (app.book.statusOf(x) === "empty") change(x, { text: t }, firstScene(x));
    for (const x of ids) redrawLine(x);
    drawHints(line);
  }
});
// (the caret the edit box had, for a term put in from the hints)
lines.addEventListener("focusout", (e) => { const ed = e.target.closest?.(".ed"); if (ed) hints.caret = { id: Number(ed.closest(".line").dataset.id), at: caret(ed) }; });
lines.addEventListener("mousedown", (e) => { if (e.target.closest(".term-chip, .hints button")) e.preventDefault(); });

// The glossary panel: every term, edited in place, saved whole.
let glossDraft = null;
function drawGlossary() {
  const list = glossDraft || terms().map((t) => ({ ...t }));
  glossDraft = list;
  const q = $("#gl-filter").value.trim().toLowerCase();
  const langs = [...new Set(["ja", "en", ...list.flatMap((t) => formsOf(t).map(([l]) => l))])];
  $("#gl-list").innerHTML = list.map((t, k) => {
    if (q && !JSON.stringify(t).toLowerCase().includes(q)) return "";
    return `<div class="gl-term" data-k="${k}">${langs.map((l) => `<input data-f="${esc(l)}" value="${esc(t[l] || "")}" placeholder="${esc(labelOf(l))}" title="${esc(labelOf(l))} (${esc(l)})">`).join("")}<button type="button" class="x" data-del="${k}" title="Remove this term">×</button>
      <input data-f="target" value="${esc(t.target || "")}" placeholder="the translation" class="wide"><input data-f="also" value="${esc((t.also || []).join(", "))}" placeholder="other forms, comma between" class="wide"><input data-f="note" value="${esc(t.note || "")}" placeholder="note" class="wide"></div>`;
  }).join("") || `<div class="res-more">No terms yet.</div>`;
  $("#gl-sum").textContent = `${list.length} term${list.length === 1 ? "" : "s"}`;
}
$("#b-glossary").addEventListener("click", () => { if ($("#glossary").hidden) { sidePanel("glossary"); drawGlossary(); } else closePanel("glossary"); });
$("#glossary-close").addEventListener("click", () => closePanel("glossary"));
$("#gl-filter").addEventListener("input", drawGlossary);
$("#gl-add").addEventListener("click", () => { glossDraft = [{ ja: "", en: "", target: "" }, ...(glossDraft || terms().map((t) => ({ ...t })))]; $("#gl-filter").value = ""; drawGlossary(); $("#gl-save").disabled = false; $("#gl-list input").focus(); });
$("#gl-list").addEventListener("input", (e) => {
  const row = e.target.closest(".gl-term");
  if (!row) return;
  const t = glossDraft[Number(row.dataset.k)];
  const f = e.target.dataset.f, v = e.target.value;
  if (f === "also") { const a = v.split(",").map((x) => x.trim()).filter(Boolean); if (a.length) t.also = a; else delete t.also; }
  else if (v || f === "target") t[f] = v; else delete t[f];
  row.classList.add("dirty");
  $("#gl-save").disabled = false;
});
$("#gl-list").addEventListener("click", (e) => {
  const del = e.target.closest("button[data-del]");
  if (!del) return;
  glossDraft.splice(Number(del.dataset.del), 1);
  drawGlossary();
  $("#gl-save").disabled = false;
});
$("#gl-save").addEventListener("click", async () => {
  // (a form left empty is no form: only the translation is kept even when empty, and a term with no form or no translation is not kept)
  const clean = (t) => Object.fromEntries(Object.entries(t).filter(([k, v]) => k === "target" || !(typeof v === "string" && !v.trim())));
  const after = { ...(app.glossary || {}), terms: glossDraft.map(clean).filter((t) => t.target && formsOf(t).length) };
  const { status, body } = await api.post("/translator/api/glossary", { before: app.glossary, after });
  if (status !== 200) { banner(`glossary.json not saved: ${esc(body.error || status)}`, true); return; }
  app.glossary = body.glossary;
  glossDraft = null;
  $("#gl-save").disabled = true;
  drawGlossary();
  if (app.scene !== null) openScene(app.scene);
  loadChecks();
});

// ---- exchange (Stage 6) -----------------------------------------------------------------------------------------------------------------
// web-dev/tools/exchange.py through the server: the folder as a download, and a file of another tool's laid back on its lines (checked first).
$("#b-exchange").addEventListener("click", () => { if ($("#exchange").hidden) sidePanel("exchange"); else closePanel("exchange"); });
$("#exchange-close").addEventListener("click", () => closePanel("exchange"));
$("#ex-go").addEventListener("click", async () => {
  await flush();
  const q = new URLSearchParams({ format: $("#ex-format").value });
  const scope = $("#ex-scope").value;
  const esc_ = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (scope === "scene" && app.scene !== null) q.set("scenes", `^${esc_(sceneName(app.scene))}$`);
  if (scope === "route" && app.scene !== null) {
    const r = app.map.scenes[app.scene].route;
    q.set("scenes", `^(${app.map.scenes.filter((x) => x.route === r).map((x) => esc_(x.name)).join("|")})$`);
  }
  if ($("#ex-all").checked) q.set("all", "1");
  const a = document.createElement("a");
  a.href = `/translator/api/export?${q}`;
  a.download = "";
  document.body.append(a);
  a.click();
  a.remove();
});
let imText = null;
$("#im-file").addEventListener("change", async () => {
  const f = $("#im-file").files[0];
  imText = f ? await f.text() : null;
  if (f && !$("#im-format").value) {
    const ext = f.name.split(".").pop().toLowerCase();
    $("#im-format").dataset.guess = { csv: "csv", po: "po", xliff: "xliff", xlf: "xliff", txt: "deepluna" }[ext] || "";
  }
  $("#im-check").disabled = !imText;
  $("#im-go").disabled = true;
  $("#im-report").innerHTML = "";
});
async function importFile(dry) {
  const format = $("#im-format").value || $("#im-format").dataset.guess;
  if (!format) { $("#im-report").textContent = "Which format is it? Choose it above."; return; }
  if (!dry) await flush();
  $("#im-report").textContent = dry ? "checking…" : "importing…";
  const { status, body } = await api.post("/translator/api/import", { format, data: imText, dry, overwrite: $("#im-overwrite").checked, status: $("#im-status").value });
  if (status !== 200) { $("#im-report").innerHTML = `<span class="u">${esc(body.error || String(status))}</span>`; return; }
  const list = (k, cls) => body[k].slice(0, 200).map(([where, why]) => `<span class="${cls}">${esc(where)}: ${esc(why)}</span>`).join("");
  $("#im-report").innerHTML = `<strong>${dry ? "Would place" : "Placed"} ${body.placed} lines in ${body.files.length} scene files</strong>`
    + `<span>${body.same} were so already; ${body.kept.length} kept as they were; ${body.unplaced.length} not placed</span>`
    + list("kept", "k") + list("unplaced", "u") + body.notes.slice(0, 50).map((n) => `<span>${esc(n)}</span>`).join("");
  $("#im-go").disabled = !dry || !body.placed;
  if (!dry && body.placed) {
    $("#im-report").innerHTML += "<span>Loading the folder again…</span>";
    setTimeout(() => location.reload(), 1200);
  }
}
$("#im-check").addEventListener("click", () => importFile(true));
$("#im-go").addEventListener("click", () => importFile(false));

// ---- resizing ----------------------------------------------------------------------------------------------------------------------------
// The scene list and each side panel have a handle on their inner edge, the line columns one between each two in the header. Dragged, they
// change the width; double-clicked, they go back to the usual one. Widths are remembered (this browser's storage, for this tool only).
// onMove(null) gives what the drag starts from; onMove(dx, start) follows the pointer.
const LINES_MIN = 640;
function drag(handle, onMove, onEnd) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("on");
    document.body.classList.add("resizing");
    const x0 = e.clientX;
    const start = onMove(null);
    const move = (ev) => onMove(ev.clientX - x0, start);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      handle.classList.remove("on");
      document.body.classList.remove("resizing");
      onEnd?.();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}
for (const handle of $$(".split[data-for]")) {
  const id = handle.dataset.for;
  const el = $(`#${id}`);
  const side = id === "side";   // (the scene list grows to the right, a side panel to the left)
  const key = `width.${id}`;
  // (the lines keep at least LINES_MIN px whatever the panels around them take)
  const room = () => innerWidth - LINES_MIN - (side ? ($(".drawer:not([hidden]):not(.off)")?.offsetWidth || 0) : $("#side").offsetWidth);
  const set = (w) => { el.style.width = `${Math.round(Math.max(180, Math.min(room(), w)))}px`; };
  const saved = prefs.get(key, null);
  if (saved) set(saved);
  drag(handle, (dx, w0) => {
    if (dx === null) return el.getBoundingClientRect().width;
    set(w0 + (side ? dx : -dx));
    if (id === "preview") fitFrame();
  }, () => prefs.set(key, Math.round(el.getBoundingClientRect().width)));
  handle.addEventListener("dblclick", () => { el.style.width = ""; prefs.set(key, null); if (id === "preview") fitFrame(); });
}
// The columns: the handle after weighted column k (a reference column) moves width between it and column k + 1. The header is drawn again
// with every scene, so its handles are reached through the head.
let colDrag = null;
$("#scene-head").addEventListener("pointerdown", (e) => {
  const h = e.target.closest(".split-c");
  if (!h || e.button !== 0) return;
  e.preventDefault();
  h.setPointerCapture(e.pointerId);
  h.classList.add("on");
  document.body.classList.add("resizing");
  const k = Number(h.dataset.k);
  const spans = $$("#scene-head .cols > span").slice(1, -1);
  colDrag = { h, k, x0: e.clientX, w: weights(), a: spans[k].getBoundingClientRect().width, b: spans[k + 1].getBoundingClientRect().width };
});
$("#scene-head").addEventListener("pointermove", (e) => {
  if (!colDrag) return;
  const { k, x0, w, a, b } = colDrag;
  const lo = Math.min(80, (a + b) * 0.2);   // (neither column narrower than this)
  const na = Math.max(lo, Math.min(a + b - lo, a + e.clientX - x0));
  const pair = w[k] + w[k + 1];
  const next = [...w];
  next[k] = (pair * na) / (a + b);
  next[k + 1] = pair - next[k];
  colDrag.next = next;
  applyCols(next);
});
const colDone = () => {
  if (!colDrag) return;
  colDrag.h.classList.remove("on");
  document.body.classList.remove("resizing");
  if (colDrag.next) prefs.set(colKey(), colDrag.next);
  colDrag = null;
};
$("#scene-head").addEventListener("pointerup", colDone);
$("#scene-head").addEventListener("pointercancel", colDone);
$("#scene-head").addEventListener("dblclick", (e) => {
  if (!e.target.closest(".split-c")) return;
  prefs.set(colKey(), null);
  applyCols();
});
// a window made narrower keeps the lines readable: panels wider than it allows come in
function keepRoom() {
  const panel = $(".drawer:not([hidden]):not(.off)");
  const over = $("#side").offsetWidth + (panel?.offsetWidth || 0) + LINES_MIN - innerWidth;
  if (over <= 0) return;
  // the side panel gives first, then the scene list, neither below 180 px
  for (const el of [panel, $("#side")].filter(Boolean)) {
    const w = el.getBoundingClientRect().width;
    const take = Math.min(over, Math.max(0, w - 180));
    if (take > 0) { el.style.width = `${Math.round(w - take)}px`; return keepRoom(); }
  }
}
addEventListener("resize", () => { keepRoom(); fitFrame(); });

// ---- what a mark is: the tooltip -----------------------------------------------------------------------------------------------------------
// Every mark carries its explanation (markup.js markTip): resting the pointer on it shows it here at once, beside the mark, in the page's own
// colours (the browser's title tooltips come late and small).
const tip = document.createElement("div");
tip.id = "tip";
tip.setAttribute("role", "tooltip");
tip.hidden = true;
document.body.append(tip);
let tipFor = null;
document.addEventListener("pointerover", (e) => {
  const el = e.target.closest?.("[data-tip]");
  if (!el || el === tipFor) return;
  tipFor = el;
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const w = Math.min(420, innerWidth - 16);
  tip.style.maxWidth = `${w}px`;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = `${Math.max(8, Math.min(innerWidth - tw - 8, r.left))}px`;
  tip.style.top = `${r.bottom + 6 + th > innerHeight ? r.top - th - 6 : r.bottom + 6}px`;
});
document.addEventListener("pointerout", (e) => {
  if (!tipFor || (e.relatedTarget && tipFor.contains(e.relatedTarget))) return;
  if (e.target.closest?.("[data-tip]") !== tipFor) return;
  tipFor = null;
  tip.hidden = true;
});
addEventListener("scroll", () => { tipFor = null; tip.hidden = true; }, true);

// ---- help --------------------------------------------------------------------------------------------------------------------------------
// What the editor is and how it works, for someone new to it: the translation's progress, where they left off, five steps to a first line,
// the window, the buttons (their own titles), the keys and the marks (markup.js's tips, so the page says what the editor does). Shown in the
// main area by "Help" in the bar, never by itself: the editor opens on the scene and line last worked on (user, 2026-11-17).
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const KEY = IS_MAC ? "⌘" : "Ctrl", ALT = IS_MAC ? "⌥" : "Alt";
// (an invented line, as the edit box shows one: no game text in the tool)
const SAMPLE = `"Is anyone there?"^I waited, but ${italic("nobody")} answered.@k`;
const SAMPLE_MARKS = ["@k", "@g", "@x", "@t", "@e", "@n", "@c1", "[ber00]", "[zap00]", "^", "\n", rubyOf("star", "hoshi")];
const homeOn = () => !$("#home").hidden;
function tipOfRaw(raw) {
  const d = document.createElement("div");
  d.innerHTML = toHTML(raw);
  return d.querySelector("[data-tip]")?.dataset.tip || "";
}
function lastPlace() {
  const l = prefs.get("last", null);
  return l && sceneIndex.has(l.scene) ? { s: sceneIndex.get(l.scene), id: Number.isInteger(l.id) ? l.id : null } : null;
}
// The first line not translated, in the order of the scene list.
function nextEmpty() {
  for (const r of app.tree) for (const g of r.groups) for (const s of g.scenes) {
    for (const x of app.lines[s]) if (!x.dead && app.map.lines[x.id].at.length && app.book.statusOf(x.id) === "empty") return { s, id: x.id };
  }
  return null;
}
function homeHTML() {
  const ids = app.map.lines.filter((l) => l.at.length).map((l) => l.id);
  const c = counts(ids, app.book);
  const pct = Math.floor((100 * done(c)) / (c.total || 1));
  const l = app.language;
  const last = lastPlace();
  const next = app.folder ? nextEmpty() : null;
  const n = (v) => v.toLocaleString();
  const status = app.folder
    ? `<div class="hs-name"><strong>${esc(l?.name || l?.code || "A new translation")}</strong>${l?.code ? `<span class="num">${esc(l.code)}</span>` : ""}`
      + `${l ? `<span class="soft">translated from ${esc(labelOf(l.from || "ja"))}</span>` : ""}</div>`
      + `<div class="hs-folder" title="Everything you write is saved in this folder">${esc(app.folder)}</div>`
      + `<div class="hs-bar">${barHTML(c, true)}<span>${n(done(c))} of ${n(c.total)} lines translated (${pct}%)</span>`
      + `<span class="soft">${n(c.final)} final · ${n(c.reviewed)} reviewed · ${n(c.draft)} draft</span></div>`
    : `<div class="hs-name"><strong>Reading only</strong></div><p class="soft">No translation folder was given (the tool's server was started without
      <code>--translations</code>), so every line can be read and laid out, but nothing can be written.</p>`;
  const go = [];
  if (last) go.push(`<button type="button" class="primary" data-home="last">Continue: ${esc(sceneName(last.s))}${last.id !== null ? `, line #${last.id}` : ""}</button>`);
  if (next && !(last && last.s === next.s && last.id === next.id)) go.push(`<button type="button"${last ? "" : ' class="primary"'} data-home="next">${done(c) ? "The next line not translated" : "Start with the first line"} (${esc(sceneName(next.s))})</button>`);
  if (!go.length) go.push(`<button type="button" class="primary" data-home="close">Go to the scenes</button>`);
  const show = (what, label = "Show me") => `<button type="button" class="show" data-show="${what}">${label}</button>`;
  const langStep = !app.folder ? `<p class="soft">(Needs a translation folder.)</p>`
    : l?.code ? `<p class="ok">✓ ${esc(l.name || l.code)} (${esc(l.code)}), translated from ${esc(labelOf(l.from || "ja"))}. <button type="button" data-click="b-language">Change</button></p>`
    : `<p><button type="button" class="primary" data-click="b-language">Set the language</button></p>`;
  const play = app.state.play ? "" : ` <span class="soft">(${app.folder ? "This needs a newer app." : "This needs a translation folder."})</span>`;
  // (the desktop game carries no Japanese until it is chosen once on its LANGUAGE tab, which downloads it)
  const hasJa = app.state.languages.includes("ja");
  const beside = hasJa ? "the Japanese and the Tsukihimates English" : "the Tsukihimates English";
  const noJa = hasJa ? "" : `<p class="soft">The Japanese is not here yet: the game downloads it the first time 日本語 is chosen on its LANGUAGE tab.
    Do that once in the game, then open the translator again, and the Japanese column is there.</p>`;
  const bar = ["b-preview", "b-glossary", "b-checks", "b-search", "b-columns", "b-exchange", "b-language"].map((id) => {
    const b = $(`#${id}`);
    return b ? `<div class="kv"><span><button type="button" data-click="${id}">${esc(b.textContent)}</button></span><span>${esc(b.title)}</span></div>` : "";
  }).join("");
  const keys = [
    ["Enter", "the next line (in a line's box)"],
    [`${ALT}+↓  ${ALT}+↑`, "the next line, the line before"],
    ["Shift+Enter", "a row break of your own (^): the text goes on at the start of the next row"],
    [`${KEY}+I`, "italics on the chosen letters, or off again"],
    [`${KEY}+Z  ${KEY}+Y`, `undo and redo in the line (${KEY}+Shift+Z redoes too)`],
    [`${KEY}+C  ${KEY}+V`, "copy and paste: between lines, the marks come along"],
    [`${KEY}+S`, "save now (lines save by themselves a moment after a change)"],
    [`${KEY}+Shift+F`, "search and replace in the whole translation"],
    [`${KEY}+Shift+P`, "the preview on or off"],
    ["Esc", "close the panel or the search; then this page"],
  ].map(([k, w]) => `<div class="kv"><span>${k.split("  ").map((x) => `<kbd>${esc(x)}</kbd>`).join(" ")}</span><span>${esc(w)}</span></div>`).join("");
  const marks = SAMPLE_MARKS.map((m) => `<div class="kv"><span class="mk">${toHTML(m)}</span><span>${esc(tipOfRaw(m))}</span></div>`).join("");
  return `<div class="home-in">
  <h1>Help</h1>
  <p class="lead">Translate the game's lines beside the Japanese and the English, see each page in the game's own text box as you type, and play the
    game in your translation. The game's own files are never changed: what you write goes into your translation folder, and nowhere else.</p>
  <div class="card status">${status}<div class="go">${go.join("")}</div></div>

  <h2>Your first line, in five steps</h2>
  <ol class="steps">
    <li><h3>Say which language it is</h3>
      <p>Its code (es, fr, de…), its name as players will see it, and what you translate from: the Japanese, or one of the English versions.
        It is kept in your folder as language.json.</p>${langStep}</li>
    <li><h3>Pick a scene</h3>
      <p>The list on the left has every scene of the game, by route and day, each with a bar for how much of it is done
        (<i class="sw final"></i> final, <i class="sw reviewed"></i> reviewed, <i class="sw draft"></i> draft). Type in "Scene name" to find one;
        "hide finished" leaves only the scenes with lines left.</p><p>${show("side")}</p></li>
    <li><h3>Write the translation</h3>
      <p>A scene's lines come in the order the game shows them, page by page. Beside each are ${beside}
        (Columns adds others), and a box for yours: click it and type. Enter takes you to the next line. "use", on a column, puts its line in
        your box, marks and all, to write over.</p>${noJa}
      <p>Lines carry the game's own instructions, called marks, shown as small tags. Rest the pointer on one to see what it does, and keep it
        where the English has it. An invented line, as the box shows it:</p>
      <div class="ed sample" lang="en">${toHTML(SAMPLE)}</div>
      <p>${show("lines", "Show me the lines")}</p></li>
    <li><h3>See it in the game's text box</h3>
      <p>The preview, on the right, lays the page out with the game's own text box and font as you type: how many rows it takes (12 fit the
        screen), and whether a choice or a speech balloon is too wide. Under it is the same page in Tsukihimates, Japanese or another language,
        to compare. "▶ Play from here" plays the game from that page in your translation, in a new window.${play}</p>
      <p>${show("preview")}</p></li>
    <li><h3>Mark it, and it saves itself</h3>
      <p>Each line has a status: draft, reviewed or final, so the team can see what has been checked. A line is saved into your folder a moment
        after you change it, and the top right says so (${KEY}+S saves at once). A line changed on disk in the meantime (by someone else, or
        by a git pull) is never written over: nothing is saved, and the editor asks whether to keep yours or take the one on disk.</p><p>${show("save-state")}</p></li>
  </ol>

  <h2>The window</h2>
  <div class="map" aria-label="The editor's window">
    <button type="button" class="m-top" data-show="top"><b>The bar along the top</b> your language and folder, how much is done, the panels, and
      whether everything is saved</button>
    <button type="button" class="m-side" data-show="side"><b>Scenes</b> by route and day, with their progress</button>
    <button type="button" class="m-main" data-show="lines"><b>The scene's lines</b> page by page
      <span class="m-row"><span>#</span><span>Japanese</span><span>English</span><span class="you">Your translation</span><span>Status</span></span>
      <span class="m-row"><span>#</span><span>…</span><span>…</span><span class="you">…</span><span>draft</span></span></button>
    <button type="button" class="m-right" data-show="preview"><b>Preview</b> the page in the game's text box, and the same page in another
      language. Glossary, Checks, Search and Exchange open here in its place.</button>
  </div>

  <h2>The buttons along the top</h2>
  <div class="kvs">${bar}</div>

  <h2>Keys</h2>
  <div class="kvs">${keys}</div>

  <h2>The marks</h2>
  <p class="soft">What each one does in the game. The checks say where a line has lost one the English has, or has one the English lacks.</p>
  <div class="kvs marks">${marks}</div>

  <h2>Where your work goes, and working with others</h2>
  <ul class="facts">
    <li><b>The folder.</b> One file per scene, named after it, with language.json and glossary.json beside them: plain text (JSON). Keep the
      folder in a git repository and commit it, and several people can work on the same translation.</li>
    <li><b>Stale lines.</b> A line marked "stale" was translated from a line that has changed since. Look it over, then click "stale" to clear it.</li>
    <li><b>Glossary and memory.</b> The Glossary keeps the agreed words for names and terms, and the line you are on shows the ones it uses.
      Under the line you are on, translation memory: "Same" is another line with exactly the same source, already translated; "80% like" is
      one whose source is that much alike (the number is about the sources, not the translations). "use" puts its translation in your box,
      to change; "fill" gives your translation to the same lines not done yet.</li>
    <li><b>Checks.</b> What would stop the translation going into the game, or look wrong in it: marks lost or added, letters the game's font
      lacks, glossary terms left out, lines in a row whose quotation marks open and close unlike the Japanese (a line one place off), and,
      with "Check every page's fit", pages too long for the screen.</li>
    <li><b>Exchange.</b> The translation out as a spreadsheet (CSV), PO, XLIFF or deepLuna's format, for other translation programs, and back in.</li>
    <li><b>Into the game.</b> The game itself is never changed. When the translation is ready, the port's maintainer builds it into the
      released game as a language of its own.</li>
  </ul>

  <div class="home-foot"><button type="button" data-home="close">Close Help</button></div>
</div>`;
}
let homeScroll = 0;
function refreshHome() {
  if (!homeOn()) return;
  const main = $("#main"), at = main.scrollTop;
  $("#home").innerHTML = homeHTML();
  main.scrollTop = at;
}
function showHome(on) {
  if (on === homeOn()) { if (on) refreshHome(); return; }
  const main = $("#main");
  if (on) { homeScroll = main.scrollTop; $("#home").innerHTML = homeHTML(); }
  $("#home").hidden = !on;
  main.classList.toggle("home-on", on);
  window.history.replaceState(null, "", on || app.scene === null ? location.pathname : `#${encodeURIComponent(sceneName(app.scene))}`);
  $("#b-home").setAttribute("aria-pressed", String(on));
  main.scrollTop = on ? 0 : homeScroll;
}
// A scene the person chose: Help gives way to it.
function goScene(s, id = null) {
  if (homeOn()) showHome(false);
  return openScene(s, id);
}
function flash(el) {
  if (!el) return;
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 2600);
}
$("#b-home").addEventListener("click", () => showHome(!homeOn()));
$("#home").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.click) { $(`#${b.dataset.click}`).click(); return; }
  const h = b.dataset.home;
  if (h === "close") { showHome(false); return; }
  if (h === "last" || h === "next") {
    const p = h === "last" ? lastPlace() : nextEmpty();
    if (p) goScene(p.s, p.id);
    return;
  }
  const w = b.dataset.show;
  if (w === "lines") { showHome(false); flash($("#lines")); }
  else if (w === "preview") { togglePreview(true); flash($("#preview")); }
  else if (w === "top") flash($("#top"));
  else if (w) flash($(`#${w}`));
});
// (where you left off: the scene and the line last worked on, for "Continue")
lines.addEventListener("focusin", (e) => {
  const ed = e.target.closest?.(".ed");
  if (ed && app.scene !== null) prefs.set("last", { scene: sceneName(app.scene), id: Number(ed.closest(".line").dataset.id) });
});

// ---- start ---------------------------------------------------------------------------------------------------------------------------
async function start() {
  try {
    app.state = await api.get("/translator/api/state");
    api.token = app.state.token;
    if (app.state.error) throw new Error(app.state.error);
    app.folder = app.state.folder;
    const [map, folder] = await Promise.all([api.get("/translator/api/map"), app.folder ? api.get("/translator/api/folder") : null]);
    app.map = map;
    app.lines = sceneLines(map);
    app.tree = sceneTree(map, app.lines);
    map.scenes.forEach((sc, s) => sceneIndex.set(sc.name, s));
    if (folder) {
      app.book = new Book(folder.files);
      app.language = folder.language;
      app.glossary = folder.glossary;
      if (folder.problems.length) banner(`Files in the translations folder the editor cannot read (nothing of them is shown or written):<br>${folder.problems.map((p) => `${esc(p.file)}: ${esc(p.error)}`).join("<br>")}`, true);
      if (!folder.language) banner(`This folder has no language.json yet: <button type="button" data-act="lang">Set the language</button>`, false, () => $("#b-language").click());
    } else banner("No translations folder: the server was started without --translations &lt;folder&gt;, so lines can be read but not written.");
    const avail = app.state.languages;
    app.columns = prefs.get("columns", ["ja", "en"]).filter((l) => avail.includes(l));
    if (!app.columns.length) app.columns = avail.filter((l) => l === "ja" || l === "en");
    showLanguage();
    drawColumns();
    drawTree();
    showSave();
    // (the source each line is checked against, for stale lines)
    textOf(app.language?.from || "ja");
    const [name, line] = decodeURIComponent(location.hash.slice(1)).split("/");
    // The scene the address names; else where you left off (the scene and line last worked on), or the first scene.
    const named = sceneIndex.has(name), lp = lastPlace();
    const s = named ? sceneIndex.get(name) : lp?.s ?? app.tree[0]?.groups[0]?.scenes[0];
    const focus = named ? (line ? Number(line) : null) : lp?.id ?? null;
    if (s !== undefined) await openScene(s, focus);
    $("#pv-hint").textContent = app.state.play ? "" : app.folder ? "(needs a newer app)" : "(needs a translations folder)";
    compareChoices();
    cmp.lang = $("#cmp-lang").value || null;   // (its box loads with the first page shown)
    $("#pv-frame2").hidden = !cmp.lang;
    if (prefs.get("preview", true)) togglePreview(true);
    if (app.folder) loadChecks();
    window.translator = { app, serialize, offsetOf, pointAt, flush, openScene: goScene, showHome, measure, pv, ready: true };
  } catch (e) {
    banner(`The editor could not start: ${esc(e.message)}`, true);
    window.translator = { error: e.message };
  }
}
start();
