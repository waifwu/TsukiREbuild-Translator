// main.js - the translator tool as an app (Tsukihime Translator.exe): it runs on top of the game a translator has installed
// (web-dev/TRANSLATOR-TOOL-PLAN.md, decision 1: they download the game and the tool, and keep their translation in their own repository).
//
// What it does, in order:
//   1. Finds the game: the Windows build unzipped anywhere (a folder with Tsukihime.exe and resources/www), or the Mac app. It looks where it
//      was last found, beside this app, and in the usual places (Downloads, Desktop, Documents, C:\Games, Program Files); else it asks for
//      Tsukihime.exe. The game's own data folder (%APPDATA%\Tsukihime, ~/Library/Application Support/Tsukihime) is read too, first: the
//      update the game plays and the languages it downloaded live there (web-dev/tools/gamefiles.py).
//   2. Asks once for the translation's folder (kept in the translator's own repository; an empty folder starts a new translation).
//   3. Starts the tool's server (web-dev/tools/dev_server.py) with the Python carried inside this app (Windows: python.org's embeddable
//      package, resources/python), on a free port of this computer only, and opens the editor (/translator/) in a window of its own.
//   4. Keeps the tool up to date (updater.js): once the editor is up, it looks at the latest release of the app's GitHub repository
//      (tool-files.json "repository"). Newer tool files are downloaded quietly and checked, and the app asks before restarting the editor
//      with them ("Later": the next time it opens). A release that needs a newer app than this one (its "shell") is not taken: the app
//      offers the releases page instead. Help → Check for updates asks at any time.
// Nothing here writes anywhere but this app's own data folder (its settings, the tool's updates) and, through the editor, the translation's
// folder. The game's files are only read. The only address it reaches beyond this computer is GitHub, for updates. Closing the window stops
// the server.
//
// For testing (unpackaged, npm start): --game=DIR (a game folder, a www, a Mac .app), --translations=DIR, --python=PATH (default: python3),
// --tool=DIR (a tool tree with its bundled.json, in place of this checkout), --update-origin=http://127.0.0.1:PORT (a release's files
// served on this computer: translator_manifest.py --release), --test-answer=restart|later (answers the update's question),
// --user-data-dir=DIR (the app's own data there, not beside the copy you use).
const { app, BrowserWindow, Menu, dialog, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { ToolUpdater, github, local } = require("./updater.js");
const TOOL_LIST = require("./tool-files.json");

const flag = (name) => { const a = process.argv.find((v) => v.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
// The tool as the app came with it (unpackaged: this checkout, or --tool), and what this app is to the tool's updates: raise TOOL_SHELL with
// tool-files.json "shell" when the tool needs something of the app that older apps lack (web-dev/tests/translator-update.test.mjs pins them).
const TOOL = app.isPackaged ? path.join(process.resourcesPath, "tool") : flag("tool") ? path.resolve(flag("tool")) : path.join(__dirname, "..", "..");
const TOOL_SHELL = 1;
const UPDATE_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(flag("update-origin") || "") ? flag("update-origin") : null;
const TEST_ANSWER = app.isPackaged ? null : flag("test-answer");
// (unpackaged, for testing beside an open copy: Electron keeps its own data folder by the app's name whatever --user-data-dir says, so the
// lock that keeps one copy open, the settings and the tool's updates would be the running app's)
if (!app.isPackaged && flag("user-data-dir")) app.setPath("userData", path.resolve(flag("user-data-dir")));
const BUNDLED_PYTHON = path.join(process.resourcesPath || "", "python", process.platform === "win32" ? "python.exe" : "bin/python3");
const PYTHON = flag("python") || (app.isPackaged && fs.existsSync(BUNDLED_PYTHON) ? BUNDLED_PYTHON : "python3");
const SITE = "https://arcueid.date";
const SETTINGS = () => path.join(app.getPath("userData"), "settings.json");
const GAME_DATA = () => path.join(app.getPath("appData"), "Tsukihime");   // the game app's own data folder (its productName)

let settings = {};
let server = null;
let win = null;
let currentOrigin = "";   // the editor's server, http://localhost:PORT
const log = [];
const note = (line) => { log.push(line); if (log.length > 200) log.shift(); if (TEST_ANSWER) console.log(line); };
let place = null;   // the game's www and the translation folder the editor is open over
let updater = null;   // updater.js, when the tool has a bundled.json (a built app, or --tool)

function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(SETTINGS(), "utf8")) || {}; } catch { settings = {}; }
}
function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS()), { recursive: true });
  fs.writeFileSync(SETTINGS(), JSON.stringify(settings, null, 1));
}

// ---- the game ------------------------------------------------------------------------------------------------------------------------------
// The game's page and files in a folder: the Windows (and unpacked Linux) build's resources/www, a Mac app's Contents/Resources/www, or a www.
function wwwOf(dir) {
  if (!dir) return null;
  if (/\.exe$/i.test(dir)) dir = path.dirname(dir);
  for (const w of [path.join(dir, "resources", "www"), path.join(dir, "Contents", "Resources", "www"), dir]) {
    try {
      if (fs.statSync(path.join(w, "index.html")).isFile() && fs.statSync(path.join(w, "assets", "text.json")).isFile()
        && fs.statSync(path.join(w, "assets", "scripts", "index.json")).isFile()) return w;
    } catch { /* not here */ }
  }
  return null;
}
function places() {
  const here = path.dirname(process.execPath);
  const out = [flag("game"), settings.game, here, path.dirname(here), path.dirname(path.dirname(here))];
  const bases = [app.getPath("downloads"), app.getPath("desktop"), app.getPath("documents"), app.getPath("home"), "C:\\Games", "D:\\Games",
    process.env.ProgramFiles, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"), "/Applications",
    path.join(app.getPath("home"), "Applications")];
  for (const base of bases) {
    if (!base) continue;
    let names = [];
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const d of names.filter((n) => /tsuki/i.test(n))) {
      out.push(path.join(base, d));
      try { for (const e of fs.readdirSync(path.join(base, d))) out.push(path.join(base, d, e)); } catch { /* a file */ }
    }
  }
  return out;
}
async function findGame() {
  for (const p of places()) {
    const w = wwwOf(p);
    if (w) return w;
  }
  for (;;) {
    const r = await dialog.showMessageBox({
      type: "info", title: "Tsukihime Translator", buttons: ["Find Tsukihime.exe…", "Get the game", "Quit"], defaultId: 0, cancelId: 2,
      message: "The game is not found on this computer.",
      detail: "The translator works on top of the game (the PC build from arcueid.date: unzip it into a folder of its own). Show where its Tsukihime.exe is, or get the game first.",
    });
    if (r.response === 1) { shell.openExternal(SITE); continue; }
    if (r.response !== 0) return null;
    const pick = await dialog.showOpenDialog({
      title: "Where is Tsukihime.exe?", properties: process.platform === "darwin" ? ["openFile", "openDirectory", "treatPackageAsDirectory"] : ["openFile"],
      filters: process.platform === "win32" ? [{ name: "Tsukihime", extensions: ["exe"] }] : [],
    });
    if (pick.canceled || !pick.filePaths[0]) continue;
    const w = wwwOf(pick.filePaths[0]) || wwwOf(path.dirname(pick.filePaths[0]));
    if (w) return w;
    await dialog.showMessageBox({ type: "warning", message: "That is not the game.", detail: `${pick.filePaths[0]} has no game files beside it (resources/www).` });
  }
}

// ---- the translation's folder --------------------------------------------------------------------------------------------------------------
async function chooseFolder(again = false) {
  const given = flag("translations");
  if (given && !again) return path.resolve(given);
  if (!again && settings.translations && fs.existsSync(settings.translations)) return settings.translations;
  const r = await dialog.showOpenDialog({
    title: "Your translation's folder",
    message: "Choose the folder your translation is kept in (in your own repository). An empty folder starts a new translation.",
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || !r.filePaths[0]) return again ? null : (settings.translations && fs.existsSync(settings.translations) ? settings.translations : null);
  return r.filePaths[0];
}

// ---- the tool's server --------------------------------------------------------------------------------------------------------------------
// The port: the one used last time where it is free, else any free one (kept in settings.json). The editor keeps its own settings (columns,
// widths, the second box's language, where you left off) in the page's storage, which belongs to http://localhost:PORT: a new port each time
// would start it afresh at every launch.
const tryPort = (want) => new Promise((res) => {
  const s = net.createServer();
  s.once("error", () => res(null));
  s.listen(want, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});
async function freePort() {
  const last = Number(settings.port);
  const port = (Number.isInteger(last) && last > 1024 && last < 65536 && await tryPort(last)) || await tryPort(0);
  if (!port) throw new Error("no free port on this computer for the tool's server");
  if (port !== settings.port) { settings.port = port; saveSettings(); }
  return port;
}
// back: { root, version } to start the tool from in place of the one in use (open: an update that did not start)
async function startServer(www, folder, back = null) {
  await stopServer();
  const port = await freePort();
  const root = back ? back.root : updater ? updater.root() : TOOL;   // (the tool's update in use, or the app's own)
  if (back) updater.inUse = back.version; else updater?.started();
  const SERVER = path.join(root, "web-dev", "tools", "dev_server.py");
  const apps = [];
  if (fs.existsSync(path.join(GAME_DATA(), "update", "state.json"))) apps.push("--app", GAME_DATA());
  apps.push("--app", www);
  // -I: nothing of this computer's Python settings; -X utf8: the console speaks UTF-8 whatever Windows' code page (a folder named in Spanish)
  const child = spawn(PYTHON, ["-I", "-X", "utf8", SERVER, String(port), ...apps, "--translations", folder], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  server = child;
  const said = (d) => { for (const line of String(d).split(/\r?\n/)) if (line) note(line); };
  child.stderr.on("data", said);
  return await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("the tool's server did not start in a minute")), 60000);
    child.stdout.on("data", (d) => { said(d); if (/http:\/\/localhost:\d+\/translator\//.test(String(d))) { clearTimeout(t); res(port); } });
    child.on("error", (e) => { clearTimeout(t); rej(new Error(`Python could not be started (${PYTHON}): ${e.message}`)); });
    child.on("exit", (c) => { clearTimeout(t); if (server === child) server = null; rej(new Error(`the tool's server stopped (${c})`)); });
  });
}
// (it resolves once the server has gone, so its port is free again for the next one: another folder keeps the same port)
function stopServer() {
  if (!server) return Promise.resolve();
  const s = server;
  server = null;
  const gone = s.exitCode !== null || s.signalCode !== null ? Promise.resolve()
    : new Promise((res) => { s.once("exit", res); setTimeout(res, 5000); });
  try { s.kill(); } catch { /* gone */ }
  return gone;
}

// ---- the window --------------------------------------------------------------------------------------------------------------------------
async function open(www, folder) {
  place = { www, folder };
  let port;
  try {
    try {
      port = await startServer(www, folder);
    } catch (e) {
      // An update of the tool that does not start: the one before it (or the app's own) is tried. Only when that starts is the update given
      // up (not offered again); when it does not start either, the fault is elsewhere (the game, the folder) and the update stays.
      if (!updater?.meta) throw e;
      const v = updater.meta.version;
      note(`update: the tool ${v} did not start (${e.message}): trying the one before it`);
      port = await startServer(www, folder, updater.fallback());
      updater.giveUp();
      note(`update: the tool ${v} given up`);
    }
  } catch (e) {
    if (TEST_ANSWER) { note(`could not open: ${e.message}`); app.quit(); return; }
    await dialog.showMessageBox({ type: "error", title: "Tsukihime Translator", message: e.message, detail: log.slice(-12).join("\n") || "(nothing said)" });
    app.quit();
    return;
  }
  const origin = `http://localhost:${port}`;
  if (!win) {
    // (a test run, --test-answer, keeps its window hidden: it is driven over the debugging port, not looked at)
    win = new BrowserWindow({ width: 1600, height: 1000, minWidth: 900, minHeight: 600, resizable: true, maximizable: true, title: "Tsukihime Translator", autoHideMenuBar: false,
      show: !TEST_ANSWER, webPreferences: { contextIsolation: true, sandbox: true, spellcheck: true, backgroundThrottling: !TEST_ANSWER } });
    win.on("closed", () => { win = null; });
    win.on("page-title-updated", (e) => e.preventDefault());   // (the window keeps its own title: the app's name and the folder)
    // "Play from here" opens the game from the same server in a window of its own; any other address goes to the computer's browser
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(`${currentOrigin}/`)) return { action: "allow", overrideBrowserWindowOptions: { width: 1280, height: 760, minWidth: 480, minHeight: 270, resizable: true, title: "Tsukihime (the translation)", autoHideMenuBar: true } };
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(`${currentOrigin}/`)) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); } });
    // the editor asks before leaving with lines not saved yet (beforeunload): Electron would close without asking, so ask here
    win.webContents.on("will-prevent-unload", (e) => {
      const r = dialog.showMessageBoxSync(win, { type: "question", buttons: ["Leave", "Stay"], defaultId: 1, cancelId: 1,
        message: "Some lines are not saved yet.", detail: "They are saved a moment after each change: stay a moment, then close." });
      if (r === 0) e.preventDefault();
    });
  }
  currentOrigin = origin;
  win.setTitle(`Tsukihime Translator — ${folder}`);
  await win.loadURL(`${origin}/translator/`);
  watchEditor();
}

// ---- the tool's updates (updater.js) -----------------------------------------------------------------------------------------------------
// The editor has come up (window.translator.ready): the tool in use is confirmed, and the first time in this run the latest release is looked at.
let looked = false, checking = false;
async function watchEditor() {
  const w = win;
  for (let i = 0; i < 240 && w && !w.isDestroyed(); i++) {
    let up = "";
    try { up = await w.webContents.executeJavaScript("window.translator ? (window.translator.ready ? 'ready' : window.translator.error ? 'error' : '') : ''"); } catch { /* loading */ }
    if (up === "ready") {
      updater?.confirm();
      if (!looked) { looked = true; setTimeout(() => checkUpdates(false), 3000); }
      return;
    }
    if (up === "error") return;   // (the editor said why: the game, the folder; not taken as the tool's fault)
    await new Promise((r) => setTimeout(r, 500));
  }
}
function setUpUpdates() {
  let bundled = null;
  try { bundled = JSON.parse(fs.readFileSync(path.join(TOOL, "bundled.json"), "utf8")); } catch { note("updates: off (the tool has no bundled.json: an unpacked checkout)"); return; }
  try {
    const ses = session.fromPartition("updates");   // (a session of its own, in memory)
    const source = UPDATE_ORIGIN ? local(UPDATE_ORIGIN) : github(TOOL_LIST.repository);
    // Every request of that session, each redirect included, only to where updates come from: Electron's fetch does not say where a
    // redirect ended (its response's url is empty), so updater.js cannot check that itself here.
    ses.webRequest.onBeforeRequest((d, done) => { const ok = source.allowed(d.url); if (!ok) note(`update: refused ${d.url}`); done({ cancel: !ok }); });
    updater = new ToolUpdater({
      dir: path.join(app.getPath("userData"), "tool-updates"),
      source,
      bundled, bundledRoot: TOOL, shell: TOOL_SHELL, fetch: (url, opts) => ses.fetch(url, opts),
    }).load();
    note(`updates: the tool ${updater.info().version}${updater.meta ? " (an update)" : ""}, from ${updater.source.description}`);
  } catch (e) { updater = null; note(`updates: off (${e.message})`); }
}
const when = (t) => new Date(t * 1000).toISOString().slice(0, 10);
async function ask(opts) {
  if (TEST_ANSWER) { note(`update: asked "${opts.message}", answered ${TEST_ANSWER}`); return TEST_ANSWER === "restart" ? 0 : 1; }
  return (await dialog.showMessageBox(win, opts)).response;
}
async function checkUpdates(asked) {
  const tell = (type, message, detail) => (asked ? dialog.showMessageBox(win, { type, title: "Tsukihime Translator", message, detail }) : null);
  if (!updater) return tell("info", "This copy does not update itself.", "It is run from a checkout of the tool, not from a built app.");
  if (checking) return null;
  checking = true;
  try {
    const r = await updater.check();
    const now = updater.info();
    if (r.kind === "none") {
      note(`update: none (the latest release is ${r.site.tag}, the tool ${r.site.version})`);
      return tell("info", "The translator is up to date.", `The tool ${now.version}${now.tag ? `, release ${now.tag}` : ""}, of ${when(now.time)}.`);
    }
    if (r.kind === "newer-app") {
      note(`update: ${r.site.tag} needs a newer app (shell ${r.site.shell}, this one ${TOOL_SHELL})`);
      if (!asked && settings.toldNewer === r.site.version) return null;
      settings.toldNewer = r.site.version;
      saveSettings();
      const a = await ask({ type: "info", title: "Tsukihime Translator", message: "A newer Tsukihime Translator is out.",
        detail: `Release ${r.site.tag} needs a newer app than this one, so this one cannot bring itself up to date: download the new app from the releases page. Your translation folder stays as it is.`,
        buttons: ["Open the releases page", "Not now"], defaultId: 0, cancelId: 1 });
      if (a === 0) { if (TEST_ANSWER) note(`update: would open ${updater.source.page}`); else shell.openExternal(updater.source.page); }
      return null;
    }
    const fetched = await updater.stage(r.site);
    updater.apply(r.site.version);
    note(`update: ${r.site.tag} (the tool ${r.site.version}) put in place, ${fetched} files downloaded`);
    const a = await ask({ type: "info", title: "Tsukihime Translator", message: "An update of the translator is ready.",
      detail: `Release ${r.site.tag} (${fetched} file${fetched === 1 ? "" : "s"} new). Restart the editor now to use it? Your lines are saved first. With "Later", it is used the next time the app opens.`,
      buttons: ["Restart now", "Later"], defaultId: 0, cancelId: 1 });
    if (a === 0 && win) {
      try { await win.webContents.executeJavaScript("window.translator && window.translator.flush ? Promise.resolve(window.translator.flush()).then(() => true) : true"); } catch { /* the page asks itself if lines are left */ }
      await open(place.www, place.folder);
    }
    return null;
  } catch (e) {
    note(`update: ${e.message}`);
    return tell("warning", "Could not look for updates.", e.message);
  } finally { checking = false; }
}
function about() {
  const i = updater?.info();
  dialog.showMessageBox(win, { type: "info", title: "Tsukihime Translator", message: `Tsukihime Translator ${app.getVersion()}`,
    detail: (i ? `The tool ${i.version}${i.tag ? `, release ${i.tag}` : ""}, of ${when(i.time)}${i.update ? " (an update)" : " (as the app came)"}.\n` : "The tool from a checkout (no updates).\n")
      + `App ${TOOL_SHELL} of the tool's updates.\nUpdates: ${updater ? updater.source.page : "off"}` });
}

function menu() {
  const tpl = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: [
      { label: "Open another translation folder…", accelerator: "CmdOrCtrl+O", click: async () => {
        const folder = await chooseFolder(true);
        if (!folder) return;
        settings.translations = folder;
        saveSettings();
        await open(place.www, folder);
      } },
      { label: "Show the translation folder", click: () => place && shell.openPath(place.folder) },
      { label: "Find the game again…", click: async () => {
        delete settings.game;
        const w = await (async () => {
          const pick = await dialog.showOpenDialog({ title: "Where is Tsukihime.exe?", properties: process.platform === "darwin" ? ["openFile", "openDirectory", "treatPackageAsDirectory"] : ["openFile"] });
          return pick.canceled ? null : wwwOf(pick.filePaths[0]) || wwwOf(path.dirname(pick.filePaths[0]));
        })();
        if (!w) return;
        settings.game = w;
        settings.www = w;
        saveSettings();
        await open(w, place.folder);
      } },
      { type: "separator" },
      process.platform === "darwin" ? { role: "close" } : { role: "quit" },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { role: "help", submenu: [
      { label: "Check for updates…", click: () => checkUpdates(true) },
      { label: "About Tsukihime Translator", click: about },
      { type: "separator" },
      { label: "Show the tool's log", click: () => dialog.showMessageBox({ title: "The tool's log", message: "What the tool's server said last", detail: log.slice(-40).join("\n") || "(nothing)" }) },
      { label: "arcueid.date", click: () => shell.openExternal(SITE) },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on("window-all-closed", () => { stopServer(); app.quit(); });
app.on("before-quit", stopServer);
process.on("exit", stopServer);

app.whenReady().then(async () => {
  loadSettings();
  setUpUpdates();
  menu();
  const www = await findGame();
  if (!www) { app.quit(); return; }
  const folder = await chooseFolder();
  if (!folder) { app.quit(); return; }
  if (!flag("game")) settings.game = www;
  settings.www = www;
  if (!flag("translations")) settings.translations = folder;
  saveSettings();
  await open(www, folder);
});
