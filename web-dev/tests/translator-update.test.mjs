// The translator app's own updates (web-dev/translator-app/updater.js, main.js; web-dev/tools/translator_manifest.py): one list of the tool's
// files for the app, its bundled.json and a release; a newer release taken file by file and checked; a version that does not come up given up;
// a release that needs a newer app not taken; a new app drops the updates. Invented files only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP = join(ROOT, "web-dev/translator-app");
const { ToolUpdater, versionOf, checked, github, local } = require(join(APP, "updater.js"));
const LIST = JSON.parse(readFileSync(join(APP, "tool-files.json"), "utf8"));
const python = (() => { try { execFileSync("python3", ["--version"]); return true; } catch { return false; } })();

const sha = (b) => createHash("sha256").update(b).digest("hex");
// A tool tree of invented files, and its description.
function tree(dir, files) {
  const out = {};
  for (const [p, text] of Object.entries(files)) {
    const f = join(dir, ...p.split("/"));
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
    out[p] = [Buffer.byteLength(text), sha(Buffer.from(text))];
  }
  return out;
}
const describe = (files, time, extra = {}) => ({ version: versionOf(files), time, shell: 1, files, ...extra });
// A release as the site would have it: update.json and each file by its hash, behind a fetch.
function site(files, time, extra = {}) {
  const d = describe(Object.fromEntries(Object.entries(files).map(([p, t]) => [p, [Buffer.byteLength(t), sha(Buffer.from(t))]])), time, { tag: "v-next", ...extra });
  const assets = new Map([["update.json", Buffer.from(JSON.stringify(d))]]);
  for (const t of Object.values(files)) assets.set(sha(Buffer.from(t)), Buffer.from(t));
  return { d, assets };
}
const ORIGIN = "http://127.0.0.1:9";
function fetcher(release, { redirect = null, fail = false } = {}) {
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    if (fail) throw Error("offline");
    const name = url.slice(ORIGIN.length + 1);
    const data = release.assets.get(name);
    return { status: data ? 200 : 404, url: redirect || url, body: data ? (async function* () { yield data; })() : null };
  };
  return { fetch, asked };
}
const BASE = { "web-dev/tools/dev_server.py": "print('server 1')\n", "web-dev/translator/editor.js": "// editor 1\n", "web/server.py": "# the game's server\n" };
function setUp(t) {
  const dir = mkdtempSync(join(tmpdir(), "tool-update-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = join(dir, "app-tool");
  const bundled = describe(tree(app, BASE), 1000);
  return { dir, app, bundled, updates: join(dir, "updates") };
}
const make = (w, release, opts = {}) => new ToolUpdater({ dir: w.updates, source: local(ORIGIN), bundled: opts.bundled || w.bundled, bundledRoot: w.app, shell: opts.shell ?? 1, fetch: fetcher(release, opts).fetch }).load();

test("one list of the tool's files: what the app packs, bundled.json and a release; the app's shell number as the list's", () => {
  const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8"));
  const packed = new Set();
  for (const e of pkg.build.extraResources) {
    const to = e.to.replace(/^tool\//, "");
    if (to === "bundled.json") continue;
    if (!e.filter) { packed.add(to); continue; }
    for (const f of readdirSync(join(APP, e.from))) if (e.filter.some((p) => new RegExp(`^${p.replace(/[.]/g, "\\.").replace(/\*/g, "[^/]*")}$`).test(f))) packed.add(`${to}/${f}`);
  }
  assert.deepEqual([...packed].sort(), [...LIST.files].sort(), "package.json extraResources packs exactly tool-files.json's files");
  assert.ok(pkg.build.extraResources.some((e) => e.to === "tool/bundled.json"), "the app carries bundled.json");
  for (const f of ["updater.js", "tool-files.json"]) assert.ok(pkg.build.files.includes(f), `the app packs ${f}`);
  const main = readFileSync(join(APP, "main.js"), "utf8");
  assert.equal(Number(/const TOOL_SHELL = (\d+);/.exec(main)[1]), LIST.shell, "main.js TOOL_SHELL is tool-files.json's shell");
  assert.match(main, /require\("\.\/updater\.js"\)/);
  assert.match(main, /github\(TOOL_LIST\.repository\)/);
  assert.match(main, /ses\.webRequest\.onBeforeRequest\(\(d, done\) => \{ const ok = source\.allowed\(d\.url\);/, "the update session reaches only where updates come from, redirects included");
  assert.equal(LIST.repository, "waifwu/TsukiREbuild-Translator");
  // an update that does not start: given up there and then, the one before it started
  assert.match(main, /port = await startServer\(www, folder, updater\.fallback\(\)\);\s*updater\.giveUp\(\);/, "given up only once the one before it has started");
  assert.match(main, /await open\(place\.www, place\.folder\);/, "a restart opens the same game and folder again");
  assert.match(readFileSync(join(APP, "build.sh"), "utf8"), /translator_manifest\.py --bundle out\/bundled\.json/);
});

test("translator_manifest.py and updater.js describe the tool alike (version, files, a release's assets)", { skip: !python && "no python3" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tool-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("python3", [join(ROOT, "web-dev/tools/translator_manifest.py"), "--bundle", join(dir, "bundled.json"), "--time", "1000"]);
  execFileSync("python3", [join(ROOT, "web-dev/tools/translator_manifest.py"), "--release", join(dir, "rel"), "--tag", "v1", "--time", "2000"]);
  const b = checked(JSON.parse(readFileSync(join(dir, "bundled.json"), "utf8")));
  const r = checked(JSON.parse(readFileSync(join(dir, "rel", "update.json"), "utf8")));
  assert.deepEqual(Object.keys(b.files).sort(), [...LIST.files].sort());
  assert.equal(b.version, r.version);
  assert.equal(b.time, 1000);
  assert.equal(r.tag, "v1");
  for (const [p, [size, h]] of Object.entries(r.files)) {
    const data = readFileSync(join(dir, "rel", h));
    assert.equal(data.length, size, p);
    assert.deepEqual(data, readFileSync(join(ROOT, ...p.split("/"))), p);
  }
});

test("a newer release: only the changed files downloaded, checked, put together beside the tool in use, used from the next start", async (t) => {
  const w = setUp(t);
  const rel = site({ ...BASE, "web-dev/translator/editor.js": "// editor 2\n" }, 2000);
  const { fetch, asked } = fetcher(rel);
  const u = new ToolUpdater({ dir: w.updates, source: local(ORIGIN), bundled: w.bundled, bundledRoot: w.app, shell: 1, fetch }).load();
  assert.equal(u.root(), w.app);
  const r = await u.check();
  assert.equal(r.kind, "update");
  assert.equal(await u.stage(r.site), 1, "one file new");
  assert.deepEqual(asked, [`${ORIGIN}/update.json`, `${ORIGIN}/${rel.d.files["web-dev/translator/editor.js"][1]}`]);
  assert.equal(u.root(), w.app, "nothing changes until it is applied");
  u.apply(r.site.version);
  assert.equal(readFileSync(join(u.root(), "web-dev/translator/editor.js"), "utf8"), "// editor 2\n");
  assert.equal(readFileSync(join(u.root(), "web-dev/tools/dev_server.py"), "utf8"), "print('server 1')\n", "an unchanged file copied");
  assert.equal(readFileSync(join(w.app, "web-dev/translator/editor.js"), "utf8"), "// editor 1\n", "the app's own tool untouched");
  // the next start: it is in use, counted, then confirmed when the editor comes up
  const v = make(w, rel);
  assert.equal(v.info().version, rel.d.version);
  assert.equal(v.info().tag, "v-next");
  v.started();
  assert.equal(v.state.tries, 1);
  v.confirm();
  assert.equal(v.state.confirmed, true);
  assert.equal((await v.check()).kind, "none", "up to date now");
});

test("a file that is not the one the release lists is refused, and nothing is left of the version", async (t) => {
  const w = setUp(t);
  const rel = site({ ...BASE, "web-dev/translator/editor.js": "// editor 2\n" }, 2000);
  rel.assets.set(rel.d.files["web-dev/translator/editor.js"][1], Buffer.from("// tampered\n"));
  const u = make(w, rel);
  const r = await u.check();
  await assert.rejects(u.stage(r.site), /not the file the site lists/);
  assert.deepEqual(readdirSync(w.updates).filter((n) => n !== "state.json"), [], "no version folder, no .part");
  assert.equal(u.root(), w.app);
});

test("a version that does not come up twice running is given up: the app's own tool is back, and it is not offered again", async (t) => {
  const w = setUp(t);
  const rel = site({ ...BASE, "web-dev/tools/dev_server.py": "raise SystemExit(1)\n" }, 2000);
  const u = make(w, rel);
  const r = await u.check();
  await u.stage(r.site);
  u.apply(r.site.version);
  for (let i = 0; i < 2; i++) { const s = make(w, rel); assert.equal(s.root(), u.root()); s.started(); }   // started, never confirmed
  const back = make(w, rel);
  assert.equal(back.root(), w.app, "the app's own tool");
  assert.deepEqual(back.state.rejected, [rel.d.version]);
  assert.ok(!existsSync(join(w.updates, rel.d.version)), "its folder gone");
  assert.equal((await back.check()).kind, "none", "not offered again");
  // given up at once (main.js: its server did not start)
  const w2 = setUp(t);
  const u2 = make(w2, rel);
  await u2.stage((await u2.check()).site);
  u2.apply(rel.d.version);
  u2.giveUp();
  assert.equal(u2.root(), w2.app);
  assert.deepEqual(u2.state.rejected, [rel.d.version]);
});

test("not taken: a release that needs a newer app, an older one, one from elsewhere; a new app drops the updates; no site is an error to the caller", async (t) => {
  const w = setUp(t);
  const changed = { ...BASE, "web-dev/translator/editor.js": "// editor 3\n" };
  assert.equal((await make(w, site(changed, 2000, { shell: 2 })).check()).kind, "newer-app");
  assert.equal((await make(w, site(changed, 500)).check()).kind, "none", "older than the app's own tool");
  await assert.rejects(make(w, site(changed, 2000), { redirect: "https://example.com/x" }).check(), /not where updates come from/);
  await assert.rejects(make(w, site(changed, 2000), { fail: true }).check(), /offline/);
  // put in place, then the app replaced by another build: the updates go
  const rel = site(changed, 2000);
  const u = make(w, rel);
  await u.stage((await u.check()).site);
  u.apply(rel.d.version);
  const other = describe(tree(join(w.dir, "app-tool-2"), { ...BASE, "web/server.py": "# another build\n" }), 3000);
  const fresh = new ToolUpdater({ dir: w.updates, source: local(ORIGIN), bundled: other, bundledRoot: join(w.dir, "app-tool-2"), shell: 1, fetch: fetcher(rel).fetch }).load();
  assert.equal(fresh.meta, null);
  assert.ok(!existsSync(join(w.updates, rel.d.version)));
  // a description that does not hold together, or reaches outside the tool
  assert.throws(() => checked({ ...rel.d, version: "000000000000" }), /version/);
  assert.throws(() => checked(describe({ "../evil.py": [1, "a".repeat(64)], "web-dev/tools/dev_server.py": [1, "b".repeat(64)] }, 1)), /not a file of the tool/);
});

test("GitHub: the latest release's update.json, a release's file by tag and hash, and only GitHub's hosts", () => {
  const g = github("waifwu/TsukiREbuild-Translator");
  assert.equal(g.description, "https://github.com/waifwu/TsukiREbuild-Translator/releases/latest/download/update.json");
  assert.equal(g.file({ tag: "v2026.11.18" }, "ab".repeat(32)), `https://github.com/waifwu/TsukiREbuild-Translator/releases/download/v2026.11.18/${"ab".repeat(32)}`);
  assert.ok(g.allowed("https://objects.githubusercontent.com/github-production-release-asset/x"));
  assert.ok(g.allowed("https://release-assets.githubusercontent.com/x"));
  assert.ok(!g.allowed("http://github.com/x"));
  assert.ok(!g.allowed("https://github.com.example.com/x"));
  assert.ok(!g.allowed("https://example.com/x"));
});
