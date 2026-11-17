#!/usr/bin/env python3
"""dev_server.py [port] [--app DIR ...] [--translations DIR]: the game's own server (web/server.py) with the developer pages, which are kept out of
web/ because the game does not need them: the script smoke test at /smoketest.html, and the translator tool (web-dev/TRANSLATOR-TOOL-PLAN.md): the
page fit at /fit/ and the editor at /translator/.

    python3 web-dev/tools/dev_server.py 8798 --translations ~/my-translation/xx
    python3 web-dev/tools/dev_server.py 8798 --app "%APPDATA%/Tsukihime" --app "C:/Games/Tsukihime/resources/www" --translations ...

--app: where the game is, as a translator has it (decision 1: they work over the app they downloaded; web-dev/tools/gamefiles.py): a web/ folder
filled by web-dev/tools/fetch_assets.py, the desktop app's www (or a Mac .app), and its data folder, which holds the update it plays and the
languages it downloaded (name that first). Several may be named: the first that has a file gives it. Without --app, this checkout's web/.
--translations: the folder of a translation (build_layer.py's form: <scene>.json a scene, language.json), in the translators' own repository. The
editor reads it and writes to it; nothing else is written anywhere.

The line map (web-dev/tools/line_map.py) is made from the app's own scripts as the server starts (about 5 s) and kept in memory: /fit/line_map.json.

With a translations folder, the game served here also plays the translation as it stands, as a language called "draft" (Stage 3): /assets/draft/
is that folder laid over the English (its text.json made when asked: build_layer.py's lines, the English wherever a line is not translated), and
the app's js/languages.js is given one more row for it (the file itself is not changed). So /?script=S&pc=P&lang=draft plays a scene from a
command in the translation, with the translation's own rules (lang.js LAYERS: balloons wrapped inside their pictures, the English's scripts).

Listens on this machine only (127.0.0.1), and answers only requests addressed to it by that name (localhost, 127.0.0.1): a page elsewhere that
points a name of its own at this machine is refused. The editor's writes (POST /translator/api/save, /language, /glossary, /import) also need the
editor's own page: its address as the Origin, a JSON body, and the token the server made as it started, which only a page of this server can read.
Standard library only.
"""
import importlib.util
import io
import json
import xml.etree.ElementTree as ET
import mimetypes
import os
import re
import secrets
import sys
import threading
import urllib.parse

sys.dont_write_bytecode = True   # no cache folder inside web/
HERE = os.path.dirname(os.path.abspath(__file__))
DEV = os.path.normpath(os.path.join(HERE, ".."))
WEB = os.path.normpath(os.path.join(HERE, "..", "..", "web"))
SMOKE = os.path.join(DEV, "smoketest")
FIT = os.path.join(DEV, "fit")
TRANSLATOR = os.path.join(DEV, "translator")
MOST_BODY = 64 << 20   # (an import of a whole language's XLIFF is about 10 MB)
USAGE = __doc__.split("\n\n")[0]


def parse_args(argv):
    port, apps, folder = 8765, [], None
    it = iter(argv)
    for a in it:
        if a == "--app":
            apps.append(next(it, None) or sys.exit(USAGE))
        elif a == "--translations":
            folder = next(it, None) or sys.exit(USAGE)
        elif re.fullmatch(r"\d{2,5}", a):
            port = int(a)
        else:
            sys.exit(f"{a}: not understood\n{USAGE}")
    return port, apps, folder


PORT, APPS, FOLDER = parse_args(sys.argv[1:])
sys.argv[1:] = [str(PORT)]   # (web/server.py reads its port from there)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


server = load("server", os.path.join(WEB, "server.py"))
gamefiles = load("gamefiles", os.path.join(HERE, "gamefiles.py"))
line_map = load("line_map", os.path.join(HERE, "line_map.py"))
translations = load("translations", os.path.join(HERE, "translations.py"))
build_layer = load("build_layer", os.path.join(HERE, "build_layer.py"))
exchange = load("exchange", os.path.join(HERE, "exchange.py"))

try:
    FILES = gamefiles.GameFiles(APPS or [WEB])
except ValueError as e:
    sys.exit(f"{e}\n(--app names where the game is; without it, this checkout's web/ folder is used)")
if not FILES.has("text.json") or not FILES.has("scripts/index.json"):
    sys.exit("The game's files are not there (no text.json and scripts). Name the app with --app, or fetch them once into this checkout's web/:  "
             "python3 web-dev/tools/fetch_assets.py")
if FOLDER is not None:
    FOLDER = os.path.abspath(os.path.expanduser(FOLDER))
    if not os.path.isdir(FOLDER):
        sys.exit(f"{FOLDER}: no such folder (make it first: the translations are kept in it)")

TOKEN = secrets.token_hex(16)
ORIGINS = {f"http://{h}:{PORT}" for h in ("localhost", "127.0.0.1", "[::1]")}
HOSTS = {f"{h}:{PORT}" for h in ("localhost", "127.0.0.1", "[::1]")}
PAGES = {"/smoketest.html": os.path.join(SMOKE, "smoketest.html"), "/js/smoketest.js": os.path.join(SMOKE, "smoketest.js"),
         "/fit": os.path.join(FIT, "fit.html"), "/fit/": os.path.join(FIT, "fit.html"), "/fit/index.html": os.path.join(FIT, "fit.html"),
         "/fit/fit.js": os.path.join(FIT, "fit.js"),
         "/translator": os.path.join(TRANSLATOR, "index.html"), "/translator/": os.path.join(TRANSLATOR, "index.html")}
TOOL_FILE = re.compile(r"/translator/([a-z0-9_-]+\.(js|css|html|svg))")


DRAFT_ROW = {"code": "draft", "plate": "DRAFT", "name": "Draft", "row": "The translation in the translator tool's folder, as it stands.",
             "start": "The game starts in the translation's draft.", "layers": ["draft"], "scripts": "en", "html": "en", "gated": True}
TABLE = re.compile(r"(/\* languages: \*/\s*\[)(.*?)(\]\s*/\* :languages \*/)", re.S)


def languages_js(path, code):
    """The app's languages.js with the draft's row added (lang.js reads the table), or None where the app has no table (an app before 2026-11-17)."""
    with open(path, encoding="utf-8") as f:
        src = f.read()
    m = TABLE.search(src)
    if not m:
        return None
    row = dict(DRAFT_ROW, html=code or "en")
    return src[:m.end(2)] + ",\n  " + json.dumps(row, ensure_ascii=False) + "\n" + src[m.start(3):]


class State:
    """The line map, made from the app's scripts in the background as the server starts, and the translations folder that needs it; the
    English and the faces' letters the checks need (build_layer.py Checker, Stage 4)."""
    ready = threading.Event()
    map = None
    map_text = None
    error = None
    folder = None
    base = None
    covers = None
    checker = None
    checker_meta = None
    game = None


def checker():
    """The line checks for the folder's language as language.json and glossary.json now say (made again when either changes)."""
    try:
        meta = State.folder.language() or {}
    except (OSError, ValueError):
        meta = {}
    try:
        glossary = build_layer.read_glossary(FOLDER)
    except (OSError, ValueError):
        glossary = []
    if State.checker is None or State.checker_meta != (meta, glossary):
        State.checker = build_layer.Checker(FILES.read, State.base, State.map, meta, State.covers, glossary)
        State.checker_meta = (meta, glossary)
    return State.checker


def line_findings(written):
    """{line: [[level, kind, what], ...]} for the lines a save wrote, checked by themselves (an emptied line: none)."""
    ck = checker()
    ck.texts = State.folder.translated()
    out = {}
    for scene, rows in written.items():
        for r in rows:
            if not r:
                continue
            text, status = r.get("text", ""), r.get("status", "empty")
            out[r["id"]] = [list(f) for f in ck.line(r["id"], text, r, scene)] if text and status != "empty" else []
    return out


def make_map():
    try:
        State.map = line_map.build(read=FILES.read)
        State.map_text = line_map.dumps(State.map).encode("utf-8")
        State.base = json.loads(FILES.read("text.json"))
        State.covers = build_layer.font_cover(FILES.read)
        if FOLDER:
            State.folder = translations.Folder(FOLDER, State.map)
    except Exception as e:  # said on every request that needs it
        State.error = f"the line map could not be made from the app's scripts: {e!r}"
    State.ready.set()


class Dev(server.Handler):
    def send_body(self, status, data, kind):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_json(self, status, obj):
        self.send_body(status, json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), "application/json; charset=utf-8")

    def addressed_here(self):
        if (self.headers.get("Host") or "") not in HOSTS:
            self.send_json(403, {"error": "this server answers only to localhost"})
            return False
        return True

    def need_map(self):
        State.ready.wait(120)
        if State.error or State.map is None:
            self.send_json(503, {"error": State.error or "the line map is still being made"})
            return False
        return True

    def need_folder(self):
        if not self.need_map():
            return False
        if State.folder is None:
            self.send_json(404, {"error": "no translations folder: start the server with --translations <folder>"})
            return False
        return True

    def do_GET(self):
        if not self.addressed_here():
            return
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        try:
            if path in PAGES:
                return self.send_file(PAGES[path])
            m = TOOL_FILE.fullmatch(path)
            if m:
                full = os.path.join(TRANSLATOR, m[1])
                return self.send_file(full) if os.path.isfile(full) else self.fail(404, "not found")
            if path in ("/fit/line_map.json", "/translator/api/map"):
                if self.need_map():
                    self.send_body(200, State.map_text, "application/json")
                return
            if path == "/translator/api/state":
                return self.send_json(200, self.state())
            if path == "/translator/api/folder":
                if self.need_folder():
                    self.send_json(200, State.folder.load())
                return
            if path == "/translator/api/check":
                if self.need_folder():
                    self.send_json(200, self.check())
                return
            if path == "/translator/api/export":
                if self.need_folder():
                    self.export()
                return
            self.game_file(path)
        except ConnectionError:
            pass
        except Exception as e:  # one bad request must not stop the server
            sys.stderr.write(f"{path}: {e!r}\n")
            try:
                self.fail(500, repr(e))
            except Exception:
                pass

    def state(self):
        State.ready.wait(120)
        table = FILES.page_file("js/languages.js")
        lang = None
        if State.folder:
            try:
                lang = State.folder.language()
            except (OSError, ValueError):
                lang = None
        return {"token": TOKEN, "app": FILES.describe(), "languages": FILES.languages(), "folder": FOLDER,
                "code": (lang or {}).get("code"), "lines": State.map["source"]["lines"] if State.map else None, "error": State.error,
                "play": bool(FOLDER and table and languages_js(table, None)), "port": PORT}

    def check(self):
        """Every check on the folder as it is on disk (build_layer.py check_all, as a build runs it, without the page fit)."""
        meta = State.folder.language() or {}
        r = build_layer.check_all(meta.get("code") or "xx", FOLDER, FILES.read, State.base, State.map, covers=State.covers)
        return {"findings": r["findings"], "counts": r["counts"], "untranslated": r["untranslated"]}

    def game(self):
        if State.game is None:
            State.game = exchange.Game(read=FILES.read, line_map=State.map)
        return State.game

    def export(self):
        """GET /translator/api/export?format=csv|po|xliff|deepluna[&scenes=REGEX][&all=1]: the folder in that format, as a download (exchange.py;
        deepLuna's readable format is a folder of scene files: a zip of them)."""
        import tempfile
        import zipfile
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        fmt = (q.get("format") or ["csv"])[0]
        if fmt not in exchange.FORMATS:
            return self.send_json(400, {"error": f"format: one of {', '.join(exchange.FORMATS)}"})
        scenes = (q.get("scenes") or [None])[0]
        code = (State.folder.language() or {}).get("code") or "xx"
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "deepluna" if fmt == "deepluna" else f"{code}.{fmt}")
            n = exchange.export(fmt, self.game(), FOLDER, out, scenes, (q.get("all") or ["0"])[0] == "1")
            if fmt == "deepluna":
                buf = io.BytesIO()
                with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                    for f in sorted(os.listdir(out)):
                        z.write(os.path.join(out, f), f"{code}-deepluna/{f}")
                data, name, kind = buf.getvalue(), f"{code}-deepluna.zip", "application/zip"
            else:
                with open(out, "rb") as f:
                    data = f.read()
                name = os.path.basename(out)
                kind = {"csv": "text/csv", "po": "text/x-gettext-translation", "xliff": "application/xliff+xml"}[fmt] + "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'attachment; filename="{name}"')
        self.send_header("X-Lines", str(n))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def import_file(self, req):
        """POST /translator/api/import {format, name, data (the file's text), dry, overwrite, status}: exchange.py's import, the report back."""
        import tempfile
        fmt = req.get("format") if isinstance(req, dict) else None
        if fmt not in exchange.FORMATS or not isinstance(req.get("data"), str):
            return self.send_json(400, {"error": f'not {{"format": one of {", ".join(exchange.FORMATS)}, "data": the file\'s text}}'})
        status = req.get("status") or "draft"
        if status not in ("draft", "reviewed", "final"):
            return self.send_json(400, {"error": "status: draft, reviewed or final"})
        suffix = {"csv": ".csv", "po": ".po", "xliff": ".xliff", "deepluna": ".txt"}[fmt]
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, f"upload{suffix}")
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(req["data"])
            try:
                r = exchange.import_(fmt, path, FOLDER, self.game(), status, bool(req.get("overwrite")), bool(req.get("dry")))
            except Exception as e:  # (a file another tool wrote may be anything: it is not read, and the folder is not touched)
                return self.send_json(400, {"error": f"not read: {e}"})
        r["files"] = sorted(r["files"])
        self.send_json(200, r)

    def draft(self, rel):
        """/assets/draft/: the translation laid over the English, as it is in the folder now."""
        if rel == "index.json":
            return self.send_json(200, {"files": ["text.json"]})
        if rel != "text.json":
            return self.fail(404, "not found")
        if not self.need_folder():
            return
        text = json.loads(FILES.read("text.json"))
        for i, t in State.folder.translated().items():
            if 0 <= i < len(text):
                text[i] = t
        self.send_body(200, json.dumps(text, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), "application/json")

    def game_file(self, path):
        """The page's files and the game's, from the app's folders (gamefiles.py), a language's small files out of its pack where need be."""
        if path.startswith("/assets/draft/") and FOLDER:
            return self.draft(path[14:])
        if path == "/js/languages.js" and FOLDER:
            table = FILES.page_file("js/languages.js")
            State.ready.wait(120)
            try:
                code = (State.folder.language() or {}).get("code") if State.folder else None
            except (OSError, ValueError):
                code = None
            src = table and languages_js(table, code)
            if src:
                return self.send_body(200, src.encode("utf-8"), "text/javascript; charset=utf-8")
        if path.startswith("/assets/"):
            rel = path[8:]
            full = FILES.asset_path(rel)
            if full:
                return self.send_file(full)
            packed = FILES.packed(rel)
            if packed:
                data = FILES.read(rel)
                return self.send_body(200, data, mimetypes.guess_type(rel)[0] or "application/octet-stream")
            return self.fail(404, "not found")
        full = FILES.page_file("index.html" if path == "/" else path.lstrip("/"))
        return self.send_file(full) if full else self.fail(404, "not found")

    def do_POST(self):
        # the connection is not kept: a request refused before its body is read must not leave that body to be read as the next request
        self.close_connection = True
        if not self.addressed_here():
            return
        path = urllib.parse.urlparse(self.path).path
        if path not in ("/translator/api/save", "/translator/api/language", "/translator/api/glossary", "/translator/api/import"):
            return self.send_json(404, {"error": "not found"})
        # only the editor's own page: its origin, a JSON body (a page elsewhere cannot send one without asking first), the server's token
        if (self.headers.get("Origin") or "") not in ORIGINS:
            return self.send_json(403, {"error": "not from the editor's page"})
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return self.send_json(415, {"error": "a JSON body is wanted"})
        if not secrets.compare_digest(self.headers.get("X-Translator-Token") or "", TOKEN):
            return self.send_json(403, {"error": "the editor's token is wrong: reload the editor (the server was started again)"})
        try:
            size = int(self.headers.get("Content-Length") or "-1")
        except ValueError:
            size = -1
        if not 0 <= size <= MOST_BODY:
            return self.send_json(413, {"error": "no body, or one too large"})
        try:
            req = json.loads(self.rfile.read(size).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self.send_json(400, {"error": "not JSON"})
        if not self.need_folder():
            return
        if path.endswith("/import"):
            return self.import_file(req)
        try:
            out = State.folder.save(req) if path.endswith("/save") else State.folder.set_language(req) if path.endswith("/language") \
                else State.folder.set_glossary(req)
            if path.endswith("/save"):
                out["findings"] = line_findings(out["written"])
            self.send_json(200, out)
        except translations.Refused as r:
            self.send_json(r.status, r.body)
        except OSError as e:
            self.send_json(500, {"error": f"not written: {e}"})


if __name__ == "__main__":
    threading.Thread(target=make_map, daemon=True).start()
    srv = server.Server(("127.0.0.1", PORT), Dev)
    print(f"http://localhost:{PORT}/translator/  http://localhost:{PORT}/fit/  http://localhost:{PORT}/smoketest.html", flush=True)
    print(f"game files: {'; '.join(FILES.describe())}", flush=True)
    print(f"translations: {FOLDER or 'none (--translations <folder>)'}", flush=True)
    srv.serve_forever()
