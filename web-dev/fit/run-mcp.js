// run-mcp.js - walks every page of one text.json through the fit page and leaves the report in the page (translator tool, Stage 0).
//
// For the Playwright MCP (its own browser profile, so nobody's saves are touched), in two calls:
//   1. browser_navigate  http://localhost:PORT/fit/?text=/assets/pt/text.json   on web-dev/tools/dev_server.py, which serves the fit page and the
//      line map (made from the game it runs over: --app names an installed app, so this needs no checkout).
//      On any other server of the game (web/server.py), add &root=<this checkout's web-dev folder, absolute>: the fit page's own files are
//      then routed from there. &font=gelasio sets the story in the bundled face, as a machine without Georgia does (Android); &english=aniplex
//      is kept, though only the lines differ (lang.js OFFICIAL picks the file and nothing else).
//      browser_run_code_unsafe  filename: tsukire-pc-port/web-dev/fit/run-mcp.js
//   2. browser_evaluate  () => JSON.stringify(window.__fitReport)   filename: tsukire-pc-port/web-dev/audit/fit-<name>.json
// The MCP's code runs without file access, so the report is saved by the second call, which writes it as one JSON string (an object would
// be written in the inspector's notation). web-dev/tools/fit_summary.py turns such a file back into plain JSON and lists the worst pages.
// The report holds numbers, scene names and line ids only, never text. Its "findings" (pages past 12 rows, choices wider than the widest English
// one or pushed over the text, letters off a balloon) and "textSha1" are what build_layer.py --fit takes as a build's page-fit checks (Stage 4):
// run it on /assets/draft/text.json (dev_server.py --translations) for the folder as it stands.
async (page) => {
  const here = new URL(page.url());
  if (!/^\/fit\/?/.test(here.pathname)) throw new Error("open the fit page first: http://localhost:PORT/fit/?text=/assets/...");
  const FIT = here.searchParams.get("root");
  const files = { "/fit": "fit/fit.html", "/fit/": "fit/fit.html", "/fit/index.html": "fit/fit.html", "/fit/fit.js": "fit/fit.js", "/fit/line_map.json": "data/line_map.json" };
  await page.unroute(`${here.origin}/fit**`).catch(() => {});
  if (FIT) await page.route(`${here.origin}/fit**`, (route) => {
    const f = files[new URL(route.request().url()).pathname];
    if (!f) return route.continue();
    const type = f.endsWith(".js") ? "text/javascript" : f.endsWith(".json") ? "application/json" : "text/html";
    return route.fulfill({ path: `${FIT}/${f}`, contentType: type, headers: { "Cache-Control": "no-cache" } });
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  const url = new URL(here);
  url.pathname = "/fit/";
  url.searchParams.set("lang", "en");   // the game's language decides how text is set: English rules for every text.json of the English's kind
  if (!url.searchParams.get("english")) url.searchParams.set("english", "tsukihimates");
  url.searchParams.delete("page");
  await page.goto(url.href);
  await page.waitForFunction(() => window.fit?.ready || /Error|error/.test(document.getElementById("o")?.textContent || ""), null, { timeout: 120000, polling: 250 });
  return await page.evaluate(async () => {
    if (!window.fit?.ready) throw new Error(document.getElementById("o").textContent);
    const head = await fit.report();
    if (!head.insideTable) throw new Error("textbox.js BALLOON_INSIDE differs from fit.insideWidths(): measure again");
    if (head.lang !== "en" || head.orig) throw new Error(`the page is in ${head.lang}, not English`);
    if (head.stage.width !== 1920 || head.stage.height !== 1080 || head.stage.left !== 0 || head.stage.top !== 0) throw new Error("the stage is not 1920 x 1080 at 0, 0");
    const t0 = performance.now();
    const all = { pages: [], choices: [], balloons: [], errors: [] };
    const N = fit.map.pages.length;
    for (let n = 0; n < N; n += 500) {
      const r = await fit.run(n, n + 500);
      for (const k of Object.keys(all)) all[k].push(...r[k]);
    }
    // (Stage 4) what a build takes as its page-fit checks (build_layer.py --fit): the text measured, by its SHA-1, so a report of another text is
    // refused; the widest English choice row, measured here; and the findings, each with its page's line ids
    const raw = await (await fetch(head.text)).arrayBuffer();
    const textSha1 = [...new Uint8Array(await crypto.subtle.digest("SHA-1", raw))].map((x) => x.toString(16).padStart(2, "0")).join("");
    const idsOn = new Map();
    for (const ln of fit.map.lines) for (const a of ln.at) if (a.page !== null && !a.dead) { if (!idsOn.has(a.page)) idsOn.set(a.page, []); if (!idsOn.get(a.page).includes(ln.id)) idsOn.get(a.page).push(ln.id); }
    const forget = async (p) => { const sc = await fit.vm.getScript(fit.map.pages[p].s); delete sc.wrap; };
    const keepLines = fit.vm.lines;
    fit.vm.lines = await (await fetch("/assets/text.json")).json();
    let englishWidest = 0;
    for (const p of new Set(fit.map.lines.filter((l) => l.choice).flatMap((l) => l.at.map((a) => a.page)).filter((p) => p !== null))) {
      await forget(p);
      for (const c of (await fit.page(p)).choices || []) for (const r of c.rows) englishWidest = Math.max(englishWidest, r.width);
    }
    fit.vm.lines = keepLines;
    for (const sc of await Promise.all([...fit.vm.scripts.values()].map((x) => x.catch(() => null)))) if (sc) delete sc.wrap;
    const where = (n) => `${fit.vm.index.names[fit.map.pages[n].s]} page ${fit.map.pages[n].k + 1}`;
    const findings = [];
    for (const [n, rows] of all.pages) if (rows > head.box.rows) findings.push({ kind: "page past 12 rows", page: n, ids: idsOn.get(n) || [], what: `${where(n)}: ${rows} rows; 12 fit the screen` });
    for (const c of all.choices) {
      const w = Math.max(...c.widths);
      if (w > englishWidest + 0.5) findings.push({ kind: "choice wider than the English's widest", page: c.page, ids: c.ids, what: `${where(c.page)}: a choice ${Math.round(w)} px wide; the widest English one is ${Math.round(englishWidest)} px` });
      if (c.room < 0) findings.push({ kind: "choices over the text", page: c.page, ids: c.ids, what: `${where(c.page)}: the choices are pushed up over the page's text` });
    }
    for (const b of all.balloons) if (b.out > 0) findings.push({ kind: "letters off a balloon", page: b.page, ids: idsOn.get(b.page) || [], what: `${where(b.page)}: ${b.out} letter boxes off the balloon` });
    const over = all.pages.filter((p) => p[1] > head.box.rows).map((p) => p[0]);
    const hist = {};
    for (const p of all.pages) hist[p[1]] = (hist[p[1]] || 0) + 1;
    const worst = [...all.pages].sort((a, b) => b[1] - a[1] || (b[2] ?? 0) - (a[2] ?? 0)).slice(0, 40);
    const widest = all.choices.flatMap((c) => c.widths.map((w, i) => ({ page: c.page, id: c.ids[i], width: w }))).sort((a, b) => b.width - a.width).slice(0, 20);
    const tight = [...all.balloons].filter((b) => b.room !== null).sort((a, b) => a.room - b.room).slice(0, 20);
    window.__fitReport = {
      ...head,
      when: new Date().toISOString(),
      seconds: Math.round((performance.now() - t0) / 100) / 10,
      textSha1,
      englishWidest,
      findings,
      columns: { pages: ["page", "rows", "bottom", "ways"] },
      summary: {
        over12: over.length,
        rows: hist,
        choicesOverText: all.choices.filter((c) => c.room < 0).map((c) => c.page),
        balloonRowsOut: all.balloons.filter((b) => b.out > 0).map((b) => b.page),
        errors: all.errors.length,
      },
      over,
      worst,
      widest,
      tight,
      ...all,
    };
    return { text: head.text, pages: all.pages.length, seconds: window.__fitReport.seconds, ...window.__fitReport.summary, rows: undefined, top: worst.slice(0, 5), widest: widest.slice(0, 3), tight: tight.slice(0, 3), englishWidest, findings: findings.length };
  });
}
