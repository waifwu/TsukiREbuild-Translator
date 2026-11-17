// The translator tool's editor (web-dev/TRANSLATOR-TOOL-PLAN.md, Stage 2): the markup read and written back exactly (web-dev/translator/markup.js),
// what the editor works out from the line map (model.js), and the server it runs on (web-dev/tools/dev_server.py with gamefiles.py and
// translations.py), run from a copy of the tool's files alone over an invented copy of an installed app: no line of the game's is used here, but
// the markup is also read back over every line of the game's texts that this checkout has (skipped where it has none).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, readdirSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { tokenize, join as joinTokens, readable, toggleItalic, spanKind, plainText, toHTML, italic, marksOf } from "../translator/markup.js";
import { sceneLines, sceneTree, Book, counts, edited, compile, matchesIn, replaceIn, expand } from "../translator/model.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const python = (() => { try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const sha12 = (s) => createHash("sha1").update(s, "utf8").digest("hex").slice(0, 12);
const I = (s) => italic(s);   // italic letters

// ---- markup ------------------------------------------------------------------------------------------------------------------------------
// The edit box's HTML read back as the editor reads its DOM (editor.js serialize): text as it is, <i> as italic letters, a tag as its data-raw.
function fromHTML(html) {
  const ent = (s) => s.replace(/&(amp|lt|gt|quot|#10);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#10": "\n" })[e]);
  let out = "";
  const re = /<span class="chip[^"]*" contenteditable="false" data-raw="([^"]*)"[^>]*>(?:<ruby>.*?<\/ruby>|[^<]*)<\/span>|<i>([^<]*)<\/i>|([^<]+)/gs;
  let m, at = 0;
  while ((m = re.exec(html))) {
    assert.equal(m.index, at, `unread HTML at ${at}: ${html.slice(at, at + 40)}`);
    at = re.lastIndex;
    out += m[1] !== undefined ? ent(m[1]) : m[2] !== undefined ? italic(ent(m[2])) : ent(m[3]);
  }
  assert.equal(at, html.length);
  return out;
}
const SAMPLES = [
  "A plain line.", `${I("Italic")} words, ${I("two of them")}.`, "<cat|neko> and <" + I("chirp") + "|" + I("c h i r p  ") + ">", "a < b > c | d",
  "@gQuiet@g night.", "@c3red@c0 back", "Two parts@ttyped", "[ber00][ber00][zap00] noise", "[ber0\n0] a tag broken by a row", "Rows^of^its own",
  "deepLuna\nbreaks\nhere", "a\ue3ffsoft", "日本語\ue3fe行", "\ue0c1\ue0c2 mirrored, \ue141 mirrored italic, \ue1c1 archaic, \ue2c1 upside down, \ue200",
  "an email@example.com", "@", "@@g", "e = mc² — “quotes” ■■ ―――", "", "\ue020 italic space",
];

test("a line cut into tokens is the same line joined again, and each kind of mark is its own token", () => {
  for (const s of SAMPLES) assert.equal(joinTokens(tokenize(s)), s, s);
  const kinds = (s) => tokenize(s).map((t) => t.k).join(" ");
  assert.equal(kinds(`a ${I("b")} <c|d> @g ^ \n [ber00] \ue3ff \ue3fe \ue0c1`), "text it text ruby text mark text row text nl text mark text soft text jrow text face");
  assert.deepEqual(tokenize("<cat|neko>")[0], { k: "ruby", raw: "<cat|neko>", base: "cat", reading: "neko" });
  assert.equal(kinds("a < b > c"), "text", "no bar: not ruby");
  assert.equal(kinds("@c3x@cy"), "mark text mark text");
  assert.equal(kinds("[ber0\n0]"), "text nl text", "a tag a row break cut stays letters");
  assert.deepEqual(marksOf("@gA <b|c> ^ [ber00]"), ["@g", "<|>", "^", "[ber00]"]);
});

test("the readable form is the line with each face's letters as ASCII, the same length", () => {
  for (const s of SAMPLES) assert.equal(readable(s).length, s.length);
  assert.equal(readable(`${I("Hello")} \ue0c1 \ue1c1`), "Hello A A");
  assert.equal(plainText(`@g${I("So")} <cat|neko>^next\ue3ffword`), "So cat\nnext word");
});

test("italics go on and off over chosen letters only, spaces kept plain, marks untouched", () => {
  assert.equal(toggleItalic("ab cd", 0, 4), `${I("ab")} ${I("c")}d`);
  assert.equal(toggleItalic(toggleItalic("ab cd", 0, 4), 0, 4), "ab cd");
  assert.equal(toggleItalic("x <a|b> y", 0, 9), `${I("x")} <a|b> ${I("y")}`, "ruby inside a range is left whole");
  assert.equal(toggleItalic(`${I("ab")}cd`, 0, 4), `${I("abcd")}`, "a mixed range becomes all italic");
  assert.deepEqual(spanKind(`a ${I("bc")} @g`, 2, 4), { plain: true, italic: true });
  assert.deepEqual(spanKind("a @g b", 1, 5), { plain: false, italic: false });
});

test("the edit box's HTML reads back to the line it was made from", () => {
  for (const s of SAMPLES) assert.equal(fromHTML(toHTML(s)), s, s);
});

const texts = ["text.json", "ja/text.json", "zh/text.json", "aniplex/text.json", "pt/text.json"].map((f) => join(ROOT, "web/assets", f)).filter(existsSync);
test("every line of the game's texts here is read back exactly (tokens and the edit box's HTML)", { skip: !texts.length && "no web/assets" }, () => {
  for (const f of texts) {
    const lines = JSON.parse(readFileSync(f, "utf8"));
    let bad = 0;
    for (const s of lines) if (joinTokens(tokenize(s)) !== s || fromHTML(toHTML(s)) !== s || readable(s).length !== s.length) bad++;
    assert.equal(bad, 0, f);
  }
});

// ---- the model ---------------------------------------------------------------------------------------------------------------------------
// An invented line map: scene 1 shows lines 0-3 (line 2 named twice, line 3 also in a PS4 block), scene 2 (a corner) line 4, line 5 is never shown.
const MAP = {
  source: { lines: 6 },
  scenes: [{ name: "START_SCRIPT", route: "system" }, { name: "01_00_ARC01_1", route: "arcueid", day: 1 }, { name: "QA_01", route: "qa", episode: 1 },
    { name: "14_01B_CIEL14B_1", route: "ciel", day: 14, part: "B" }],
  pages: [{ s: 1, k: 0, a: 0, b: 5 }, { s: 1, k: 1, a: 5, b: 9 }, { s: 2, k: 0, a: 0, b: 3 }],
  lines: [{ id: 0, at: [{ s: 1, pc: 4, nth: 0, page: 1 }] }, { id: 1, at: [{ s: 1, pc: 1, nth: 0, page: 0 }] },
    { id: 2, at: [{ s: 1, pc: 1, nth: 1, page: 0 }, { s: 1, pc: 7, nth: 0, page: 1 }] }, { id: 3, at: [{ s: 1, pc: 2, nth: 0, page: null, dead: 1 }, { s: 1, pc: 8, nth: 0, page: 1 }] },
    { id: 4, at: [{ s: 2, pc: 1, nth: 0, page: 2 }] }, { id: 5, at: [] }],
};

test("a scene shows its lines in the order its script names them, each once, a PS4 block last", () => {
  const per = sceneLines(MAP);
  assert.deepEqual(per[1].map((x) => x.id), [1, 2, 0, 3]);
  assert.deepEqual(per[1].map((x) => x.page), [0, 0, 1, 1]);
  assert.equal(per[1].find((x) => x.id === 3).dead, false, "a line also played elsewhere is not a PS4 line");
  assert.deepEqual(per[0], []);
  const tree = sceneTree(MAP, per);
  assert.deepEqual(tree.map((r) => r.route), ["arcueid", "qa"], "routes in order, empty ones left out");
  assert.deepEqual(tree[0].groups.map((g) => [g.label, g.scenes]), [["Day 1", [1]]]);
  assert.equal(sceneTree({ ...MAP, lines: [...MAP.lines, { id: 6, at: [{ s: 3, pc: 0, nth: 0, page: null }] }] })[1].groups[0].label, "Day 14 (B)");
});

test("the folder: a line's file, statuses and progress, and the row an edit makes", () => {
  const book = new Book({ "01_00_ARC01_1": [{ id: 1, text: "Un.", status: "final", from: { lang: "ja", hash: "aaaaaaaaaaaa" } }, { id: 2, text: "", status: "empty" }],
    QA_01: [{ id: 4, text: "Quatre.", status: "draft", note: "n", extra: 1 }] });
  assert.equal(book.fileOf(4, "01_00_ARC01_1"), "QA_01");
  assert.equal(book.fileOf(0, "01_00_ARC01_1"), "01_00_ARC01_1");
  assert.deepEqual(counts([0, 1, 2, 3], book), { empty: 3, draft: 0, reviewed: 0, final: 1, total: 4 });
  const from = { lang: "en", hash: "bbbbbbbbbbbb" };
  assert.deepEqual(edited(null, 0, { text: "Zéro." }, from), { id: 0, text: "Zéro.", status: "draft", from });
  assert.deepEqual(edited(book.rows.get(1), 1, { text: "" }, from), { id: 1, text: "", status: "empty", from });
  const r = edited(book.rows.get(4), 4, { note: "" });
  assert.deepEqual(Object.keys(r), ["id", "text", "status", "extra"], "keys kept in their order, an emptied note dropped");
  assert.equal(edited(book.rows.get(1), 1, { text: "Uno." }, from).status, "final", "a status chosen is kept");
});

test("search on the readable text; replace letter for letter, in italics where the match was, never across a mark", () => {
  const re = compile("cat", {});
  assert.deepEqual(matchesIn(`a ${I("Cat")} and a cat`, re).map((m) => [m.a, m.b]), [[2, 5], [12, 15]]);
  const line = `a ${I("Cat")} and a cat and <cat|neko>`;
  const r = replaceIn(line, matchesIn(line, re), "dog");
  assert.equal(r.text, `a ${I("dog")} and a dog and <cat|neko>`);
  assert.deepEqual([r.done, r.left], [2, 1]);
  assert.equal(compile("cat", { word: true }).test("concatenate"), false);
  const g = compile("(\\w+), (\\w+)", { regex: true });
  const line2 = "Hello, world";
  assert.equal(replaceIn(line2, matchesIn(line2, g), "$2, $1 ($&) $$").text, "world, Hello (Hello, world) $");
  assert.equal(expand("$<x>!", Object.assign(["ab", "a"], { groups: { x: "Z" } })), "Z!");
  assert.throws(() => compile("(", { regex: true }));
});

// ---- the server, over an installed app ---------------------------------------------------------------------------------------------------
// The tool's files: what web-dev/tools/dev_server.py loads and serves. A translator gets these and the app; nothing else of this checkout.
const TOOL = ["web/server.py", "web-dev/tools/dev_server.py", "web-dev/tools/gamefiles.py", "web-dev/tools/line_map.py", "web-dev/tools/translations.py",
  "web-dev/tools/build_layer.py", "web-dev/tools/story-font-cover.json", "web-dev/tools/exchange.py", "web-dev/tools/build_pt.py",
  "web-dev/fit/fit.html", "web-dev/fit/fit.js", "web-dev/fit/run-mcp.js",
  ...readdirSync(join(ROOT, "web-dev/translator")).filter((f) => /\.(js|css|html)$/.test(f)).map((f) => `web-dev/translator/${f}`)];

test("the tool's file list names every module the server loads", () => {
  const src = ["web-dev/tools/dev_server.py", "web-dev/tools/translations.py", "web-dev/tools/build_layer.py", "web-dev/tools/exchange.py"].map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
  const used = [...src.matchAll(/os\.path\.join\(HERE, "([a-z_-]+\.(?:py|json))"\)|_tool\("([a-z_]+)"\)|_layer\(\)/g)].map((m) => m[1] || (m[2] ? `${m[2]}.py` : "build_layer.py"));
  assert.ok(used.includes("story-font-cover.json"));
  for (const f of used) assert.ok(TOOL.includes(`web-dev/tools/${f}`), f);
});

// An app as the desktop app has it (www: index.html and assets/), with invented lines; its "Japanese" only in a pack, as an app that downloaded it.
function app() {
  const dir = mkdtempSync(join(tmpdir(), "translator-"));
  const tool = join(dir, "tool"), www = join(dir, "www"), tl = join(dir, "my-translation");
  for (const f of TOOL) { mkdirSync(dirname(join(tool, f)), { recursive: true }); copyFileSync(join(ROOT, f), join(tool, f)); }
  const en = ["The moon is out.", "A cat sleeps.", "On the roof.", "Go home?", "Good evening.^", "unused"];
  const ja = ["月が出ている。", "猫が寝ている。", "屋根の上で。", "帰る？", "こんばんは。^", "未使用"];
  mkdirSync(join(www, "assets", "scripts"), { recursive: true });
  mkdirSync(join(www, "assets", "ja", "pack"), { recursive: true });
  mkdirSync(tl);
  writeFileSync(join(www, "index.html"), "<!doctype html><title>game</title>");
  mkdirSync(join(www, "js"));
  copyFileSync(join(ROOT, "web/app/js/languages.js"), join(www, "js", "languages.js"));   // (the page's own code, not the game's: in the repository)
  writeFileSync(join(www, "assets", "text.json"), JSON.stringify(en));
  writeFileSync(join(www, "assets", "scripts", "index.json"), JSON.stringify({ names: ["START_SCRIPT", "01_00_ARC01_1", "QA_01"], jump: {}, start: 0 }));
  const script = (ops) => JSON.stringify({ ops, labels: {} });
  writeFileSync(join(www, "assets", "scripts", "0.json"), script([["END_"]]));
  writeFileSync(join(www, "assets", "scripts", "1.json"), script([["MSG", "$000000"], ["WNTY", "1"], ["WKST", "F823", "eq", "0"], ["MSG", "$000001"],
    ["MSAD", "$000002"], ["WKST", "F823", "eq", "0"], ["SELR", "$000003"], ["SELD"], ["END_"]]));
  writeFileSync(join(www, "assets", "scripts", "2.json"), script([["MSG", "$000004"], ["WKST", "F823", "eq", "0"], ["END_"]]));
  const jaText = Buffer.from(JSON.stringify(ja));
  const other = Buffer.from('{"x":1}');
  writeFileSync(join(www, "assets", "ja", "pack", "ja-0123456789.pack"), Buffer.concat([other, jaText]));
  writeFileSync(join(www, "assets", "ja", "pack", "index.json"), JSON.stringify({ version: 1, packs: [["ja-0123456789.pack", ["gallery.json", other.length, "text.json", jaText.length]]] }));
  return { dir, tool, www, tl, en, ja, jaText };
}
async function serve(w) {
  const port = 21000 + Math.floor(Math.random() * 20000);
  const srv = spawn("python3", ["-I", join(w.tool, "web-dev/tools/dev_server.py"), String(port), "--app", w.www, "--translations", w.tl], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  srv.stderr.on("data", (d) => { err += d; });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`dev_server.py did not start: ${err}`)), 15000);
    srv.stdout.on("data", (d) => { if (String(d).includes("http://")) { clearTimeout(t); res(); } });
    srv.on("exit", (c) => rej(new Error(`dev_server.py exited ${c}: ${err}`)));
  });
  return { port, srv, base: `http://localhost:${port}` };
}
// A raw request, so that Host and Origin can be anything.
function raw(port, { method = "GET", path = "/", headers = {}, body = null }) {
  return new Promise((res, rej) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: Object.fromEntries(Object.entries({ ...headers, ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}) }).filter(([, v]) => v !== undefined)) }, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => res({ status: r.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", rej);
    if (body) req.write(body);
    req.end();
  });
}

test("the server runs from the tool's files alone over an installed app: the editor, the line map, the lines (a pack's too)", { skip: !python && "no python3" }, async () => {
  const w = app();
  const s = await serve(w);
  try {
    const page = await fetch(`${s.base}/translator/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /editor\.js/);
    for (const f of ["editor.js", "markup.js", "model.js", "editor.css"]) assert.equal((await fetch(`${s.base}/translator/${f}`)).status, 200, f);
    assert.equal((await fetch(`${s.base}/translator/../tools/dev_server.py`)).status, 404);
    const state = await (await fetch(`${s.base}/translator/api/state`)).json();
    assert.deepEqual(state.languages, ["en", "ja"]);
    assert.equal(state.lines, 6);
    assert.match(state.token, /^[0-9a-f]{32}$/);
    const map = await (await fetch(`${s.base}/translator/api/map`)).json();
    assert.deepEqual(map.lines.map((l) => l.at.map((a) => [a.s, a.page])), [[[1, 0]], [[1, 1]], [[1, 1]], [[1, 2]], [[2, 3]], []]);
    assert.deepEqual(map.pages.map((p) => [p.s, p.k]), [[1, 0], [1, 1], [1, 2], [2, 0]]);
    assert.deepEqual(map.lines.filter((l) => l.choice).map((l) => l.id), [3]);
    assert.deepEqual(await (await fetch(`${s.base}/fit/line_map.json`)).json(), map);
    const jaGot = Buffer.from(await (await fetch(`${s.base}/assets/ja/text.json`)).arrayBuffer());
    assert.ok(jaGot.equals(w.jaText), "a language's file read out of its pack");
    assert.equal((await fetch(`${s.base}/`)).status, 200, "the game's page from the app");
    const folder = await (await fetch(`${s.base}/translator/api/folder`)).json();
    assert.deepEqual([folder.files, folder.language, folder.problems], [{}, null, []]);
  } finally { s.srv.kill(); rmSync(w.dir, { recursive: true, force: true }); }
});

test("the editor's writes: only from its page, only the folder's scene files, all or nothing, a line changed on disk refused", { skip: !python && "no python3" }, async () => {
  const w = app();
  const s = await serve(w);
  try {
    const { token } = await (await fetch(`${s.base}/translator/api/state`)).json();
    const H = { Host: `localhost:${s.port}`, Origin: `http://localhost:${s.port}`, "Content-Type": "application/json", "X-Translator-Token": token };
    const post = (data, headers = H, path = "/translator/api/save") => raw(s.port, { method: "POST", path, headers, body: JSON.stringify(data) }).then((r) => { let json = null; try { json = JSON.parse(r.body); } catch { /* (plain text) */ } return { ...r, json }; });
    const row = (id, text, extra = {}) => ({ id, text, status: "draft", ...extra });
    const save = (scene, changes) => post({ files: [{ scene, changes }] });
    const file = (scene) => readFileSync(join(w.tl, `${scene}.json`), "utf8");
    // refused before anything is read: another name for the machine, another page, no token, not JSON
    assert.equal((await raw(s.port, { headers: { Host: `evil.example:${s.port}` }, path: "/translator/api/state" })).status, 403);
    assert.equal((await post({}, { ...H, Host: `evil.example:${s.port}` })).status, 403);
    assert.equal((await post({}, { ...H, Origin: "http://evil.example" })).status, 403);
    assert.equal((await post({}, { ...H, Origin: undefined })).status, 403);
    assert.equal((await post({}, { ...H, "X-Translator-Token": "0".repeat(32) })).status, 403);
    assert.equal((await post({}, { ...H, "Content-Type": "text/plain" })).status, 415);
    assert.equal((await raw(s.port, { method: "POST", path: "/translator/api/save", headers: H, body: "{not json" })).status, 400);
    // refused: a scene the game has not, a path, a line its scene does not show, a bad status
    assert.equal((await save("../../etc", [])).status, 400);
    assert.equal((await save("NO_SUCH_SCENE", [{ id: 0, before: null, after: row(0, "x") }])).status, 400);
    const wrong = await save("QA_01", [{ id: 0, before: null, after: row(0, "x") }]);
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.errors[0], /does not show it \(01_00_ARC01_1 does\)/);
    assert.equal((await save("01_00_ARC01_1", [{ id: 1, before: null, after: { ...row(1, "x"), status: "done" } }])).status, 400);
    assert.equal(existsSync(join(w.tl, "QA_01.json")) || existsSync(join(w.tl, "01_00_ARC01_1.json")), false, "nothing written");
    // written: one row a line, in the order the scene shows them, whatever order they came in
    const third = row(2, "Sur le toit.", { from: { lang: "en", hash: sha12(w.en[2]) } });
    const first = row(0, "La lune est là.", { note: "à revoir" });
    let r = await save("01_00_ARC01_1", [{ id: 2, before: null, after: third }]);
    assert.equal(r.status, 200, r.body);
    r = await save("01_00_ARC01_1", [{ id: 0, before: null, after: first }]);
    assert.equal(r.status, 200, r.body);
    assert.equal(file("01_00_ARC01_1"), '{"scene": "01_00_ARC01_1", "lines": [\n'
      + '{"id": 0, "text": "La lune est là.", "status": "draft", "note": "à revoir"},\n'
      + `{"id": 2, "text": "Sur le toit.", "status": "draft", "from": {"lang": "en", "hash": "${sha12(w.en[2])}"}}\n]}\n`);
    // a line not as the editor loaded it is a conflict: nothing of the save is written, and the line as it is comes back
    const before = file("01_00_ARC01_1");
    r = await save("01_00_ARC01_1", [{ id: 1, before: null, after: row(1, "Un chat dort.") }, { id: 2, before: { ...third, text: "old" }, after: row(2, "x") }]);
    assert.equal(r.status, 409);
    assert.deepEqual(r.json.conflicts.map((c) => [c.id, c.current?.text]), [[2, "Sur le toit."]]);
    assert.equal(file("01_00_ARC01_1"), before);
    // a change keeps the row's keys in order, and keys the tool does not know
    writeFileSync(join(w.tl, "01_00_ARC01_1.json"), before.replace('"note": "à revoir"}', '"note": "à revoir", "who": "ana"}'));
    const loaded = JSON.parse(file("01_00_ARC01_1")).lines[0];
    r = await save("01_00_ARC01_1", [{ id: 0, before: loaded, after: { ...loaded, text: "La lune.", status: "reviewed" } }]);
    assert.equal(r.status, 200, r.body);
    assert.equal(file("01_00_ARC01_1").split("\n")[1], '{"id": 0, "text": "La lune.", "status": "reviewed", "note": "à revoir", "who": "ana"},');
    // the folder as the editor loads it, a broken file named and never written over
    writeFileSync(join(w.tl, "QA_01.json"), "<<<<<<< HEAD\n");
    const folder = await (await fetch(`${s.base}/translator/api/folder`)).json();
    assert.deepEqual(Object.keys(folder.files), ["01_00_ARC01_1"]);
    assert.match(folder.problems[0].error, /not JSON/);
    assert.equal((await save("QA_01", [{ id: 4, before: null, after: row(4, "Bonsoir.^") }])).status, 409);
    assert.equal(readFileSync(join(w.tl, "QA_01.json"), "utf8"), "<<<<<<< HEAD\n");
    // language.json
    r = await post({ before: null, after: { code: "xx", name: "Testish", breaks: "none", from: "en" } }, H, "/translator/api/language");
    assert.equal(r.status, 200, r.body);
    assert.equal(readFileSync(join(w.tl, "language.json"), "utf8"), '{\n "code": "xx",\n "name": "Testish",\n "breaks": "none",\n "from": "en"\n}\n');
    assert.equal((await post({ before: null, after: { code: "yy" } }, H, "/translator/api/language")).status, 409, "changed since");
    assert.equal((await post({ before: { code: "xx" }, after: { code: "Not a code" } }, H, "/translator/api/language")).status, 400);
    // and what it wrote builds
    rmSync(join(w.tl, "QA_01.json"));
    const out = execFileSync("python3", ["-I", join(w.tool, "web-dev/tools/build_layer.py"), "xx", w.tl, "--app", w.www, "--out", join(w.dir, "out")], { encoding: "utf8" });
    assert.match(out, /xx: 2 lines translated/);
    assert.deepEqual(JSON.parse(readFileSync(join(w.dir, "out", "text.json"), "utf8")), ["La lune.", w.en[1], "Sur le toit.", w.en[3], w.en[4], w.en[5]]);
  } finally { s.srv.kill(); rmSync(w.dir, { recursive: true, force: true }); }
});

test("the draft: the folder laid over the English at /assets/draft/, and the app's language table given a draft row (the app's file unchanged)", { skip: !python && "no python3" }, async () => {
  const w = app();
  writeFileSync(join(w.tl, "language.json"), JSON.stringify({ code: "xx", name: "Testish" }));
  writeFileSync(join(w.tl, "01_00_ARC01_1.json"), JSON.stringify({ scene: "01_00_ARC01_1", lines: [{ id: 0, text: "La lune.", status: "draft" },
    { id: 1, text: "Pas encore.", status: "empty" }, { id: 2, text: "", status: "draft" }] }));
  writeFileSync(join(w.tl, "QA_01.json"), JSON.stringify({ scene: "QA_01", lines: [{ id: 4, text: "Bonsoir.^", status: "final" }] }));
  const s = await serve(w);
  try {
    assert.deepEqual(await (await fetch(`${s.base}/assets/draft/index.json`)).json(), { files: ["text.json"] });
    assert.deepEqual(await (await fetch(`${s.base}/assets/draft/text.json`)).json(), ["La lune.", w.en[1], w.en[2], w.en[3], "Bonsoir.^", w.en[5]]);
    assert.equal((await fetch(`${s.base}/assets/draft/other.json`)).status, 404);
    const served = await (await fetch(`${s.base}/js/languages.js`)).text();
    const own = readFileSync(join(w.www, "js", "languages.js"), "utf8");
    assert.equal(readFileSync(join(ROOT, "web/app/js/languages.js"), "utf8"), own, "the app's file is not changed");
    const mod = await import(`data:text/javascript;base64,${Buffer.from(served).toString("base64")}`);
    const real = await import(`data:text/javascript;base64,${Buffer.from(own).toString("base64")}`);
    assert.deepEqual(mod.codesOf(), [...real.codesOf(), "draft"]);
    assert.deepEqual(mod.layersOf("draft"), ["draft"]);
    assert.equal(mod.scriptsOf("draft"), "en");
    assert.equal(mod.htmlLangOf("draft"), "xx");
    assert.deepEqual(mod.deviceCodes(), real.deviceCodes(), "no device starts in the draft");
    assert.deepEqual(mod.langDirsOf(), real.langDirsOf(), "the apps never download it");
    assert.equal((await (await fetch(`${s.base}/translator/api/state`)).json()).play, true);
  } finally { s.srv.kill(); }
  // an app from before the language table: no draft to play, and its page files as they are
  rmSync(join(w.www, "js", "languages.js"));
  const s2 = await serve(w);
  try {
    assert.equal((await (await fetch(`${s2.base}/translator/api/state`)).json()).play, false);
    assert.equal((await fetch(`${s2.base}/js/languages.js`)).status, 404);
  } finally { s2.srv.kill(); rmSync(w.dir, { recursive: true, force: true }); }
});

test("checks (Stage 4): the whole folder as a build checks it, and each saved line's own checks in the save's answer", { skip: !python && "no python3" }, async () => {
  const w = app();
  writeFileSync(join(w.tl, "01_00_ARC01_1.json"), JSON.stringify({ scene: "01_00_ARC01_1", lines: [{ id: 0, text: "La lune\tbrille.", status: "draft" },
    { id: 1, text: "Un chat、dort.", status: "draft" }, { id: 2, text: "On the roof.", status: "draft" }] }));
  const s = await serve(w);
  try {
    const r = await (await fetch(`${s.base}/translator/api/check`)).json();
    const got = r.findings.map((f) => [f.level, f.kind, f.id]);
    assert.deepEqual(got.filter((f) => f[0] !== "note"), [["error", "bad character", 0], ["warning", "Japanese letters left in", 1], ["warning", "source left in", 2]]);
    assert.deepEqual(r.untranslated, { lines: 2, of: 5, scenes: 2 });
    const { token } = await (await fetch(`${s.base}/translator/api/state`)).json();
    const folder = await (await fetch(`${s.base}/translator/api/folder`)).json();
    const before = folder.files["01_00_ARC01_1"][0];
    const save = await raw(s.port, { method: "POST", path: "/translator/api/save", body: JSON.stringify({ files: [{ scene: "01_00_ARC01_1", changes: [{ id: 0, before, after: { ...before, text: "La lune brille: ș." } }] }] }),
      headers: { Host: `localhost:${s.port}`, Origin: `http://localhost:${s.port}`, "Content-Type": "application/json", "X-Translator-Token": token } });
    assert.equal(save.status, 200, save.body);
    assert.deepEqual(JSON.parse(save.body).findings, { 0: [["warning", "a letter the story face lacks", "ș (U+0219): drawn from another face where Georgia is not (Android)"]] });
  } finally { s.srv.kill(); rmSync(w.dir, { recursive: true, force: true }); }
});

// (the port's repository has the fonts; the translator's own repository has only the map made from them)
test("story-font-cover.json is what the bundled story faces map (node web-dev/tools/font_cover.mjs)", { skip: !existsSync(join(ROOT, "web/app/fonts/Gelasio-Latin-Variable.woff2")) && "no web/app fonts here" }, async () => {
  const { cover } = await import("../tools/font_cover.mjs");
  const file = JSON.parse(readFileSync(join(ROOT, "web-dev/tools/story-font-cover.json"), "utf8"));
  assert.deepEqual(file, cover());
});

// ---- Stage 5: translation memory and the glossary ----------------------------------------------------------------------------------------
test("memory: a line's source as words; the same source elsewhere, and close ones best first", async () => {
  const { Memory, wordsOf, dice } = await import("../translator/memory.js");
  assert.equal(wordsOf(`@g${I("The")} <moon|tsuki> is\nout.^[ber00]`), "The moon is out.");
  const src = ["The moon is out tonight.", "The moon is out tonight.", "The moon was out tonight.", "A cat sleeps on the roof.", "The moon is out tonight!", "x"];
  const mem = new Memory(src, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(mem.same(0), [1]);
  assert.deepEqual(mem.same(3), []);
  const like = mem.like(0);
  assert.deepEqual(like.map((x) => x.id), [4, 2], "the same line is not 'like', the closest first, the cat not at all");
  assert.ok(like[0].score > like[1].score && like[1].score >= 0.6);
  assert.deepEqual(mem.like(0, (id) => id !== 4).map((x) => x.id), [2], "only the lines asked for (the translated ones)");
  assert.deepEqual(mem.like(5), [], "too short to be like anything");
  assert.equal(dice(new Set(["abc"]), new Set(["abc"])), 1);
});

test("glossary: a term found in a line's sources, as a word where words are spaced; its translation or another form in the line", async () => {
  const { termsIn, hasTarget, formPattern } = await import("../translator/memory.js");
  const terms = [{ ja: "先生", en: "sensei", target: "professora", also: ["professor"] }, { en: "moon", target: "lua" }, { en: "", target: "x" }];
  const sources = { ja: ["シエル先生です。", "月です。"], en: ["I am Ciel-sensei.", "The honeymoon."] };
  assert.deepEqual(termsIn(terms, sources, 0).map((x) => [x.lang, x.form]), [["ja", "先生"]]);
  assert.deepEqual(termsIn(terms, sources, 1), [], "'moon' is not a word of 'honeymoon'");
  assert.equal(hasTarget(terms[0], "Sou a Professor Ciel."), true);
  assert.equal(hasTarget(terms[0], "Sou a Ciel."), false);
  assert.equal(formPattern("en", "Ciel").test("ciel's"), true);
});

test("glossary.json: saved whole, one term a row, conflicts refused; read back with the folder; its warnings in the checks", { skip: !python && "no python3" }, async () => {
  const w = app();
  writeFileSync(join(w.tl, "01_00_ARC01_1.json"), JSON.stringify({ scene: "01_00_ARC01_1", lines: [{ id: 1, text: "Un félin dort.", status: "draft" },
    { id: 2, text: "Sur le toit, le chat.", status: "draft" }, { id: 0, text: "La lune est là.", status: "draft" }] }));
  const s = await serve(w);
  try {
    const { token } = await (await fetch(`${s.base}/translator/api/state`)).json();
    const post = (data) => raw(s.port, { method: "POST", path: "/translator/api/glossary", body: JSON.stringify(data),
      headers: { Host: `localhost:${s.port}`, Origin: `http://localhost:${s.port}`, "Content-Type": "application/json", "X-Translator-Token": token } });
    const after = { terms: [{ en: "cat", target: "chat", note: "invented" }, { ja: "月", target: "lune", also: ["lunaire"] }] };
    let r = await post({ before: null, after });
    assert.equal(r.status, 200, r.body);
    assert.equal(readFileSync(join(w.tl, "glossary.json"), "utf8"), '{"terms": [\n{"en": "cat", "target": "chat", "note": "invented"},\n{"ja": "月", "target": "lune", "also": ["lunaire"]}\n]}\n');
    assert.equal((await post({ before: null, after })).status, 409, "changed since it was loaded");
    assert.equal((await post({ before: after, after: { terms: [{ en: 3, target: "x" }] } })).status, 400);
    assert.equal((await post({ before: after, after: { terms: [{ "../x": "y", target: "x" }] } })).status, 400);
    const folder = await (await fetch(`${s.base}/translator/api/folder`)).json();
    assert.deepEqual(folder.glossary, after);
    assert.deepEqual(Object.keys(folder.files), ["01_00_ARC01_1"], "glossary.json is not a scene");
    assert.deepEqual(folder.problems, []);
    // line 1's English has "cat" and its translation no "chat"; line 2 ("On the roof.") is glued to it and has it: one message, no warning
    const check = await (await fetch(`${s.base}/translator/api/check`)).json();
    assert.deepEqual(check.findings.filter((f) => f.kind === "glossary").map((f) => [f.id, f.what]), []);
    writeFileSync(join(w.tl, "01_00_ARC01_1.json"), JSON.stringify({ scene: "01_00_ARC01_1", lines: [{ id: 1, text: "Un félin dort.", status: "draft" },
      { id: 2, text: "Sur le toit.", status: "draft" }, { id: 0, text: "Il fait nuit.", status: "draft" }] }));
    const check2 = await (await fetch(`${s.base}/translator/api/check`)).json();
    assert.deepEqual(check2.findings.filter((f) => f.kind === "glossary").map((f) => [f.id, f.what.replace(/^.*?: /, "")]),
      [[1, "cat (en) is chat here"], [2, "cat (en) is chat here"], [0, "月 (ja) is lune (or lunaire) here"]]);
  } finally { s.srv.kill(); rmSync(w.dir, { recursive: true, force: true }); }
});

test("an installed desktop app as it is: its data folder's update first (newer page files, a language downloaded in packs), then its www; a .app", { skip: !python && "no python3" }, async () => {
  const w = app();
  const id = "0123456789ab-01234567";
  const data = join(w.dir, "Tsukihime-data"), files = join(data, "update", id, "files");
  mkdirSync(join(files, "assets", "ja", "pack"), { recursive: true });
  // the downloaded Japanese lives in the update, in packs; the www keeps only its own (move the fixture's pack there)
  for (const f of readdirSync(join(w.www, "assets", "ja", "pack"))) writeFileSync(join(files, "assets", "ja", "pack", f), readFileSync(join(w.www, "assets", "ja", "pack", f)));
  rmSync(join(w.www, "assets", "ja"), { recursive: true });
  writeFileSync(join(files, "index.html"), "<!doctype html><title>updated</title>");
  writeFileSync(join(data, "update", "state.json"), JSON.stringify({ bundle: "x", current: id, confirmed: true }));
  const start = async (...apps) => {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const srv = spawn("python3", ["-I", join(w.tool, "web-dev/tools/dev_server.py"), String(port), ...apps.flatMap((a) => ["--app", a]), "--translations", w.tl], { stdio: ["ignore", "pipe", "pipe"] });
    let said = "", err = "";
    srv.stderr.on("data", (d) => { err += d; });
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`no start: ${err}`)), 15000);
      srv.stdout.on("data", (d) => { said += d; if (/translations:/.test(said)) { clearTimeout(t); res(); } });
      srv.on("exit", (c) => rej(new Error(`exited ${c}: ${err}`)));
    });
    return { srv, base: `http://localhost:${port}`, said };
  };
  let s = await start(data, w.www);
  try {
    assert.match(s.said, new RegExp(`update ${id} of .*Tsukihime-data; app files .*www`));
    assert.match(await (await fetch(`${s.base}/`)).text(), /updated/, "the update's page file first");
    assert.ok(Buffer.from(await (await fetch(`${s.base}/assets/ja/text.json`)).arrayBuffer()).equals(w.jaText), "Japanese out of the update's pack");
    assert.deepEqual((await (await fetch(`${s.base}/translator/api/state`)).json()).languages, ["en", "ja"]);
    assert.equal((await fetch(`${s.base}/assets/text.json`)).status, 200, "the rest from the www");
  } finally { s.srv.kill(); }
  // an app that never took an update: its data folder is skipped, and the www plays
  writeFileSync(join(data, "update", "state.json"), JSON.stringify({ bundle: "x", current: null }));
  s = await start(data, w.www);
  try {
    assert.match(s.said, /no update in use \(skipped\)/);
    assert.match(await (await fetch(`${s.base}/`)).text(), /<title>game<\/title>/);
    assert.deepEqual((await (await fetch(`${s.base}/translator/api/state`)).json()).languages, ["en"], "no Japanese: it was in the update");
  } finally { s.srv.kill(); }
  // a Mac app named itself: its Contents/Resources/www
  const mac = join(w.dir, "Tsukihime.app", "Contents", "Resources");
  mkdirSync(mac, { recursive: true });
  execFileSync("cp", ["-R", w.www, join(mac, "www")]);
  s = await start(join(w.dir, "Tsukihime.app"));
  try {
    assert.match(s.said, /app files .*Tsukihime\.app\/Contents\/Resources\/www/);
    assert.equal((await fetch(`${s.base}/assets/text.json`)).status, 200);
  } finally { s.srv.kill(); rmSync(w.dir, { recursive: true, force: true }); }
});

test("the translator app (Tsukihime Translator.exe, web-dev/translator-app) packs every file the tool's server loads", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "web-dev/translator-app/package.json"), "utf8"));
  const base = join(ROOT, "web-dev/translator-app");
  const packed = new Set();
  for (const e of pkg.build.extraResources) {
    const from = join(base, e.from);
    const to = e.to.replace(/^tool\//, "");
    if (!e.filter) { packed.add(to); continue; }
    const glob = (pat) => new RegExp(`^${pat.replace(/[.]/g, "\\.").replace(/\*/g, "[^/]*")}$`);
    for (const f of readdirSync(from)) if (e.filter.some((p) => glob(p).test(f))) packed.add(`${to}/${f}`);
  }
  for (const f of TOOL) assert.ok(packed.has(f), `the app does not pack ${f}`);
  assert.ok(pkg.build.win.extraResources.some((e) => e.to === "python"), "the Windows app carries Python");
  const main = readFileSync(join(base, "main.js"), "utf8");
  assert.match(main, /path\.join\(root, "web-dev", "tools", "dev_server\.py"\)/, "the server from the tool in use (an update, or the app's own)");
  assert.match(main, /"-I", "-X", "utf8"/, "the bundled Python run isolated and in UTF-8");
});

test("every mark carries an explanation for the pointer (data-tip), the game's own reading of it", async () => {
  const { markTip, toHTML } = await import("../translator/markup.js");
  assert.match(markTip("@k"), /next message continues this one/);
  assert.match(markTip("@g"), /second face/);
  assert.match(markTip("@t"), /side by side/);
  assert.match(markTip("@x"), /row of the one before/);
  assert.match(markTip("@c3"), /colour 3/);
  assert.match(markTip("@c7"), /dark grey outline/);
  assert.match(markTip("[ber00]"), /noise bar/);
  assert.match(markTip("@q"), /the English never uses it/);
  const html = toHTML(`@k <a|b> ^ \n [zap00] \ue0c1 \ue3ff`);
  assert.equal((html.match(/data-tip="/g) || []).length, 7, "each mark, the ruby, the row break, the line break, the tag, the face, the soft break");
  assert.doesNotMatch(html, /\btitle="/, "no browser title tooltip on top of it");
});

test("Help: in the main area, never by itself, its buttons the bar's own, every mark it lists explained; the app keeps its port so the page's settings last", async () => {
  const html = readFileSync(join(ROOT, "web-dev/translator/index.html"), "utf8");
  const js = readFileSync(join(ROOT, "web-dev/translator/editor.js"), "utf8");
  assert.match(html, /<main id="main">\s*<section id="home" class="home" hidden aria-label="Help">/, "Help is in the main area, hidden to begin with");
  assert.match(html, /<button id="b-home"[^>]*>Help<\/button>/);
  const page = js.slice(js.indexOf("// ---- help ----"), js.indexOf("// ---- start ----"));
  assert.ok(page.length > 1000, "Help's code");
  const start = js.slice(js.indexOf("async function start()"));
  assert.doesNotMatch(start, /showHome\(true\)/, "the editor never opens on Help (user, 2026-11-17)");
  // the buttons it names are the bar's own (it shows their own titles, and a click is theirs)
  const ids = [...page.matchAll(/"(b-[a-z]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 7);
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `${id} is in the bar`);
  // the marks it lists: each explained (the same tips as in the edit box)
  const { toHTML, ruby } = await import("../translator/markup.js");
  const list = /const SAMPLE_MARKS = \[(.*)\];/.exec(page)[1];
  const marks = [...list.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).filter((m) => m !== "star" && m !== "hoshi");
  assert.ok(marks.length >= 10);
  for (const m of [...marks, ruby("star", "hoshi")]) assert.match(toHTML(m), /data-tip="[^"]+"/, `${JSON.stringify(m)} is explained`);
  // a chosen scene gives way to it; the address names no scene while it is up
  for (const caller of [/\.scene"\);\s*if \(sc\) \{ goScene\(/, /goScene\(Number\(res\.dataset\.s\)/, /if \(s !== undefined\) goScene\(s, id\)/]) assert.match(js, caller);
  // the app: the port of last time where it is free (the page's storage belongs to http://localhost:PORT)
  const main = readFileSync(join(ROOT, "web-dev/translator-app/main.js"), "utf8");
  assert.match(main, /const last = Number\(settings\.port\);/);
  assert.match(main, /await tryPort\(last\)\) \|\| await tryPort\(0\)/);
  assert.match(main, /settings\.port = port; saveSettings\(\);/);
});
