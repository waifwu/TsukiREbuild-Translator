// web-dev/tools/build_layer.py (the translator tool's Stage 1): a translations folder laid over the English -> a language folder, with the checks that
// stop a build. On an invented miniature text (no line of the game's), so it runs anywhere python3 does.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOOL = new URL("../../web-dev/tools/build_layer.py", import.meta.url).pathname;
const python = (() => { try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const hash = (s) => createHash("sha1").update(s, "utf8").digest("hex").slice(0, 12);

// A root with a five-line English (line 3 a choice, line 4 never shown), its "Japanese", and a line map of two scenes.
function world() {
  const root = mkdtempSync(join(tmpdir(), "layer-"));
  const english = ["The moon is out.", "A <cat|neko> sleeps.\nOn the roof.", "@gQuiet@g night.", " Go home.", "unused"];
  const ja = ["月が出ている。", "猫が寝ている。", "静かな夜。", "帰る。", "未使用"];
  mkdirSync(join(root, "web", "assets", "ja"), { recursive: true });
  writeFileSync(join(root, "web", "assets", "text.json"), JSON.stringify(english));
  writeFileSync(join(root, "web", "assets", "ja", "text.json"), JSON.stringify(ja));
  const map = { scenes: [{ name: "01_00_ARC01_1" }, { name: "QA_01" }], unnamed: [4],
    lines: [{ id: 0, at: [{ s: 0 }] }, { id: 1, at: [{ s: 0 }] }, { id: 2, at: [{ s: 1 }] }, { id: 3, at: [{ s: 0 }], choice: 1 }, { id: 4, at: [] }] };
  writeFileSync(join(root, "map.json"), JSON.stringify(map));
  const folder = join(root, "tl");
  mkdirSync(folder);
  return { root, folder, english, ja };
}
const scene = (folder, name, lines) => writeFileSync(join(folder, `${name}.json`), JSON.stringify({ scene: name, lines }));
const run = (w, ...extra) => spawnSync("python3", ["-I", TOOL, "xx", w.folder, "--root", w.root, "--map", join(w.root, "map.json"), "--out", join(w.root, "out"), ...extra], { encoding: "utf8" });

test("a translation is laid over the English: its lines where it has them, the English everywhere else", { skip: !python && "no python3" }, () => {
  const w = world();
  try {
    scene(w.folder, "01_00_ARC01_1", [{ id: 0, text: "La lune est là.", status: "draft", from: { lang: "ja", hash: hash(w.ja[0]) } },
      { id: 1, text: "", status: "empty" }, { id: 3, text: " Rentrer.", status: "final" }]);
    scene(w.folder, "QA_01", [{ id: 2, text: "@gNuit@g calme.\nTrès.", status: "reviewed" }]);   // (a corner keeps its rows)
    const r = run(w);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(readFileSync(join(w.root, "out", "text.json"), "utf8"));
    assert.deepEqual(out, ["La lune est là.", w.english[1], "@gNuit@g calme.\nTrès.", " Rentrer.", "unused"]);
    assert.deepEqual(JSON.parse(readFileSync(join(w.root, "out", "index.json"), "utf8")), { files: ["text.json"] });
    assert.match(r.stdout, /xx: 3 lines translated \(empty 1, draft 1, reviewed 1, final 1\); 2 in English/);
    assert.doesNotMatch(r.stdout, /warning/);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("an error in any line stops the build and writes nothing", { skip: !python && "no python3" }, () => {
  const cases = [
    [[{ id: 9, text: "x" }], /no such line/],
    [[{ id: 0, text: "a" }, { id: 0, text: "b" }], /given again/],
    [[{ id: 2, text: "x" }], /scene 01_00_ARC01_1 does not show this line \(QA_01 does\)/],
    [[{ id: 0, text: "a\tb" }], /a tab/],
    [[{ id: 0, text: "a%{n}b" }], /a deepLuna code/],
    [[{ id: 0, text: "a @q b" }], /marks the English never uses: @q/],
    [[{ id: 0, text: "a [heart] b" }], /marks the English never uses: \[heart\]/],
    [[{ id: 1, text: "a <cat b" }], /a ruby <base\|reading> not closed/],
    [[{ id: 1, text: "a <cat> b" }], /a ruby <base\|reading> not closed/],
    [[{ id: 0, text: "x", status: "done" }], /status 'done' is none of empty, draft, reviewed, final/],
  ];
  for (const [lines, why] of cases) {
    const w = world();
    try {
      scene(w.folder, "01_00_ARC01_1", lines);
      const r = run(w);
      assert.equal(r.status, 1, `${why}: ${r.stdout}`);
      assert.match(r.stdout, why);
      assert.match(r.stdout, /errors?: nothing written/);
      assert.equal(existsSync(join(w.root, "out")), false);
    } finally { rmSync(w.root, { recursive: true, force: true }); }
  }
  // no such folder, or no scene files in it: an error, not an English build over the language
  for (const make of [(w) => rmSync(w.folder, { recursive: true }), () => {}]) {
    const w = world();
    try {
      make(w);
      const r = run(w);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stdout, /no such folder|no scene files/);
      assert.equal(existsSync(join(w.root, "out")), false);
    } finally { rmSync(w.root, { recursive: true, force: true }); }
  }
  // a file not named after its scene
  const w = world();
  try {
    writeFileSync(join(w.folder, "wrong.json"), JSON.stringify({ scene: "01_00_ARC01_1", lines: [] }));
    const r = run(w);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /wrong\.json: the file of scene 01_00_ARC01_1 is named 01_00_ARC01_1\.json/);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("warnings: a stale source line, a line left as its source, a choice with a row break, a break in a story line, a line never shown", { skip: !python && "no python3" }, () => {
  const w = world();
  try {
    scene(w.folder, "01_00_ARC01_1", [
      { id: 0, text: "La lune.", status: "draft", from: { lang: "ja", hash: "000000000000" } },
      { id: 1, text: w.ja[1], status: "draft", from: { lang: "ja", hash: hash(w.ja[1]) } },
      { id: 3, text: " Ren-\ntrer.", status: "draft" },
      { id: 4, text: "jamais", status: "draft" },
    ]);
    const r = run(w, "--check");
    assert.equal(r.status, 0, r.stdout);
    for (const kind of ["stale: 1", "source left in: 1", "choice with a row break: 1", "line break in a story line: 1", "never shown: 1"]) assert.match(r.stdout, new RegExp(`warning: ${kind}`));
    assert.equal(existsSync(join(w.root, "out")), false, "--check writes nothing");
    // a deepLuna language's lines carry its row breaks: no warning for them
    writeFileSync(join(w.folder, "language.json"), JSON.stringify({ code: "xx", breaks: "deepluna" }));
    assert.doesNotMatch(run(w, "--check").stdout, /line break in a story line/);
    writeFileSync(join(w.folder, "language.json"), JSON.stringify({ code: "yy" }));
    assert.match(run(w, "--check").stdout, /language\.json is for 'yy', not 'xx'/);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("line_hash is the first 12 hex of the line's SHA-1, as importers write from.hash", { skip: !python && "no python3" }, () => {
  const got = execFileSync("python3", ["-I", "-c", `import importlib.util; s = importlib.util.spec_from_file_location("b", ${JSON.stringify(TOOL)}); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.line_hash("月が出ている。"))`], { encoding: "utf8" }).trim();
  assert.equal(got, hash("月が出ている。"));
});

// ---- Stage 4: the checks (build_layer.py Checker), on an invented scene of eight lines and a corner -----------------------------------------
// A font of the ASCII letters only, as the balloons' face (fonts/SeuratPro-M.otf): an sfnt with one cmap, format 4.
function asciiFont() {
  const segs = [[0x20, 0x7e, 1 - 0x20], [0xffff, 0xffff, 1]];
  const sub = Buffer.alloc(16 + segs.length * 8);
  sub.writeUInt16BE(4, 0); sub.writeUInt16BE(sub.length, 2); sub.writeUInt16BE(segs.length * 2, 6);
  segs.forEach(([a, b, d], k) => {
    sub.writeUInt16BE(b, 14 + 2 * k);
    sub.writeUInt16BE(a, 16 + 2 * segs.length + 2 * k);
    sub.writeInt16BE(d, 16 + 4 * segs.length + 2 * k);
    sub.writeUInt16BE(0, 16 + 6 * segs.length + 2 * k);
  });
  const cmap = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 3, 0, 1, 0, 0, 0, 12]), sub]);
  const head = Buffer.alloc(28);
  head.write("OTTO", 0, "latin1"); head.writeUInt16BE(1, 4); head.write("cmap", 12, "latin1"); head.writeUInt32BE(28, 20); head.writeUInt32BE(cmap.length, 24);
  return Buffer.concat([head, cmap]);
}
function world4() {
  const root = mkdtempSync(join(tmpdir(), "layer4-"));
  const english = ["\"Hello there,\" she said.", "\"Are you coming?\"", "\"Yes, I am.\"", "\"Then hurry.\"", "The night @kwas long.", "A [ber00][ber00] noise.",
    "Under the <moon|tsuki> again.", "We walk along the river.", "The corner opens.\n", "We walk along the river."];
  const ja = ["「やあ」と彼女は言った。", "「来るの？」", "「ええ、行くわ」", "「じゃあ急いで」", "長い夜だった。", "ノイズ。", "また月の下で。", "川沿いを歩く、ずっと遠くまで。",
    "コーナーが始まる。", "川沿いを歩く、ずっと遠くまで。"];
  mkdirSync(join(root, "web", "assets", "ja"), { recursive: true });
  mkdirSync(join(root, "web", "assets", "fonts"));
  writeFileSync(join(root, "web", "assets", "text.json"), JSON.stringify(english));
  writeFileSync(join(root, "web", "assets", "ja", "text.json"), JSON.stringify(ja));
  writeFileSync(join(root, "web", "assets", "fonts", "SeuratPro-M.otf"), asciiFont());
  const at = (s, pc, page) => [{ s, pc, nth: 0, page }];
  const map = { scenes: [{ name: "01_00_ARC01_1" }, { name: "QA_01" }], unnamed: [],
    pages: [{ s: 0, k: 0, a: 0, b: 5 }, { s: 0, k: 1, a: 5, b: 9 }, { s: 1, k: 0, a: 0, b: 2 }, { s: 0, k: 2, a: 9, b: 12 }],
    lines: [0, 1, 2, 3].map((i) => ({ id: i, at: at(0, i, 0) })).concat([4, 5, 6, 7].map((i) => ({ id: i, at: at(0, i + 1, 1) })),
      [{ id: 8, at: at(1, 0, 2) }, { id: 9, at: at(0, 10, 3) }]) };
  writeFileSync(join(root, "map.json"), JSON.stringify(map));
  const folder = join(root, "tl");
  mkdirSync(folder);
  return { root, folder, english, ja };
}

test("Stage 4: markup kept, Japanese left in, the faces' letters, quotes out of place, pages half translated, one source two ways", { skip: !python && "no python3" }, () => {
  const w = world4();
  try {
    scene(w.folder, "01_00_ARC01_1", [
      { id: 0, text: "Olá, disse ela.", status: "draft" },                   // quotes dropped: 0-3 in a row unlike the Japanese and the English
      { id: 1, text: "Vens?", status: "draft" },
      { id: 2, text: "Sim、vou.", status: "draft" },                         // a Japanese comma left in
      { id: 3, text: "Então despacha-te.", status: "draft" },
      { id: 4, text: "A noite foi longa.", status: "draft" },               // @k dropped
      { id: 5, text: "Um ruído [ber00].", status: "draft" },                // one tag of two
      { id: 6, text: "Outra vez sob a lua.", status: "draft" },             // the ruby dropped
      { id: 7, text: "Mergem de-a lungul râului, în ș.", status: "draft" }, // ș: not in the bundled story face
      { id: 9, text: "Mergem de-a lungul râului.", status: "draft" },       // the same Japanese line as 7, translated another way
    ]);
    scene(w.folder, "QA_01", [{ id: 8, text: "O canto abre-se: é.", status: "draft" }]);   // é: not in the balloons' face; no row break at the end
    const r = run(w, "--check");
    assert.equal(r.status, 0, r.stdout);
    const has = (kind, n, what) => {
      assert.match(r.stdout, new RegExp(`warning: ${kind}: ${n}\\b`), kind);
      if (what) assert.match(r.stdout, what, kind);
    };
    has("quote shape", 1, /lines 0 to 3 \(4 in a row\) open or close a quotation unlike the Japanese and the English/);
    has("Japanese letters left in", 1, /id 2: 、/);
    has("markup changed", 3, /@k: the English has 1, this has 0/);
    assert.match(r.stdout, /\[ber00\]: the English has 2, this has 1/);
    assert.match(r.stdout, /ruby: the English has some, this has none/);
    has("a letter the story face lacks", 1, /id 7: ș \(U\+0219\)/);
    has("a letter the balloons' face lacks", 1, /QA_01\.json id 8: é \(U\+00E9\)/);
    assert.doesNotMatch(r.stdout, /page partly translated/, "every line translated");
    assert.match(r.stdout, /notes: .*corner rows differ 1.*translated two ways 1/);
    assert.match(r.stdout, /untranslated: 0 of the 10 lines the scripts show, in 0 scenes/);
    assert.match(r.stdout, /no fit report \(--fit\)/);
    // a page half in English; and quotes the English drops too are the source's style, not a shift
    scene(w.folder, "01_00_ARC01_1", [{ id: 4, text: "A noite@k foi longa.", status: "draft" }, { id: 5, text: "", status: "empty" }]);
    const r2 = run(w, "--check");
    assert.match(r2.stdout, /warning: page partly translated: 1\n  01_00_ARC01_1\.json: 01_00_ARC01_1 page 2: 1 of 4 lines translated; in English: 5, 6, 7/);
    assert.doesNotMatch(r2.stdout, /markup changed|quote shape/);
    assert.match(r2.stdout, /untranslated: 8 of the 10 lines/);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("Stage 4: a build takes the fit runner's findings for exactly its text, and only on its own pages", { skip: !python && "no python3" }, () => {
  const w = world4();
  try {
    scene(w.folder, "01_00_ARC01_1", [{ id: 0, text: "\"Olá,\" disse ela.", status: "draft" }]);
    const built = [...w.english];
    built[0] = "\"Olá,\" disse ela.";
    const sha = createHash("sha1").update(JSON.stringify(built), "utf8").digest("hex");
    const report = (textSha1) => JSON.stringify({ textSha1, englishWidest: 1373.2, findings: [
      { kind: "page past 12 rows", page: 0, ids: [0, 1, 2, 3], what: "01_00_ARC01_1 page 1: 13 rows; 12 fit the screen" },
      { kind: "letters off a balloon", page: 2, ids: [8], what: "QA_01 page 1: 4 letter boxes off the balloon" }] });
    writeFileSync(join(w.root, "fit.json"), JSON.stringify(report(sha)));   // (as the Playwright MCP saves it: a JSON string)
    const r = run(w, "--check", "--fit", join(w.root, "fit.json"));
    assert.match(r.stdout, /warning: page past 12 rows: 1\n  01_00_ARC01_1 page 1: 13 rows/);
    assert.doesNotMatch(r.stdout, /letters off a balloon/, "a page all in English is the English's own");
    writeFileSync(join(w.root, "fit.json"), report("0".repeat(40)));
    assert.match(run(w, "--check", "--fit", join(w.root, "fit.json")).stdout, /warning: fit report out of date: 1/);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("faces the port does not draw: a private-use letter outside its banks, and mirrored letters where the English has none", { skip: !python && "no python3" }, () => {
  const w = world4();
  try {
    // U+E3E1: the Spanish patch's archaic á; U+E0E1: its italic á, which is the port's mirrored a
    scene(w.folder, "01_00_ARC01_1", [{ id: 4, text: "La noche@k fue \ue3e1larga.", status: "draft" }, { id: 7, text: "Caminamos \ue0e1 lo largo.", status: "draft" }]);
    const r = run(w, "--check");
    assert.match(r.stdout, /warning: a face the port does not draw: 1\n  01_00_ARC01_1\.json id 4: U\+E3E1/);
    assert.match(r.stdout, /warning: mirrored letters: 1\n  01_00_ARC01_1\.json id 7: U\+E0E1: the port draws a mirrored a for U\+E0E1; in a font of italic accents it is an italic á/);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});
