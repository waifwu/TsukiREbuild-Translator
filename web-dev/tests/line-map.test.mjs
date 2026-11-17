// The translator tool's Stage 0 (web-dev/TRANSLATOR-TOOL-PLAN.md): the line map (web-dev/tools/line_map.py -> web-dev/data/line_map.json), the page fit
// (web-dev/fit, served by web-dev/tools/dev_server.py) and its reports (web-dev/audit/fit-*.json). The map is checked against the scripts it was made
// from, which are not in the repository: those tests skip where web/assets is not there.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";

const at = (rel) => new URL(`../../${rel}`, import.meta.url);
const json = (rel) => JSON.parse(readFileSync(at(rel), "utf8"));
const MAP = "web-dev/data/line_map.json";
const assets = existsSync(at("web/assets/scripts/index.json")) && existsSync(at("web/assets/text.json"));
const mapThere = existsSync(at(MAP));
const map = mapThere ? json(MAP) : null;
const IDS = /\$(\d+)/g;
const TEXT_OPS = new Set(["MSG", "MSAD", "SELR"]);

let scripts = null;
function loadScripts() {
  if (!scripts) {
    const index = json("web/assets/scripts/index.json");
    scripts = index.names.map((_, i) => readFileSync(at(`web/assets/scripts/${i}.json`)));
  }
  return scripts;
}

// Every command that names a line, as the scripts have them: [line, script, pc, nth, op].
function commands() {
  const out = [];
  loadScripts().forEach((raw, s) => {
    JSON.parse(raw).ops.forEach((op, pc) => {
      if (!TEXT_OPS.has(op[0])) return;
      [...op.slice(1).join(",").matchAll(IDS)].forEach((m, nth) => out.push([Number(m[1]), s, pc, nth, op[0]]));
    });
  });
  return out;
}

test("the line map covers every line the scripts name, at every command that names it, and no other", { skip: !(assets && mapThere) && "no web/assets or line map" }, () => {
  const text = json("web/assets/text.json");
  assert.equal(map.lines.length, text.length);
  map.lines.forEach((ln, i) => assert.equal(ln.id, i));
  const want = new Map();
  for (const [id, s, pc, nth, op] of commands()) {
    if (!want.has(id)) want.set(id, []);
    want.get(id).push(`${s}:${pc}:${nth}:${op}`);
  }
  for (const ln of map.lines) {
    const got = ln.at.map((a) => `${a.s}:${a.pc}:${a.nth}:${a.op}`).sort();
    assert.deepEqual(got, (want.get(ln.id) || []).sort(), `line ${ln.id}`);
  }
  assert.deepEqual(map.unnamed, map.lines.filter((ln) => !ln.at.length).map((ln) => ln.id));
  assert.deepEqual(map.twice, map.lines.filter((ln) => ln.at.length > 1).map((ln) => ln.id));
  // as found on 2026-11-17: 43,906 lines named, 54 never, 22 by more than one command
  assert.equal(map.lines.length - map.unnamed.length, 43906);
  assert.equal(map.unnamed.length, 54);
  assert.equal(map.twice.length, 22);
});

test("the line map was made from these scripts (else run web-dev/tools/line_map.py again)", { skip: !(assets && mapThere) && "no web/assets or line map" }, () => {
  const h = createHash("sha1");
  for (const raw of loadScripts()) h.update(raw);
  assert.equal(map.source.sha1, h.digest("hex"));
  assert.equal(map.source.scripts_count, loadScripts().length);
  assert.equal(map.scenes.length, loadScripts().length);
  const names = json("web/assets/scripts/index.json").names;
  map.scenes.forEach((sc, i) => assert.equal(sc.name, names[i]));
  if (existsSync(at("web/assets/ja/scripts"))) {
    const own = readdirSync(at("web/assets/ja/scripts")).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.slice(0, -5))).sort((a, b) => a - b);
    assert.deepEqual(map.ja.scripts, own);
    assert.equal(own.length, 241);
  }
});

test("every line's page is one whose way through reaches its command; voices follow VPLY", { skip: !(assets && mapThere) && "no web/assets or line map" }, () => {
  const covers = (p, pc) => (p.runs || [[[p.a, p.b]]]).some((run) => run.some(([x, y]) => x <= pc && pc < y));
  let live = 0;
  for (const ln of map.lines) {
    for (const a of ln.at) {
      if (a.dead) { assert.equal(a.page, null); continue; }
      live++;
      const p = map.pages[a.page];
      assert.ok(p, `line ${ln.id}: page ${a.page}`);
      assert.equal(p.s, a.s, `line ${ln.id}`);
      assert.ok(covers(p, a.pc), `line ${ln.id} at ${a.s}:${a.pc} is not on page ${a.page}`);
    }
  }
  assert.ok(live > 43900);
  // the voice a VPLY names goes with the next message's lines (vm.js op_VPLY), 16,680 lines in all
  const voiced = new Map();
  loadScripts().forEach((raw) => {
    let v = null;
    for (const op of JSON.parse(raw).ops) {
      if (op[0] === "VPLY") v = op[1];
      else if (op[0] === "MSG" || op[0] === "MSAD") {
        if (v) for (const m of op.slice(1).join(",").matchAll(IDS)) voiced.set(Number(m[1]), v);
        v = null;
      }
    }
  });
  const mapped = new Map(map.lines.filter((ln) => ln.voice).map((ln) => [ln.id, ln.voice]));
  assert.deepEqual([...mapped].sort((a, b) => a[0] - b[0]), [...voiced].sort((a, b) => a[0] - b[0]));
  assert.equal(mapped.size, 16680);
  // choices are the SELR lines; glued lines are MSADs or @x messages
  const kinds = new Map(commands().map(([id, , , , op]) => [id, op]));
  for (const ln of map.lines) {
    if (ln.choice) assert.equal(kinds.get(ln.id), "SELR", `line ${ln.id}`);
    if (ln.glued) assert.notEqual(kinds.get(ln.id), "SELR", `line ${ln.id}`);
  }
  assert.equal(map.lines.filter((ln) => ln.choice).length, 197);
});

test("route and day come from the scene's name", { skip: !mapThere && "no line map" }, () => {
  const of = (name) => map.scenes.find((s) => s.name === name);
  assert.deepEqual(of("00_00"), { name: "00_00", route: "prologue", day: 0 });
  assert.deepEqual(of("05_00_ARC05_1B"), { name: "05_00_ARC05_1B", route: "arcueid", day: 5 });
  assert.deepEqual(of("14_01B_02_CIEL14B_2B"), { name: "14_01B_02_CIEL14B_2B", route: "ciel", day: 14, part: "B" });
  assert.deepEqual(of("QA_13"), { name: "QA_13", route: "qa", episode: 13 });
  assert.deepEqual(of("JUMP00"), { name: "JUMP00", route: "system" });
});

// Every string in a JSON value, with the key it sits under.
function strings(v, key = "", out = []) {
  if (typeof v === "string") out.push([key, v]);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, key, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) strings(x, k, out);
  return out;
}
const textFiles = () => ["web/assets/text.json", "web/assets/ja/text.json", "web/assets/zh/text.json", "web/assets/aniplex/text.json", "web/assets/pt/text.json"]
  .filter((p) => existsSync(at(p)));

test("the line map holds no game text: numbers, scene, op and voice names only", { skip: !mapThere && "no line map" }, () => {
  const all = strings(map);
  for (const [key, s] of all) {
    if (key === "about") continue;
    assert.match(s, /^[A-Za-z0-9_./-]+$/, `${key}: ${JSON.stringify(s).slice(0, 40)}`);
  }
  assert.ok(map.about.startsWith("web-dev/tools/line_map.py"));
  const own = new Set(all.map(([, s]) => s));
  for (const p of textFiles()) for (const line of JSON.parse(readFileSync(at(p), "utf8"))) if (line.length > 1) assert.ok(!own.has(line), `${p}: a line is in the map`);
});

test("the fit reports hold no game text either", { skip: !textFiles().length && "no web/assets" }, () => {
  const reports = readdirSync(at("web-dev/audit")).filter((f) => /^fit-.*\.json$/.test(f));
  const lines = new Set(textFiles().flatMap((p) => JSON.parse(readFileSync(at(p), "utf8"))).filter((l) => l.length > 1));
  for (const f of reports) {
    let r = json(`web-dev/audit/${f}`);
    if (typeof r === "string") r = JSON.parse(r);   // (as the MCP saves it, before fit_summary.py)
    for (const [key, s] of strings(r)) assert.ok(!lines.has(s), `${f} ${key}: a line of the game`);
  }
});

// (the game's page scripts are in the port's repository; the translator's own reads them from the installed game)
test("the fit page's engine imports are there, and the runner is one function", { skip: !existsSync(at("web/app/js/lang.js")) && "no web/app here" }, () => {
  const src = readFileSync(at("web-dev/fit/fit.js"), "utf8");
  const imports = [...src.matchAll(/^import \{([^}]+)\} from "\/js\/([\w-]+\.js)";$/gm)];
  // textbox.js as a namespace (an app older than BALLOON_INSIDE still loads the page): the names taken from it must be there too
  const ns = /^import \* as (\w+) from "\/js\/(textbox\.js)";.*\nconst \{([^}]+)\} = \1;$/m.exec(src);
  assert.ok(ns, "textbox.js imported as a namespace");
  imports.push([null, ns[3], ns[2]]);
  assert.ok(imports.length >= 8);
  for (const [, names, file] of imports) {
    const mod = readFileSync(at(`web/app/js/${file}`), "utf8");
    for (const n of names.split(",").map((x) => x.trim()).filter(Boolean)) {
      assert.match(mod, new RegExp(`export (async )?(function|const|class|let) ${n}\\b`), `${file} exports ${n}`);
    }
  }
  const run = readFileSync(at("web-dev/fit/run-mcp.js"), "utf8");
  assert.equal(typeof new Function(`return (${run}\n)`)(), "function");
  // storage is made read-only before any of the game's code runs
  const html = readFileSync(at("web-dev/fit/fit.html"), "utf8");
  assert.ok(html.indexOf("Storage.prototype") < html.indexOf('src="/fit/fit.js"'));
});

const python = (() => { try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
test("dev_server.py serves the fit page, its script and the line map", { skip: !(python && mapThere) && "no python3 or line map" }, async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const srv = spawn("python3", ["-I", at("web-dev/tools/dev_server.py").pathname, String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("dev_server.py did not start")), 10000);
      srv.stdout.on("data", (d) => { if (String(d).includes("http://")) { clearTimeout(t); res(); } });
      srv.on("exit", (c) => rej(new Error(`dev_server.py exited ${c}`)));
    });
    for (const [path, file] of [["/fit/", "web-dev/fit/fit.html"], ["/fit/fit.js", "web-dev/fit/fit.js"], ["/fit/line_map.json", MAP]]) {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(r.status, 200, path);
      assert.equal(Buffer.from(await r.arrayBuffer()).equals(readFileSync(at(file))), true, path);
    }
  } finally {
    srv.kill();
  }
});
