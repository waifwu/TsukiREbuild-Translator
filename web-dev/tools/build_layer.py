#!/usr/bin/env python3
"""build_layer.py <code> <translations folder> [--root R | --app DIR ...] [--out DIR] [--base text.json] [--map line_map.json] [--fit report] [--check]
A translation laid over the English -> web/assets/<code>/text.json and index.json (the translator tool's Stage 1: web-dev/TRANSLATOR-TOOL-PLAN.md).

The game's files come from this checkout's web/assets (--root: another checkout), or with --app from an installed copy of the port, as the
editor's server reads it (web-dev/tools/gamefiles.py: a web/ folder, the desktop app's www, its data folder; the first named that has a file gives
it). Over an app, name the folder to write to with --out.

The port plays a text-only language as a layer over the English (web/app/js/lang.js LAYERS, the language's row in web/app/js/languages.js): the
English's scripts, pictures and menus, with the lines of its own text.json. That file has all 43,960 lines, numbered as the port numbers them:
the translation where it has a line, the English (Tsukihimates, web/assets/text.json) everywhere else, so an unfinished translation goes on in
English where it stops.

The translations folder is the translators' (their own repository: the plan's decision 1), one file a scene and an optional language.json:

  <folder>/<scene>.json     {"scene": "05_01_CIEL05_3", "lines": [{"id": 13002, "text": "...", "status": "draft", "note": "",
                             "from": {"lang": "ja", "hash": "<12 hex>"}}, ...]}
  <folder>/language.json    {"code": "pt", "breaks": "deepluna" | "none", ...}

  id       the port's line number (web-dev/data/line_map.json says where each is); a line is in the file of a scene that shows it
  text     the line as the port is to show it: the text box's markup (textbox.js parseMarkup: italic letters, <base|reading>, @g @t @b @k,
           [ber00] [zap00], ^ for a row break of the translator's own)
  status   empty (not translated: the English is shown), draft, reviewed or final
  from     what it was translated from: the language (ja, en, aniplex, ...) and the first 12 hex of the SHA-1 of that line as that language's
           text.json has it (line_hash), so a source line changed since shows as stale
  breaks   "deepluna": the lines carry deepLuna's 55-cell row breaks, as the Tsukihimates English and an imported deepLuna project do; the port
           takes out the ones that only wrapped a full row (app/js/reflow.js) and the text box wraps the rest. "none" (the default): the lines
           have no such breaks and the text box wraps them; a line break in a story line is then flagged, as reflow.js may take it out (^ is a
           row break the port keeps). The Q&A corners keep every row as written.

Checks (the translator tool's Stage 4: class Checker; the editor's server runs the same on every line saved and on the whole folder), run before
anything is written. An error stops the build (exit 1), a warning is reported, a note is counted:
  errors    no such folder, or none of its files a scene's; a file that is not of this shape, or not named after its scene; an unknown status; a
            line number outside the text, or given twice; a line filed under a scene that does not show it (with the line map); tabs, carriage
            returns, deepLuna codes (%{...}) or U+FFFD in a line; @ marks or [tags] the English never uses; a ruby <base|reading> not closed
  warnings  a choice with a row break (a choice is one row); a line translated from a source line that has changed since (stale); a line left as
            its source, or the same as the English (three words or more); a line break in a story line of a "none" language; a line the scripts
            never show; Japanese letters or marks left in; the markup the English's scripts need, changed (@t @b @k, [ber00] [zap00] runs, ruby
            dropped); a letter the bundled story face lacks (Gelasio: story-font-cover.json, web-dev/tools/font_cover.mjs) or, in the corners,
            the balloons' face (the game's SeuratPro), that the English never uses; three or more lines in a row that open or close a quotation
            unlike the Japanese where the English agrees with the Japanese (a line out of place); a page with lines in both languages
  notes     italics the English has dropped; @g changed; a corner line that ends with a row break where the English's does not (or the other
            way); the same source line (8 letters or more) translated two ways
  untranslated: how many lines the scripts show are not translated yet, and in how many scenes.
The page-fit checks (a page past 12 rows, a choice wider than the English's widest, choices pushed over the text, a letter off a corner's
balloon) need the text box: run the fit page's runner (web-dev/fit/run-mcp.js) on dev_server.py's /assets/draft/text.json, which is this
build's text, and give its report with --fit FILE. Only a report made from exactly this text is taken (its textSha1), and only on pages with a
line of the translation (a page all in English is the English's own). The editor runs the same over every translated page ("Check every page's
fit").
"""
import glob
import hashlib
import importlib.util
import json
import os
import re
import sys

STATUSES = ("empty", "draft", "reviewed", "final")
HERE = os.path.dirname(os.path.abspath(__file__))
SCENE_NAME = re.compile(r"[A-Za-z0-9_]{1,64}")


def _tool(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, f"{name}.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def scene_text(scene, rows):
    """A scene file as the tools write it: one line a row, so a change is a one-line diff (build_pt.py's import and the editor both write this)."""
    body = ",\n".join(json.dumps(r, ensure_ascii=False, separators=(", ", ": ")) for r in rows)
    return f'{{"scene": {json.dumps(scene)}, "lines": [\n{body}\n]}}\n'


def write_whole(path, text):
    """A file written whole or not at all: beside its place first, then renamed over it."""
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def reader(root=None, app=None):
    """read(rel) -> a game file's bytes or None: from --app folders (gamefiles.py), else from root/web/assets."""
    if app:
        return _tool("gamefiles").GameFiles(app).read
    return _tool("line_map").disk_reader(os.path.join(root, "web", "assets"))


def line_hash(text):
    """The first 12 hex of the SHA-1 of a line (UTF-8), as a translation's `from.hash` keeps it."""
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def load_line_map(read, path=None):
    """The line map: from `path` (line_map.json), else made now from the scripts `read` gives (line_map.py), else None."""
    if path:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    if read("scripts/index.json") is None:
        return None
    return _tool("line_map").build(read=read)


RESERVED = ("language.json", "glossary.json")   # a translations folder's files that are not scenes


def read_glossary(folder):
    """glossary.json's terms ([] where there is none): [{"ja": ..., "en": ..., "target": ..., "also": [...], "note": ...}] (Stage 5)."""
    path = os.path.join(folder, "glossary.json")
    if not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    terms = data.get("terms") if isinstance(data, dict) else None
    return [t for t in terms if isinstance(t, dict)] if isinstance(terms, list) else []


def read_folder(folder):
    """(language.json or {}, [(file name, its JSON or an error string)])."""
    meta = {}
    lang_file = os.path.join(folder, "language.json")
    if os.path.isfile(lang_file):
        with open(lang_file, encoding="utf-8") as f:
            meta = json.load(f)
    files = []
    for path in sorted(glob.glob(os.path.join(folder, "*.json"))):
        name = os.path.basename(path)
        if name in RESERVED:
            continue
        try:
            with open(path, encoding="utf-8") as f:
                files.append((name, json.load(f)))
        except (OSError, ValueError) as e:
            files.append((name, f"not JSON: {e}"))
    return meta, files


def source_text(read, lang):
    """A language's text.json (the English's is text.json itself), or None where it is not here."""
    if not re.fullmatch(r"[a-z]{2,12}", lang or ""):
        return None
    raw = read("text.json" if lang == "en" else f"{lang}/text.json")
    return None if raw is None else json.loads(raw)


MARK = re.compile(r"@[a-z][0-9]?")        # (ASCII digits: "@t２" is the @t mark and a letter)
TAG = re.compile(r"\[[a-z]+[0-9]*\]")
CJK = re.compile(r"[\u3001-\u303f\u3040-\u30ff\u3400-\u9fff\uff01-\uff60\uff66-\uff9f]")   # (Japanese letters, kana and marks; U+3000 is a space)
ITALIC = re.compile(r"[\ue021-\ue07e]")
RUBY = re.compile(r"<[^<>|]*\|[^<>]*>")
WORD = re.compile(r"[^\W\d_]{2,}")
JA_OPEN, JA_CLOSE = "「『“‘（(", "」』”’）)"
TL_OPEN, TL_CLOSE = "\"“„«‘'「『(", "\"”»’'」』)"
FACES = ((0xE020, 0xE07E, 0xE000), (0xE0A0, 0xE0FE, 0xE080), (0xE120, 0xE17E, 0xE100), (0xE1A0, 0xE1FE, 0xE180), (0xE2A0, 0xE2FE, 0xE280))
LEVELS = ("error", "warning", "note")
QUOTE_RUN = 3          # lines in a row whose quotes disagree with the Japanese (and the English agrees with it): a line out of place?
SAME_SOURCE = 8        # a source line this long or longer, translated two ways, is noted


def readable(s):
    """A line with the italic letters and the patch's other faces as plain ASCII (web-dev/translator/markup.js readable): the same length."""
    def letter(m):
        c = ord(m.group())
        for a, b, off in FACES:
            if a <= c <= b:
                return chr(c - off)
        return m.group()
    return re.sub("[\ue020-\ue2fe]", letter, s)


def quote_shape(s, opens, closes):
    """(opens a quotation, closes one): the line's first and last letters, marks and indents aside."""
    s = re.sub(r"@(c\d|[a-z])", "", readable(s)).replace("\ue3fe", "").replace("\ue3ff", " ").replace("\n", " ").replace("^", " ").strip(" \u3000")
    return (bool(s) and s[0] in opens, bool(s) and s[-1] in closes)


# ---- the faces' letters ----------------------------------------------------------------------------------------------------------------
def cmap_codes(cmap):
    """The code points a font's cmap table maps to a glyph (formats 4 and 12; web-dev/tools/font_cover.mjs reads them the same way)."""
    import struct
    n = struct.unpack_from(">H", cmap, 2)[0]
    subs = [struct.unpack_from(">HHI", cmap, 4 + 8 * k) for k in range(n)]
    fmt = lambda off: struct.unpack_from(">H", cmap, off)[0]
    pick = next((o for _, _, o in subs if fmt(o) == 12), None) or next((o for p, _, o in subs if fmt(o) == 4 and p in (0, 3)), None)
    if pick is None:
        return set()
    codes = set()
    if fmt(pick) == 12:
        groups = struct.unpack_from(">I", cmap, pick + 12)[0]
        for g in range(groups):
            a, b, gid = struct.unpack_from(">III", cmap, pick + 16 + 12 * g)
            codes.update(c for c in range(a, b + 1) if gid + (c - a))
        return codes
    segs = struct.unpack_from(">H", cmap, pick + 6)[0] // 2
    ends, starts = pick + 14, pick + 16 + 2 * segs
    deltas, ranges = starts + 2 * segs, starts + 4 * segs
    for k in range(segs):
        end, start = struct.unpack_from(">H", cmap, ends + 2 * k)[0], struct.unpack_from(">H", cmap, starts + 2 * k)[0]
        delta, ro = struct.unpack_from(">h", cmap, deltas + 2 * k)[0], struct.unpack_from(">H", cmap, ranges + 2 * k)[0]
        for c in range(start, min(end, 0xFFFE) + 1):
            if not ro:
                gid = (c + delta) & 0xFFFF
            else:
                g = struct.unpack_from(">H", cmap, ranges + 2 * k + ro + 2 * (c - start))[0]
                gid = (g + delta) & 0xFFFF if g else 0
            if gid:
                codes.add(c)
    return codes


def sfnt_codes(data):
    """The code points an OpenType or TrueType font (not compressed) maps, or None."""
    import struct
    if not data or len(data) < 12:
        return None
    for k in range(struct.unpack_from(">H", data, 4)[0]):
        tag, _, off, length = struct.unpack_from(">4sIII", data, 12 + 16 * k)
        if tag == b"cmap":
            return cmap_codes(data[off:off + length])
    return None


def font_cover(read):
    """{"story": the code points of the bundled story face (Gelasio, story-font-cover.json), "balloon": of the corners' face (the game's
    SeuratPro-M.otf)}: None where not known."""
    out = {"story": None, "balloon": None}
    path = os.path.join(HERE, "story-font-cover.json")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            faces = json.load(f)["faces"]
        out["story"] = {c for face in faces.values() for a, b in face for c in range(a, b + 1)}
    try:
        out["balloon"] = sfnt_codes(read("fonts/SeuratPro-M.otf"))
    except Exception:
        out["balloon"] = None
    return out


# ---- the checks ------------------------------------------------------------------------------------------------------------------------
class Checker:
    """The checks on a translation's lines (the plan's Stage 4), run as a folder is built (check_all) and by the editor's server as lines are
    saved: line() on one line by itself, folder() on all the lines translated. Each finding is (level, kind, what): an error stops a build, a
    warning is reported, a note is shown (the editor) or counted (the build)."""

    def __init__(self, read, base, line_map=None, meta=None, covers=None, glossary=None):
        self.read, self.base, self.map, self.meta = read, base, line_map, meta or {}
        self.glossary = []   # [(term, [(lang, its pattern)], [targets, lowercased])]
        for t in glossary or []:
            target = t.get("target")
            if not isinstance(target, str) or not target.strip():
                continue
            forms = [(lang, form_pattern(lang, form)) for lang, form in t.items() if lang not in ("target", "also", "note") and isinstance(form, str) and form.strip()]
            wants = [w.lower() for w in [target] + [a for a in (t.get("also") or []) if isinstance(a, str) and a.strip()]]
            if forms:
                self.glossary.append((t, forms, wants))
        self.breaks = self.meta.get("breaks", "none")
        self.marks = {m for line in base for m in MARK.findall(line)} | {"@g", "@t", "@b", "@k"}
        self.tags = {t for line in base for t in TAG.findall(line)}
        self.sources = {"en": base}
        self.names, self.scenes_of, self.choice, self.unnamed, self.order, self.page_ids, self.qa = [], {}, set(), set(), {}, {}, set()
        self.message = {}    # line -> the lines of its message (itself and those glued to it, in order)
        self.texts = {}      # line -> its translation, for the checks that read a whole message (set by check_all, or the server)
        if line_map:
            self.names = [s["name"] for s in line_map["scenes"]]
            for ln in line_map["lines"]:
                i = ln["id"]
                self.scenes_of[i] = {self.names[a["s"]] for a in ln["at"]}
                if ln.get("choice"):
                    self.choice.add(i)
                if any(n.startswith("QA") for n in self.scenes_of[i]):
                    self.qa.add(i)
                live = [a for a in ln["at"] if not a.get("dead")]
                if i < len(base) and not base[i]:
                    continue   # (an empty line of the English's: nothing to translate, so no page is half done for it)
                if live:
                    self.order[i] = min((a["s"], a.get("pc", 0), a.get("nth", 0)) for a in live)
                for p in {a["page"] for a in live if a.get("page") is not None}:
                    self.page_ids.setdefault(p, []).append(i)
            self.unnamed = set(line_map["unnamed"])
            # a line glued to the one before it (set on its row: an MSAD, @x) is one message with it: the glossary reads the message whole
            glued = {ln["id"] for ln in line_map["lines"] if ln.get("glued")}
            by_scene = {}
            for i, (sc, pc, nth) in self.order.items():
                by_scene.setdefault(sc, []).append((pc, nth, i))
            for sc, items in by_scene.items():
                chain = []
                for _, _, i in sorted(items):
                    if not (i in glued and chain):
                        chain = []
                    chain.append(i)
                    self.message[i] = chain
        self.covers = covers if covers is not None else font_cover(read)
        self.en_chars = set("".join(base))
        self.en_qa_chars = set("".join(base[i] for i in self.qa if i < len(base)))
        self.own_cjk = self.meta.get("code") in ("ja", "zh", "ko")

    def has_form(self, i, lang, pattern):
        src = self.source(lang)
        return src is not None and i < len(src) and pattern.search(plain_line(src[i])) is not None

    def source(self, lang):
        if lang not in self.sources:
            self.sources[lang] = source_text(self.read, lang)
        return self.sources[lang]

    def line(self, i, text, row=None, scene=None):
        """[(level, kind, what)] for one translated line by itself."""
        out = []
        add = lambda level, kind, what: out.append((level, kind, what))
        base = self.base[i] if 0 <= i < len(self.base) else ""
        qa = scene.startswith("QA") if scene else i in self.qa
        bad = [what for ch, what in (("\t", "a tab"), ("\r", "a carriage return"), ("%{", "a deepLuna code"), ("\ufffd", "U+FFFD")) if ch in text]
        if bad:
            add("error", "bad character", ", ".join(bad))
        odd = sorted({m for m in MARK.findall(text) if m not in self.marks and not re.fullmatch(r"@c[0-5]", m)} | {t for t in TAG.findall(text) if t not in self.tags})
        if odd:
            add("error", "unknown mark", f"marks the English never uses: {' '.join(odd)}")
        depth, ok = 0, True
        for piece in re.findall(r"[<>|]", text):
            if piece == "<":
                depth += 1
                ok = ok and depth == 1
            elif piece == ">":
                depth -= 1
                ok = ok and depth == 0
        if not ok or depth or any("|" not in r for r in re.findall(r"<[^<>]*>", text)):
            add("error", "ruby not closed", "a ruby <base|reading> not closed")
        if i in self.choice and ("\n" in text or "^" in text):
            add("warning", "choice with a row break", "a choice is one row")
        if self.breaks == "none" and not qa and "\n" in text:
            add("warning", "line break in a story line", "the port may take it out (reflow.js); ^ is a row break it keeps")
        src = (row or {}).get("from") or {}
        left = False
        if isinstance(src, dict) and src.get("lang"):
            st = self.source(src["lang"])
            if st is not None and i < len(st):
                if src.get("hash") and src["hash"] != line_hash(st[i]):
                    add("warning", "stale", f"its {src['lang']} line has changed since it was translated")
                if text == st[i] and src["lang"] != "en":
                    add("warning", "source left in", f"the same as its {src['lang']} line")
                    left = True
        if not left and text == base and len(WORD.findall(readable(text))) >= 3:
            add("warning", "source left in", "the same as the English line")
        # the glossary: a term the line's source has, without its agreed translation (or one of its other forms)
        if self.glossary:
            msg = self.message.get(i, [i])
            plain_tl = " ".join(plain_line(text if j == i else self.texts.get(j, "")) for j in msg).lower()
            for t, forms, wants in self.glossary:
                hit = next(((lang, form) for lang, form in forms if any(self.has_form(j, lang, form) for j in msg)), None)
                if hit and not any(w in plain_tl for w in wants):
                    add("warning", "glossary", f"{t.get(hit[0])} ({hit[0]}) is {t['target']}" + (f" (or {', '.join(t['also'])})" if t.get("also") else "") + " here")
        if not self.own_cjk and CJK.search(text) and not CJK.search(base):
            add("warning", "Japanese letters left in", " ".join(sorted(set(CJK.findall(text))))[:40])
        # the markup the English's scripts and text box need, kept
        for m in ("@t", "@b", "@k"):
            a, b = base.count(m), text.count(m)
            if a != b:
                add("warning", "markup changed", f"{m}: the English has {a}, this has {b}")
        for t in sorted(set(TAG.findall(base)) | set(TAG.findall(text))):
            a, b = base.count(t), text.count(t)
            if a != b:
                add("warning", "markup changed", f"{t}: the English has {a}, this has {b}")
        if RUBY.search(base) and not RUBY.search(text):
            add("warning", "markup changed", "ruby: the English has some, this has none")
        if ITALIC.search(base) and not ITALIC.search(text):
            add("note", "italics dropped", "the English has italics, this has none")
        if base.count("@g") != text.count("@g"):
            add("note", "@g changed", f"the English has {base.count('@g')}, this has {text.count('@g')}")
        if qa and base and base.endswith(("^", "\n")) != text.endswith(("^", "\n")):
            add("note", "corner rows differ", "the English ends with a row break, this does not" if base.endswith(("^", "\n")) else "this ends with a row break, the English does not")
        # the patch's faces as the port draws them (textbox.js letterOf): a private-use letter outside them is drawn as nothing; letters in the
        # mirrored bank (U+E080 + ASCII) where the English has no mirrored line are another font's (a patch made for another build may write
        # italic accents there, U+E000 + Latin-1: its italic á would be the port's mirrored a)
        odd = sorted({c for c in text if 0xE000 <= ord(c) <= 0xF8FF and not port_face(c)})
        if odd:
            add("warning", "a face the port does not draw", " ".join(f"U+{ord(c):04X}" for c in odd[:8]) + (" ..." if len(odd) > 8 else ""))
        mirrored = sorted({c for c in text if 0xE080 <= ord(c) <= 0xE0FF})
        if mirrored and not any(0xE080 <= ord(c) <= 0xE17F for c in base):
            add("warning", "mirrored letters", f"{' '.join(f'U+{ord(c):04X}' for c in mirrored[:8])}: the port draws a mirrored "
                f"{chr(ord(mirrored[0]) - 0xE080)} for U+{ord(mirrored[0]):04X}; in a font of italic accents it is an italic {chr(ord(mirrored[0]) - 0xE000)}")
        # the faces' letters: a letter the bundled face lacks, and the English never uses (the port copes with those already)
        # (spaces of any width are left to the face that has them, and Japanese letters and marks have their own check)
        letters = {ch for ch in readable(text) if not ("\ue000" <= ch <= "\uf8ff") and not ch.isspace() and ch != "^" and not CJK.match(ch)}
        story = self.covers.get("story")
        if story is not None:
            miss = sorted(ch for ch in letters if ord(ch) not in story and ch not in self.en_chars)
            if miss:
                add("warning", "a letter the story face lacks", f"{' '.join(f'{c} (U+{ord(c):04X})' for c in miss[:8])}: drawn from another face where "
                    f"Georgia is not (Android)")
        balloon = self.covers.get("balloon")
        if qa and balloon is not None:
            miss = sorted(ch for ch in letters if ord(ch) not in balloon and ch not in self.en_qa_chars and ch.strip())
            if miss:
                add("warning", "a letter the balloons' face lacks", f"{' '.join(f'{c} (U+{ord(c):04X})' for c in miss[:8])}: drawn from the story face "
                    f"in the corner's balloon")
        return out

    def folder(self, done):
        """[(level, kind, what, file, line)] over every translated line: done is {line: (text, row, file)}."""
        out = []
        ja = self.source("ja")
        # quotes: lines in a row that open or close a quotation unlike the Japanese, where the English agrees with the Japanese
        if ja is not None and self.order:
            by_scene = {}
            for i, (s, pc, nth) in self.order.items():
                by_scene.setdefault(s, []).append((pc, nth, i))
            for s, items in sorted(by_scene.items()):
                run = []
                for _, _, i in sorted(items) + [(None, None, None)]:
                    off = False
                    if i is not None and i in done and i < len(ja):
                        sj = quote_shape(ja[i], JA_OPEN, JA_CLOSE)
                        off = sj == quote_shape(self.base[i], TL_OPEN, TL_CLOSE) and quote_shape(done[i][0], TL_OPEN, TL_CLOSE) != sj
                    if off:
                        run.append(i)
                        continue
                    if len(run) >= QUOTE_RUN:
                        out.append(("warning", "quote shape", f"lines {run[0]} to {run[-1]} ({len(run)} in a row) open or close a quotation unlike the "
                                    f"Japanese and the English: a line out of place?", done[run[0]][2], run[0]))
                    run = []
        # a page with lines in both languages
        for p, ids in sorted(self.page_ids.items()):
            have = [i for i in ids if i in done]
            if have and len(have) < len(ids):
                pg = self.map["pages"][p] if p < len(self.map.get("pages", [])) else {"s": 0, "k": p}
                left = [i for i in ids if i not in done]
                out.append(("warning", "page partly translated", f"{self.names[pg['s']]} page {pg['k'] + 1}: {len(have)} of {len(ids)} lines translated; "
                            f"in English: {', '.join(map(str, left[:6]))}{' ...' if len(left) > 6 else ''}", done[have[0]][2], left[0]))
        # the same source line translated two ways
        groups = {}
        for i, (text, row, f) in done.items():
            lang = ((row or {}).get("from") or {}).get("lang") or ("ja" if ja is not None else "en")
            st = self.source(lang)
            if st is None or i >= len(st):
                continue
            key = st[i]
            if len(readable(key).replace("\u3000", "").replace("\ue3fe", "").strip()) < SAME_SOURCE:
                continue
            norm = re.sub(r"\s+", " ", text.replace("^", " ").replace("\u3000", " ")).strip()
            groups.setdefault((lang, key), {}).setdefault(norm, []).append(i)
        for (lang, _), ways in groups.items():
            if len(ways) > 1:
                ids = sorted(i for v in ways.values() for i in v)
                out.append(("note", "translated two ways", f"the same {lang} line is translated {len(ways)} ways: lines {', '.join(map(str, ids[:8]))}",
                            done[ids[0]][2], ids[0]))
        return out

    def untranslated(self, done):
        """{lines, of, scenes}: the lines the scripts show that the folder has not translated."""
        shown = [i for i in self.order]
        left = [i for i in shown if i not in done]
        scenes = sorted({self.names[self.order[i][0]] for i in left}) if self.names else []
        return {"lines": len(left), "of": len(shown), "scenes": len(scenes)}


def port_face(c):
    """Whether the port draws this private-use letter (web/app/js/textbox.js letterOf: italic, mirrored, mirrored italic, archaic, upside down
    letters of ASCII, the exponent; and the engine's row marks U+E3FE, U+E3FF)."""
    o = ord(c)
    return any(a <= o <= b for a, b, _ in FACES) or o in (0xE200, 0xE3FE, 0xE3FF)


def plain_line(s):
    """A line as words: faces as letters, a ruby as its base, row breaks and the engine's rows as spaces, marks out (the glossary reads this)."""
    s = re.sub(r"<([^<>|]*)\|[^<>]*>", r"\1", readable(s))
    s = re.sub(r"@(c\d|[a-z])|\[[a-z]+\d*\]", "", s)
    return re.sub(r"[\n^\ue3fe\ue3ff]", " ", s)


def form_pattern(lang, form):
    """How a glossary form is found in a source line: as a word in a language with spaces (any case), as it is in Japanese and Chinese."""
    if lang in ("ja", "zh"):
        return re.compile(re.escape(form))
    return re.compile(r"(?<![^\W_])" + re.escape(form) + r"(?![^\W_])", re.I)


def fit_findings(report, text, done=None):
    """The page-fit findings of a fit report (web-dev/fit/run-mcp.js) made from exactly this text, else one warning saying it is of another.
    Only pages with a line of the translation count (`done`): a page all in English is the English's own (page 7936 is 14 rows in English)."""
    want = hashlib.sha1(json.dumps(text, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    if report.get("textSha1") != want:
        return [("warning", "fit report out of date", "the fit report was made from another text than this build's: run the fit runner again on "
                 "/assets/draft/text.json (dev_server.py) and give its report with --fit", None, None)]
    out = []
    for f in report.get("findings", []):
        ids = f.get("ids") or []
        mine = [i for i in ids if done is None or i in done]
        if done is None or mine:
            out.append(("warning", f["kind"], f["what"], done[mine[0]][2] if done and mine else None, mine[0] if mine else None))
    return out


def check_all(code, folder, read, base, line_map=None, covers=None, fit=None):
    """Every check on a translations folder: {"lines": {id: text}, "errors": [str], "warnings": {kind: [str]}, "notes": {kind: [str]},
    "findings": [{level, kind, what, file, id}], "counts", "meta", "untranslated"}."""
    findings = []

    def add(level, kind, what, file=None, i=None):
        findings.append({"level": level, "kind": kind, "what": what, "file": file, "id": i})

    counts = {s: 0 for s in STATUSES}
    result = {"lines": {}, "counts": counts, "meta": {}, "findings": findings, "untranslated": None}
    if not os.path.isdir(folder):
        add("error", "folder", f"{folder}: no such folder")
        return finish(result)
    meta, files = read_folder(folder)
    result["meta"] = meta
    if not files:
        add("error", "folder", f"{folder}: no scene files (<scene>.json): nothing to build")
    breaks = meta.get("breaks", "none")
    if breaks not in ("none", "deepluna"):
        add("error", "language.json", f"language.json: breaks is {breaks!r}, not \"none\" or \"deepluna\"")
    if meta.get("code") and meta["code"] != code:
        add("error", "language.json", f"language.json is for {meta['code']!r}, not {code!r}")
    try:
        glossary = read_glossary(folder)
    except (OSError, ValueError) as e:
        glossary = []
        add("error", "glossary", f"glossary.json: not JSON: {e}", "glossary.json")
    checker = Checker(read, base, line_map, meta, covers, glossary)
    seen, done, lines = {}, {}, result["lines"]
    for name, data in files:
        if isinstance(data, str):
            add("error", "file", f"{name}: {data}", name)
            continue
        scene = data.get("scene") if isinstance(data, dict) else None
        if not isinstance(scene, str) or not isinstance(data.get("lines"), list):
            add("error", "file", f"{name}: not {{\"scene\": ..., \"lines\": [...]}}", name)
            continue
        if name != f"{scene}.json":
            add("error", "file", f"{name}: the file of scene {scene} is named {scene}.json", name)
        for k, ln in enumerate(data["lines"]):
            if not isinstance(ln, dict) or not isinstance(ln.get("id"), int) or not isinstance(ln.get("text", ""), str):
                add("error", "file", f"{name} line {k}: not {{\"id\": <number>, \"text\": \"...\", \"status\": ...}}", name)
                continue
            i, text, status = ln["id"], ln.get("text", ""), ln.get("status", "draft" if ln.get("text") else "empty")
            where = f"{name} id {i}"
            if status not in STATUSES:
                add("error", "status", f"{where}: status {status!r} is none of {', '.join(STATUSES)}", name, i)
                continue
            if not 0 <= i < len(base):
                add("error", "line", f"{where}: no such line (the text has {len(base)})", name, i)
                continue
            if i in seen:
                add("error", "line", f"{where}: given again (first in {seen[i]})", name, i)
                continue
            seen[i] = name
            if line_map and checker.scenes_of.get(i) and scene not in checker.scenes_of[i]:
                add("error", "line", f"{where}: scene {scene} does not show this line ({', '.join(sorted(checker.scenes_of[i]))} does)", name, i)
            if i in checker.unnamed:
                add("warning", "never shown", f"{where}: the scripts never show this line", name, i)
            if status == "empty" or not text:
                counts["empty"] += 1
                continue
            counts[status] += 1
            lines[i] = text
            done[i] = (text, ln, name)
    checker.texts = lines
    for i, (text, ln, name) in done.items():
        for level, kind, what in checker.line(i, text, ln, name[:-5]):
            add(level, kind, f"{name} id {i}: {what}", name, i)
    for level, kind, what, f, i in checker.folder(done):
        add(level, kind, f"{f}: {what}" if f else what, f, i)
    if fit is not None:
        text = list(base)
        for i, t in lines.items():
            text[i] = t
        for level, kind, what, f, i in fit_findings(fit, text, done):
            add(level, kind, what, f, i)
    result["untranslated"] = checker.untranslated(done) if line_map else None
    return finish(result)


def finish(result):
    result["errors"] = [f["what"] for f in result["findings"] if f["level"] == "error"]
    for level, key in (("warning", "warnings"), ("note", "notes")):
        out = {}
        for f in result["findings"]:
            if f["level"] == level:
                out.setdefault(f["kind"], []).append(f["what"])
        result[key] = out
    return result


def check(code, folder, read, base, line_map=None):
    """(lines {id: text}, errors [str], warnings {kind: [str]}, counts, meta): check_all as Stage 1 gave it."""
    r = check_all(code, folder, read, base, line_map)
    return r["lines"], r["errors"], r["warnings"], r["counts"], r["meta"]


def build(code, folder, root=None, out=None, base_path=None, map_path=None, write=True, say=print, read=None, line_map=None, fit=None):
    """Check, then (unless write is False or a check fails) write <out>/text.json and index.json. Returns (errors, warnings, counts).
    The game's files from `read` (reader()), else from root/web/assets; a line map already made may be given; `fit` is a fit report."""
    read = read or reader(root)
    if base_path:
        with open(base_path, encoding="utf-8") as f:
            base = json.load(f)
    else:
        raw = read("text.json")
        if raw is None:
            raise SystemExit("no text.json among the game's files: name the app's folder with --app (or --root, --base)")
        base = json.loads(raw)
    if line_map is None:
        line_map = load_line_map(read, map_path)
    if line_map is None:
        say("no line map (no scripts here, no --map): lines are not checked against their scenes")
    r = check_all(code, folder, read, base, line_map, fit=fit)
    lines, errors, warnings, counts = r["lines"], r["errors"], r["warnings"], r["counts"]
    for e in errors[:40]:
        say(f"error: {e}")
    if len(errors) > 40:
        say(f"... and {len(errors) - 40} errors more")
    for kind, found in warnings.items():
        say(f"warning: {kind}: {len(found)}" + "".join(f"\n  {w}" for w in found[:5]) + (f"\n  ... {len(found) - 5} more" if len(found) > 5 else ""))
    if r["notes"]:
        say("notes: " + ", ".join(f"{kind} {len(found)}" for kind, found in r["notes"].items()))
    if fit is None:
        say("no fit report (--fit): pages past 12 rows, wide choices and balloons not checked")
    translated = sum(1 for i, t in lines.items() if t)
    say(f"{code}: {translated} lines translated ({', '.join(f'{k} {v}' for k, v in counts.items())}); {len(base) - translated} in English")
    u = r["untranslated"]
    if u:
        say(f"untranslated: {u['lines']} of the {u['of']} lines the scripts show, in {u['scenes']} scenes")
    if errors:
        say(f"{len(errors)} errors: nothing written")
        return errors, warnings, counts
    if write:
        if not out and not root:
            raise SystemExit("name the folder to write the language to with --out")
        out = out or os.path.join(root, "web", "assets", code)
        text = list(base)
        for i, t in lines.items():
            text[i] = t
        os.makedirs(out, exist_ok=True)
        write_whole(os.path.join(out, "text.json"), json.dumps(text, ensure_ascii=False, separators=(",", ":")))
        write_whole(os.path.join(out, "index.json"), json.dumps({"files": ["text.json"]}, separators=(",", ":")))
        say(f"{os.path.join(out, 'text.json')}: {len(text)} lines, {sum(a != b for a, b in zip(text, base))} differ from the English")
    return errors, warnings, counts


def main(argv):
    opts, args = {"app": []}, []
    it = iter(argv[1:])
    for a in it:
        if a == "--app":
            opts["app"].append(next(it, None))
        elif a in ("--root", "--out", "--base", "--map", "--fit"):
            opts[a[2:]] = next(it, None)
        elif a == "--check":
            opts["check"] = True
        else:
            args.append(a)
    if len(args) != 2:
        raise SystemExit(__doc__)
    code, folder = args
    root = None if opts["app"] else os.path.abspath(opts.get("root") or os.path.join(HERE, "..", ".."))
    if not re.fullmatch(r"[a-z]{2,3}", code):
        raise SystemExit(f"{code!r}: a language's code is two or three small letters")
    try:
        read = reader(root, opts["app"])
    except ValueError as e:
        raise SystemExit(str(e))
    fit = None
    if opts.get("fit"):
        with open(opts["fit"], encoding="utf-8") as f:
            fit = json.load(f)
        if isinstance(fit, str):   # (as the Playwright MCP saves it: one JSON string)
            fit = json.loads(fit)
    errors, _, _ = build(code, folder, root, opts.get("out"), opts.get("base"), opts.get("map"), write=not opts.get("check"), read=read, fit=fit)
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main(sys.argv)
