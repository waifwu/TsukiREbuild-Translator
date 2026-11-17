// updater.js - the translator app's own updates: newer tool files (the server, the editor, the fit page: tool-files.json) from the latest
// release of the app's GitHub repository, which its release workflow publishes (web-dev/tools/translator_manifest.py --release): the asset
// update.json names every file with its size and SHA-256 and the release's tag, and each file is an asset of that release named by its SHA-256.
//
// Updates are kept in the app's data folder, a whole tool tree a version:
//   tool-updates/state.json             which version is in use, which was before it, whether it has come up, which were given up
//   tool-updates/<version>/tool/...     the tool's files, laid out as the app packs them (resources/tool)
//   tool-updates/<version>/meta.json    what the version is (the site's description), written once every file is in place
// A version is put together in <version>.part (files already held are copied, the others downloaded, each checked against its hash) and only
// then renamed to <version>; nothing reads a version until state.json names it, and state.json is replaced in one step. The tool tree a
// running server reads is never written to. A version whose editor does not come up twice running is taken out again (the one before it is
// back, its name kept in `rejected`); everything goes when the app itself is another build than the updates were made for (bundled.json).
// Where downloads come from is fixed by the caller (`source`); a download that ends anywhere `allowed` does not accept is refused, and every
// file is checked against its hash. Only Node's own modules, so that the tests can run it (web-dev/tests/translator-update.test.mjs).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const VERSION = /^[0-9a-f]{12}$/;
const TAG = /^[A-Za-z0-9._-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;
const TOOL_PATH = /^(web|web-dev)\/[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;
const SERVER = "web-dev/tools/dev_server.py";
const DESCRIPTION_MOST = 1 << 20, FILE_MOST = 64 << 20, TRIES = 2, STALL = 30000;

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
// (translator_manifest.py version_of: the same)
const versionOf = (files) => sha256(Object.keys(files).sort().map((p) => `${p} ${files[p][0]} ${files[p][1]}\n`).join("")).slice(0, 12);
function writeWhole(file, data) {
  const tmp = `${file}.tmp`, fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  rename(tmp, file);
}
function rename(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (i >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      const until = Date.now() + 100 * (i + 1); while (Date.now() < until) { /* a moment: a scanner may hold it (Windows) */ }
    }
  }
}
const fileOk = (file, [size, hash]) => { try { const d = fs.readFileSync(file); return d.length === size && sha256(d) === hash; } catch { return false; } };

// A description as the site or bundled.json gives it, checked; else an Error.
function checked(d) {
  if (!d || typeof d !== "object" || !VERSION.test(d.version || "") || !Number.isFinite(d.time) || !Number.isInteger(d.shell) || !d.files || typeof d.files !== "object") throw Error("not a description of the tool");
  for (const [p, e] of Object.entries(d.files)) {
    if (!TOOL_PATH.test(p) || p.split("/").some((x) => x === "." || x === "..") || !Array.isArray(e) || !Number.isInteger(e[0]) || e[0] < 0 || e[0] > FILE_MOST || !HASH.test(e[1] || "")) throw Error(`not a file of the tool: ${p}`);
  }
  if (!d.files[SERVER]) throw Error("the description has no server");
  if (versionOf(d.files) !== d.version) throw Error("the description's version is not its files'");
  if (d.tag !== undefined && !TAG.test(d.tag)) throw Error("not a release's tag");
  return d;
}

// Where a GitHub repository's releases are: the latest one's update.json, and a release's file by its tag and hash. A redirect may take a
// download to GitHub's file hosts.
const github = (repo) => ({
  description: `https://github.com/${repo}/releases/latest/download/update.json`,
  file: (site, hash) => `https://github.com/${repo}/releases/download/${encodeURIComponent(site.tag)}/${hash}`,
  allowed: (url) => { const h = new URL(url).hostname; return url.startsWith("https://") && (h === "github.com" || h.endsWith(".githubusercontent.com")); },
  page: `https://github.com/${repo}/releases/latest`,
});
// A release's files in a folder served on this computer (translator_manifest.py --release DIR), for trying an update.
const local = (origin) => ({
  description: `${origin}/update.json`,
  file: (site, hash) => `${origin}/${hash}`,
  allowed: (url) => url.startsWith(`${origin}/`),
  page: `${origin}/`,
});

class ToolUpdater {
  // dir: where the updates are kept. source: github(repo) or local(origin). bundled: bundled.json (the app's own tool, in bundledRoot).
  // shell: what this app is (main.js TOOL_SHELL). fetch(url, opts): the web's fetch.
  constructor({ dir, source, bundled, bundledRoot, shell, fetch }) {
    Object.assign(this, { dir, source, bundled: checked(bundled), bundledRoot, shell, fetch });
    this.state = this.fresh();
    this.meta = null;
    this.inUse = null;   // the version a running server reads (null: the app's own): never dropped
  }
  fresh() { return { bundle: this.bundled.version, current: null, previous: null, confirmed: true, tries: 0, rejected: [] }; }
  folder(v) { return path.join(this.dir, v); }
  save() { fs.mkdirSync(this.dir, { recursive: true }); writeWhole(path.join(this.dir, "state.json"), JSON.stringify(this.state)); }
  // A version as it was put together, if every file of it is there as described; else null.
  read(v) {
    try {
      if (!VERSION.test(v || "")) return null;
      const meta = checked(JSON.parse(fs.readFileSync(path.join(this.folder(v), "meta.json"), "utf8")));
      if (meta.version !== v) return null;
      for (const [p, e] of Object.entries(meta.files)) if (!fileOk(path.join(this.folder(v), "tool", ...p.split("/")), e)) return null;
      return meta;
    } catch { return null; }
  }
  drop(v) { if (VERSION.test(v || "") && v !== this.inUse) fs.rmSync(this.folder(v), { recursive: true, force: true }); }
  giveUp() {
    const s = this.state;
    if (s.current) { s.rejected = [...s.rejected.filter((r) => r !== s.current), s.current].slice(-8); this.drop(s.current); }
    s.current = this.read(s.previous) ? s.previous : null;
    s.previous = null; s.confirmed = true; s.tries = 0;
    this.meta = s.current ? this.read(s.current) : null;
    this.save();
  }

  // Once, as the app starts.
  load() {
    let s = null;
    try { s = JSON.parse(fs.readFileSync(path.join(this.dir, "state.json"), "utf8")); } catch { /* none yet: as built */ }
    if (!s || typeof s !== "object" || s.bundle !== this.bundled.version) {
      // the app itself is another build than the updates were made for: it is the newer, and they go
      if (s) fs.rmSync(this.dir, { recursive: true, force: true });
      this.state = this.fresh();
      this.meta = null;
      return this;
    }
    this.state = { ...this.fresh(), ...s, rejected: Array.isArray(s.rejected) ? s.rejected.filter((r) => VERSION.test(r)) : [] };
    const st = this.state;
    if (st.current && !st.confirmed && st.tries >= TRIES) this.giveUp();
    if (st.current && !this.read(st.current)) this.giveUp();
    this.meta = st.current ? this.read(st.current) : null;
    // what is neither in use nor gone back to: out (a version left half put together too)
    try { for (const name of fs.readdirSync(this.dir)) if (name !== "state.json" && name !== st.current && name !== st.previous) fs.rmSync(path.join(this.dir, name), { recursive: true, force: true }); } catch { /* no folder yet */ }
    this.save();
    return this;
  }
  // The tool tree the server is to run from, and what it is.
  root() { return this.meta ? path.join(this.folder(this.meta.version), "tool") : this.bundledRoot; }
  // What giveUp() would go back to: the version before the one in use (when it is still whole), or the app's own tool.
  fallback() { const p = this.read(this.state.previous); return p ? { root: path.join(this.folder(p.version), "tool"), version: p.version } : { root: this.bundledRoot, version: null }; }
  info() { const d = this.meta || this.bundled; return { version: d.version, time: d.time, tag: d.tag || null, update: !!this.meta, rejected: this.state.rejected }; }
  // A server is starting from root(): an update not yet seen to come up counts a try.
  started() {
    this.inUse = this.meta ? this.meta.version : null;
    const s = this.state;
    if (s.current && !s.confirmed) { s.tries++; this.save(); }
  }
  // The editor has come up in the version in use: it stays, and the one before it is not needed any more.
  confirm() {
    const s = this.state;
    if (s.confirmed) return;
    s.confirmed = true; s.tries = 0;
    const old = s.previous;
    s.previous = null;
    this.save();
    if (old && old !== s.current) this.drop(old);
  }

  async get(url, most) {
    const cut = new AbortController();
    let timer = null;
    const wait = () => { clearTimeout(timer); timer = setTimeout(() => cut.abort(), STALL); };
    try {
      wait();
      if (!this.source.allowed(url)) throw Error(`${url}: not where updates come from`);
      const r = await this.fetch(url, { signal: cut.signal, redirect: "follow", cache: "no-store" });
      // (where the fetch says where a redirect ended; Electron's does not, and main.js holds its update session to `allowed` instead)
      if (r.url && !this.source.allowed(r.url)) throw Error(`${url}: sent on to ${new URL(r.url).hostname}, not where updates come from`);
      if (r.status !== 200 || !r.body) throw Error(`${url}: HTTP ${r.status}`);
      const parts = [];
      let size = 0;
      for await (const piece of r.body) {
        wait();
        size += piece.length;
        if (size > most) throw Error(`${url}: larger than expected`);
        parts.push(Buffer.from(piece));
      }
      return Buffer.concat(parts);
    } finally { clearTimeout(timer); }
  }
  // What the site has: { kind: "none" | "newer-app" | "update", site }. "newer-app": the update needs a newer app than this one.
  async check() {
    const site = checked(JSON.parse((await this.get(this.source.description, DESCRIPTION_MOST)).toString("utf8")));
    if (!site.tag) throw Error("the release's update.json names no tag");
    const now = this.meta || this.bundled;
    if (site.version === now.version || this.state.rejected.includes(site.version) || !(site.time > now.time)) return { kind: "none", site };
    if (site.shell > this.shell) return { kind: "newer-app", site };
    if (site.version === this.state.current) return { kind: "none", site };   // (put in place already: the next start uses it)
    return { kind: "update", site };
  }
  // Puts the site's version together beside the others: a file held by the tool in use (or the app's own) is copied, the rest downloaded.
  // Returns the number of files downloaded.
  async stage(site) {
    checked(site);
    const v = site.version, part = `${this.folder(v)}.part`, have = this.root();
    if (this.read(v)) return 0;
    fs.rmSync(part, { recursive: true, force: true });
    let fetched = 0;
    try {
      for (const [p, e] of Object.entries(site.files)) {
        const dest = path.join(part, "tool", ...p.split("/"));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const mine = path.join(have, ...p.split("/"));
        if (fileOk(mine, e)) { fs.copyFileSync(mine, dest); continue; }
        const data = await this.get(this.source.file(site, e[1]), e[0]);
        if (data.length !== e[0] || sha256(data) !== e[1]) throw Error(`${p}: not the file the site lists`);
        writeWhole(dest, data);
        fetched++;
      }
      writeWhole(path.join(part, "meta.json"), JSON.stringify(site));
      fs.rmSync(this.folder(v), { recursive: true, force: true });
      rename(part, this.folder(v));
    } catch (e) { fs.rmSync(part, { recursive: true, force: true }); throw e; }
    if (!this.read(v)) throw Error("the update did not come together");
    return fetched;
  }
  // Switches to version `v` (put together by stage) from the next server start on.
  apply(v) {
    const meta = this.read(v);
    if (!meta) throw Error("that update is not here");
    const s = this.state;
    if (s.current === v) return;
    // (the one before stays until this one has come up; an unconfirmed one in between is not gone back to)
    if (s.confirmed) { if (s.previous && s.previous !== v) this.drop(s.previous); s.previous = s.current; } else this.drop(s.current);
    s.current = v; s.confirmed = false; s.tries = 0;
    this.save();
    this.meta = meta;
  }
}

module.exports = { ToolUpdater, versionOf, checked, github, local, TOOL_PATH };
