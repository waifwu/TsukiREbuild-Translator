// japanese.js - the Japanese the translator needs, fetched from the site (arcueid.date) when the installed game has none of its own: the
// Windows game downloads its Japanese only when 日本語 is chosen on its LANGUAGE tab, and the translator wants it from the start (the Japanese
// column, the translation memory and checks against it, the second text box in Japanese, the line map's Japanese scripts).
//
// It is what the game's apps download for Japanese (web/app/js/update.js), less the movies: the site's update/app.json names the language's list
// (update/lang-ja-<md5>.txt, "md5 size path" a line), and each file is at assets/<path>?h=<md5 start>. Today: the 16 packs and their index
// (the scripts, the lines, the tables), the three faces and index.json, about 57 MB. Kept in the app's data folder:
//   japanese/assets/ja/...    the files, as the game keeps them (web-dev/tools/gamefiles.py reads a pack's files out of it)
//   japanese/fetched.json     what is there: the list's MD5, and each file's size and MD5; written last, so a folder without it is never used
// A file already there with its size and MD5 is kept. The others are all downloaded and checked first, and only then written (beside their
// place, then renamed over it), the files the list no longer names removed, and fetched.json written again: a download cut off leaves the folder
// as it was, still in use. Only Node's own modules (web-dev/tests/translator-update.test.mjs).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const LANG = "ja";
const MD5 = /^[0-9a-f]{32}$/;
const SAFE_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;
const LIST_PATH = /^update\/lang-ja-[0-9a-f]{12}\.txt$/;
const SKIP = /^ja\/movie\//;   // (the movies: the translator plays none)
const SMALL_MOST = 4 << 20, FILE_MOST = 256 << 20, STALL = 30000;

const md5 = (data) => crypto.createHash("md5").update(data).digest("hex");
const stamped = (p, hash) => `${p}?h=${hash.slice(0, 12)}`;   // (update.js stamped: the same)
function writeWhole(file, data) {
  const tmp = `${file}.part`, fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      const until = Date.now() + 100 * (i + 1); while (Date.now() < until) { /* a moment (Windows) */ }
    }
  }
}
const fileOk = (file, size, hash) => { try { const st = fs.statSync(file); return st.size === size && md5(fs.readFileSync(file)) === hash; } catch { return false; } };

// The site's list of a language's files: [[path, size, md5]], the ones the translator takes.
function parseList(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    const [hash, size, p, more] = line.trim().split(" ");
    if (!MD5.test(hash || "") || !/^\d+$/.test(size || "") || !SAFE_PATH.test(p || "") || more !== undefined || !p.startsWith(`${LANG}/`)) throw Error(`not the site's list of the Japanese: ${line.slice(0, 80)}`);
    if (Number(size) > FILE_MOST) throw Error(`${p}: larger than expected`);
    if (!SKIP.test(p)) out.push([p, Number(size), hash]);
  }
  if (!out.some(([p]) => p === `${LANG}/index.json`)) throw Error("the list has no ja/index.json");
  return out;
}

class Japanese {
  // dir: the app's japanese folder. origin: the site (https://arcueid.date). fetch(url, opts): the web's fetch.
  constructor({ dir, origin, fetch }) { Object.assign(this, { dir, origin: origin.replace(/\/$/, ""), fetch }); }
  marker() { return path.join(this.dir, "fetched.json"); }
  // What is there, when it is whole (every file at its size): { list, files }; else null.
  held() {
    try {
      const m = JSON.parse(fs.readFileSync(this.marker(), "utf8"));
      if (!MD5.test(m.list || "") || !Array.isArray(m.files) || !m.files.length) return null;
      for (const [p, size] of m.files) {
        if (!SAFE_PATH.test(p)) return null;
        const st = fs.statSync(path.join(this.dir, "assets", ...p.split("/")));
        if (st.size !== size) return null;
      }
      return m;
    } catch { return null; }
  }
  async get(url, most) {
    const cut = new AbortController();
    let timer = null;
    const wait = () => { clearTimeout(timer); timer = setTimeout(() => cut.abort(), STALL); };
    try {
      wait();
      const r = await this.fetch(url, { signal: cut.signal, cache: "no-store" });
      if (r.status !== 200 || !r.body) throw Error(`${url}: HTTP ${r.status}`);
      const parts = [];
      let size = 0;
      for await (const piece of r.body) {
        wait();
        size += piece.length;
        if (size > most) throw Error(`${url}: larger than expected`);
        parts.push(Buffer.from(piece));
        this.onBytes?.(piece.length);
      }
      return Buffer.concat(parts);
    } finally { clearTimeout(timer); }
  }
  // Brings the folder to what the site lists now. onProgress({ done, total }): bytes downloaded of those to download. Returns
  // { changed, fetched, bytes }; throws when the site cannot be read or a file is not what it lists (the folder is then as it was).
  async refresh(onProgress = null) {
    const app = JSON.parse((await this.get(`${this.origin}/update/app.json`, SMALL_MOST)).toString("utf8"));
    const l = app?.langs?.[LANG];
    if (!l || !MD5.test(l.md5 || "") || !LIST_PATH.test(l.path || "")) throw Error("the site lists no Japanese");
    const had = this.held();
    if (had && had.list === l.md5) return { changed: false, fetched: 0, bytes: 0 };
    const listText = await this.get(`${this.origin}/${stamped(l.path, l.md5)}`, SMALL_MOST);
    if (md5(listText) !== l.md5) throw Error("the site's list of the Japanese is not the one app.json names");
    const files = parseList(listText.toString("utf8"));
    const root = path.join(this.dir, "assets");
    const wanted = files.filter(([p, size, hash]) => !fileOk(path.join(root, ...p.split("/")), size, hash));
    const total = wanted.reduce((n, [, size]) => n + size, 0);
    let done = 0;
    this.onBytes = (n) => { done += n; onProgress?.({ done, total }); };
    const got = [];
    try {
      onProgress?.({ done, total });
      for (const [p, size, hash] of wanted) {
        const data = await this.get(`${this.origin}/${stamped(`assets/${p}`, hash)}`, size);
        if (data.length !== size || md5(data) !== hash) throw Error(`${p}: not the file the site lists`);
        got.push([p, data]);
      }
    } finally { this.onBytes = null; }
    // all of it here and checked: the folder changes (not whole meanwhile: fetched.json goes first, and comes back last)
    if (got.length) fs.rmSync(this.marker(), { force: true });
    for (const [p, data] of got) {
      const dest = path.join(root, ...p.split("/"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      writeWhole(dest, data);
    }
    // what the list no longer names: out
    const keep = new Set(files.map(([p]) => p));
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else if (!keep.has(r)) fs.rmSync(path.join(dir, e.name), { force: true });
      }
    };
    if (fs.existsSync(path.join(root, LANG))) walk(path.join(root, LANG), LANG);
    writeWhole(this.marker(), JSON.stringify({ from: this.origin, list: l.md5, time: Date.now(), files }));
    return { changed: true, fetched: wanted.length, bytes: total };
  }
}

// Whether an installed game has the Japanese itself: its www, or the update its own data folder plays (gamefiles.py reads the same places).
function gameHasJapanese(www, gameData) {
  if (fs.existsSync(path.join(www, "assets", LANG, "text.json")) || fs.existsSync(path.join(www, "assets", LANG, "pack", "index.json"))) return true;
  try {
    const cur = JSON.parse(fs.readFileSync(path.join(gameData, "update", "state.json"), "utf8")).current;
    if (!cur) return false;
    const a = path.join(gameData, "update", String(cur), "files", "assets", LANG);
    return fs.existsSync(path.join(a, "text.json")) || fs.existsSync(path.join(a, "pack", "index.json"));
  } catch { return false; }
}

module.exports = { Japanese, parseList, gameHasJapanese, SKIP };
