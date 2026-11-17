// web-dev/tools/exchange.py (the translator tool's Stage 6): a translations folder out to CSV, PO, XLIFF and deepLuna's readable format and back,
// on an invented copy of an installed app (no line of the game's); the faces' tags read back over every line of the game's texts this checkout has.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const TOOL = join(ROOT, "web-dev/tools/exchange.py");
const python = (() => { try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const I = (s) => s.replace(/[\x20-\x7e]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xe000));

// An app (www: index.html and assets/) of six invented lines in two scenes, and an empty translations folder.
function world() {
  const dir = mkdtempSync(join(tmpdir(), "exchange-"));
  const www = join(dir, "www"), tl = join(dir, "tl");
  const en = ["The moon is out.", "A cat sleeps.", "On the roof.", " Go home.", "Good evening.^", "unused"];
  const ja = ["月が出ている。", "猫が寝ている。", "屋根の上で。", "帰る。", "こんばんは。^", "未使用"];
  mkdirSync(join(www, "assets", "scripts"), { recursive: true });
  mkdirSync(join(www, "assets", "ja"), { recursive: true });
  mkdirSync(tl);
  writeFileSync(join(www, "index.html"), "<!doctype html>");
  writeFileSync(join(www, "assets", "text.json"), JSON.stringify(en));
  writeFileSync(join(www, "assets", "ja", "text.json"), JSON.stringify(ja));
  writeFileSync(join(www, "assets", "scripts", "index.json"), JSON.stringify({ names: ["START_SCRIPT", "01_00_ARC01_1", "QA_01"], jump: {}, start: 0 }));
  const script = (ops) => JSON.stringify({ ops, labels: {} });
  writeFileSync(join(www, "assets", "scripts", "0.json"), script([["END_"]]));
  writeFileSync(join(www, "assets", "scripts", "1.json"), script([["MSG", "$000000"], ["WKST", "F823", "eq", "0"], ["MSG", "$000001"], ["MSAD", "$000002"],
    ["WKST", "F823", "eq", "0"], ["SELR", "$000003"], ["SELD"], ["END_"]]));
  writeFileSync(join(www, "assets", "scripts", "2.json"), script([["MSG", "$000004"], ["WKST", "F823", "eq", "0"], ["END_"]]));
  return { dir, www, tl, en, ja };
}
const run = (...args) => spawnSync("python3", ["-I", TOOL, ...args], { encoding: "utf8" });
const scene = (folder, name, lines) => writeFileSync(join(folder, `${name}.json`), JSON.stringify({ scene: name, lines }));
const rows = (folder) => Object.fromEntries(readdirSync(folder).filter((f) => f.endsWith(".json") && f !== "language.json")
  .flatMap((f) => JSON.parse(readFileSync(join(folder, f), "utf8")).lines.map((r) => [r.id, { ...r, file: f }])));

test("the faces as tags and back: every sample, and every line of the game's texts here", { skip: !python && "no python3" }, () => {
  const samples = [`a ${I("Bold")} b`, `${I("two words")} ${I("x")}`, "\ue0c1\ue0c2 \ue141 \ue1c1 \ue2c1 \ue200 \ue3fe\ue3ff", "<cat|neko> @g [ber00] ^", "plain"];
  const texts = ["text.json", "ja/text.json", "zh/text.json", "aniplex/text.json", "pt/text.json"].map((f) => join(ROOT, "web/assets", f)).filter(existsSync);
  const code = `import importlib.util, json, sys
s = importlib.util.spec_from_file_location("x", ${JSON.stringify(TOOL)}); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
lines = json.loads(sys.stdin.read())
for f in ${JSON.stringify(texts)}:
    lines += json.load(open(f, encoding="utf-8"))
bad = [l for l in lines if m.from_tags(m.to_tags(l)) != l]
print(json.dumps({"n": len(lines), "bad": bad[:3], "tags": m.to_tags(lines[0]), "codes": m.to_codes(lines[0])}))`;
  const r = JSON.parse(execFileSync("python3", ["-I", "-c", code], { input: JSON.stringify(samples), encoding: "utf8", maxBuffer: 1 << 26 }));
  assert.deepEqual(r.bad, []);
  assert.equal(r.tags, "a <i>Bold</i> b");
  assert.equal(r.codes, "a %{i}Bold%{/i} b");
  const err = spawnSync("python3", ["-I", "-c", `import importlib.util
s = importlib.util.spec_from_file_location("x", ${JSON.stringify(TOOL)}); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
m.from_tags("<i>open")`], { encoding: "utf8" });
  assert.match(err.stderr, /<i> not closed/);
});

test("CSV, PO and XLIFF out and back in: every line, its status, note and file as they were", { skip: !python && "no python3" }, () => {
  const w = world();
  try {
    writeFileSync(join(w.tl, "language.json"), JSON.stringify({ code: "xx", name: "Testish", from: "ja" }));
    const lines = [{ id: 0, text: `La ${I("lune")} @kest là.`, status: "final" }, { id: 1, text: "Un <chat|neko> dort,\nlà.", status: "reviewed", note: "a \"note\"\nof two rows" },
      { id: 2, text: "Sur le toit ; 100 % \\ ok.", status: "draft" }, { id: 3, text: " Rentrer.", status: "draft" }];
    scene(w.tl, "01_00_ARC01_1", lines);
    scene(w.tl, "QA_01", [{ id: 4, text: "Bonsoir.^", status: "final" }]);
    for (const fmt of ["csv", "po", "xliff"]) {
      const file = join(w.dir, `out.${fmt}`), back = join(w.dir, `back-${fmt}`);
      let r = run("export", fmt, w.tl, file, "--app", w.www);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /5 lines/);
      mkdirSync(back);
      writeFileSync(join(back, "language.json"), JSON.stringify({ code: "xx", from: "ja" }));
      r = run("import", fmt, file, back, "--app", w.www);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /placed 5 lines in 2 scene files; 0 were so already; 0 kept as they were; 0 not placed/, fmt);
      const a = rows(w.tl), b = rows(back);
      for (const id of [0, 1, 2, 3, 4]) {
        assert.equal(b[id].text, a[id].text, `${fmt} ${id}`);
        assert.equal(b[id].status, a[id].status, `${fmt} ${id} status`);
        assert.equal(b[id].note, a[id].note, `${fmt} ${id} note`);
        assert.equal(b[id].file, a[id].file, `${fmt} ${id} file`);
        assert.match(b[id].from.hash, /^[0-9a-f]{12}$/);
      }
      r = run("import", fmt, file, back, "--app", w.www);
      assert.match(r.stdout, /placed 0 lines in 0 scene files; 5 were so already/, `${fmt} again`);
    }
    const po = readFileSync(join(w.dir, "out.po"), "utf8");
    assert.match(po, /msgctxt "01_00_ARC01_1#0"\nmsgid "月が出ている。"\nmsgstr "La <i>lune<\/i> @kest là."/);
    assert.match(po, /#, fuzzy\nmsgctxt "01_00_ARC01_1#2"/);
    assert.match(readFileSync(join(w.dir, "out.xliff"), "utf8"), /<target state="final">La <g id="1" ctype="italic">lune<\/g> @kest là\.<\/target>/);
    assert.ok(readFileSync(join(w.dir, "out.csv"), "utf8").startsWith("\ufeffid,scene,page,status,ja,en,text,note\n"));
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("deepLuna's readable format out and back: the faces as its codes; what it cannot hold is named", { skip: !python && "no python3" }, () => {
  const w = world();
  try {
    scene(w.tl, "01_00_ARC01_1", [{ id: 0, text: `La ${I("lune")}^est là.`, status: "draft" }, { id: 1, text: "-- un chat", status: "draft" }]);
    const out = join(w.dir, "dl");
    let r = run("export", "deepluna", w.tl, out, "--app", w.www);
    assert.match(r.stdout, /1 lines cannot be read back .*: 1/);
    assert.equal(readFileSync(join(out, "01_00_ARC01_1.txt"), "utf8").split("\n").slice(0, 5).join("\n"),
      "// en: The moon is out.\n// ja: 月が出ている。\n[offset:0]{\nLa %{i}lune%{/i}^est là.\n}");
    const back = join(w.dir, "back");
    mkdirSync(back);
    r = run("import", "deepluna", out, back, "--app", w.www);
    assert.match(r.stdout, /placed 1 lines/);
    assert.equal(rows(back)[0].text, `La ${I("lune")}^est là.`);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("import: by line number, else by source text; what was there kept unless --overwrite; what cannot be placed, and why; --dry-run", { skip: !python && "no python3" }, () => {
  const w = world();
  try {
    scene(w.tl, "01_00_ARC01_1", [{ id: 1, text: "Un chat dort.", status: "final" }]);
    const po = join(w.dir, "other.po");
    writeFileSync(po, ['msgid ""', 'msgstr ""', '"Content-Type: text/plain; charset=UTF-8\\n"', "",
      'msgid "The moon is out."', 'msgstr "La lune est sortie."', "",                       // no msgctxt: laid where the English is this
      '#, fuzzy', 'msgctxt "x#1"', 'msgid "A cat sleeps."', 'msgstr "Un félin dort."', "",  // line 1 has another translation
      'msgctxt "x#5"', 'msgid "unused"', 'msgstr "inutilisé"', "",                          // the scripts never show line 5
      'msgctxt "x#99"', 'msgid "?"', 'msgstr "?"', "",
      'msgctxt "x#2"', 'msgid "On the roof."', 'msgstr "Sur le <i>toit"', "",               // a tag not closed
      'msgid "Not a line of the game."', 'msgstr "Pas une ligne."', ""].join("\n"));
    let r = run("import", "po", po, w.tl, "--app", w.www, "--dry-run");
    assert.match(r.stdout, /would place 1 lines in 1 scene files; 0 were so already; 1 kept as they were; 4 not placed/);
    assert.match(r.stdout, /kept: entry at line \d+: line 1 has another translation already/);
    assert.match(r.stdout, /line 5: the scripts show no such line/);
    assert.match(r.stdout, /line 99: no such line/);
    assert.match(r.stdout, /its tags: <i> not closed/);
    assert.match(r.stdout, /no line number, and its source is no line of the game/);
    assert.deepEqual(Object.keys(rows(w.tl)), ["1"], "a dry run writes nothing");
    r = run("import", "po", po, w.tl, "--app", w.www, "--overwrite");
    assert.match(r.stdout, /placed 2 lines/);
    const got = rows(w.tl);
    assert.deepEqual([got[0].text, got[0].status, got[1].text, got[1].status], ["La lune est sortie.", "reviewed", "Un félin dort.", "draft"]);
    // another tool's XLIFF 2.0: <unit id> with a <segment>
    const x2 = join(w.dir, "two.xlf");
    writeFileSync(x2, `<?xml version="1.0"?><xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="en" trgLang="fr"><file id="f">
      <unit id="3"><segment state="final"><source> Go home.</source><target> Rentrer, <pc id="1">vite</pc>.</target></segment></unit></file></xliff>`);
    r = run("import", "xliff", x2, w.tl, "--app", w.www);
    assert.match(r.stdout, /placed 1 lines/);
    assert.deepEqual([rows(w.tl)[3].text, rows(w.tl)[3].status], [" Rentrer, vite.", "final"]);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

// A game patch's script_text.mrg (mrgd00: entries of offset tables and texts, a pair a language), its first language as given.
function mrg(lines) {
  const text = Buffer.from(lines.join("\r\n"), "utf8");
  const table = Buffer.alloc(4 * lines.length);
  const entries = [table, text, Buffer.alloc(4), Buffer.from("x")];
  const head = 8 + 8 * entries.length;
  const out = [Buffer.from("mrgd00"), Buffer.from([entries.length, 0])];
  let at = 0;
  const dir = Buffer.alloc(8 * entries.length);
  const body = [];
  entries.forEach((e, k) => {
    dir.writeUInt16LE(Math.floor(at / 0x800), 8 * k);
    dir.writeUInt16LE(at % 0x800, 8 * k + 2);
    dir.writeUInt16LE(Math.ceil(e.length / 0x800), 8 * k + 4);
    dir.writeUInt16LE(e.length % 0x800, 8 * k + 6);
    body.push(e);
    at += e.length;
  });
  return Buffer.concat([...out, dir, ...body]);
}

test("a whole built text in (text.json, a patch's script_text.mrg): English and Japanese lines left, a line the same in both kept on a translated page", { skip: !python && "no python3" }, () => {
  const w = world();
  try {
    // line 0 translated, line 1 the same as the English on line 0's page? (no: its own page), 2 still Japanese, 3 the same as the English on a
    // translated page (3 is a choice on page 2 with nothing else: left), 4 translated
    const es = ["La luna ha salido.", "A cat sleeps.", "屋根の上で。", " Go home.", "Buenas noches.^", "unused"];
    for (const [fmt, file, data] of [["textjson", "text.json", JSON.stringify(es)], ["mrg", "script_text.mrg", mrg(es)]]) {
      const tl = join(w.dir, `tl-${fmt}`);
      mkdirSync(tl);
      writeFileSync(join(w.dir, file), data);
      const r = run("import", fmt, join(w.dir, file), tl, "--app", w.www);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /placed 2 lines/, fmt);
      assert.match(r.stdout, /left out: 2 lines that are the English's \(on pages not translated\), 1 lines still in Japanese/, fmt);
      assert.deepEqual(Object.fromEntries(Object.entries(rows(tl)).map(([k, v]) => [k, v.text])), { 0: es[0], 4: es[4] }, fmt);
    }
    // the same line in both, on a page with a translated line, is the translation's: line 1 shares page 1 with line 2
    const es2 = ["La luna ha salido.", "A cat sleeps.", "Sobre el tejado.", " Go home.", "Buenas noches.^", "unused"];
    writeFileSync(join(w.dir, "two.json"), JSON.stringify(es2));
    const tl2 = join(w.dir, "tl-two");
    mkdirSync(tl2);
    const r = run("import", "textjson", join(w.dir, "two.json"), tl2, "--app", w.www);
    assert.match(r.stdout, /taken: 1 lines the same as the English on translated pages/);
    assert.equal(rows(tl2)[1].text, "A cat sleeps.");
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});
