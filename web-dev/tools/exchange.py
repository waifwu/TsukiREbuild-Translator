#!/usr/bin/env python3
"""exchange.py: a translation in and out of the formats other tools use (the translator tool's Stage 6, web-dev/TRANSLATOR-TOOL-PLAN.md).

  exchange.py export <csv|po|xliff|deepluna> <translations folder> <file or folder> [--scenes REGEX] [--all] [--source LANG] [game]
  exchange.py import <csv|po|xliff|deepluna> <file or folder> <translations folder> [--status S] [--overwrite] [--dry-run] [--db FILE]
              [--revision SUFFIX] [game]
      game: --app DIR ... (an installed copy of the port, web-dev/tools/gamefiles.py) or --root R (this checkout, the default)

Export writes the lines the scripts show (the translated ones only unless --all), scene by scene, with the source line (--source: the language
the folder is translated from, language.json "from", else Japanese) and the English beside each, the status and the note:
  csv       id, scene, page, status, <source>, en, text, note (UTF-8 with a byte order mark, as spreadsheets read it)
  po        gettext: msgctxt "<scene>#<id>", msgid the source, msgstr the translation; the English and the status as extracted comments (#.),
            the note as a translator comment (#), a draft "fuzzy"
  xliff     XLIFF 1.2, a <file> a scene, a <trans-unit id="<id>"> a line: <source> and <target state=...>, the note and the English as <note>s;
            italics and the patch's other faces as <g ctype="italic"> (x-mirrored, x-mirrored-italic, x-archaic, x-upside-down)
  deepluna  deepLuna's readable format, a <scene>.txt a scene, in blocks as deepLuna writes them, so that deepLuna reads them back:
            [offset:<id>]{ "-- Page <the scene's page>, Offset <id>.", the Japanese, "-- en: " the English (and the source), the line }, with
            the codes deepLuna writes (%{i} ... %{/i})
In CSV and PO the faces travel as <i>...</i> (and <m>, <mi>, <a>, <u>, <e/>; any other private-use letter as <pua XXXX/>), which no line of the
game has: read back, they are the same letters. The text box's own marks (@g, [ber00], ^, <base|reading>) are left as they are.

Import reads such a file back, or another tool's, and lays every line on its line number:
  csv       the columns id and text (others: status, note), named in the first row
  po        msgctxt "...#<id>"; an entry without one is laid on every line whose source (or English) is its msgid
  xliff     <trans-unit id="<id>"> (1.2) or <unit id> / <segment> (2.0); the state gives the status
  deepluna  a readable-format file or folder: a block on the line its first row names, "-- Page P, Offset N." (deepLuna writes it in every
            block, an [sha:H] one too), if the Japanese deepLuna writes under it is that line's; [offset:N]{...} on N; an [sha:H]{...} with no
            such row on the lines with that hash in --db deepluna_db.json. A line two blocks name with other texts takes the first; a block
            with no text (deepLuna's "-- TRANSLATION HERE") is passed over. Or a deepLuna project folder
            (deepluna_db.json and scripts/TL/, the legacy format), read by build_pt.py's rules: control codes applied, and with the project's
            database deepLuna's 55-cell row breaks (language.json "breaks": "deepluna"); --revision pt also tries a file named after a scene
            plus "pt" as another copy of it, the one that sits best kept (build_pt.py: HanabiWorks' revised scenes)
  textjson  (in only) a whole built text, a JSON list of every line: a language's text.json, as a release of the port has it
  mrg       (in only) a game patch's script_text.mrg (the Switch game's dialogue, its first language): a patch made with deepLuna, the
            Tsukihimates English's tool, is numbered as the port is
            For both, a line that is the English's is left out (the port shows it anyway), and so is a line in Japanese where the English has
            none (deepLuna leaves a line not translated in Japanese). The patch's own faces are taken as they are: the checks say where they
            are not the port's (build_layer.py "a face the port does not draw")
What it places, what was there already (kept unless --overwrite), and what it could not place, with why, is reported; --dry-run writes nothing.
The lines go into the translations folder through the editor's own save (translations.py), in the file of the scene that has them already or
else of the first scene that shows them, each with "from" (the source line's hash) and its status (the file's, else --status, draft).
Standard library only.
"""
import csv
import hashlib
import importlib.util
import io
import json
import os
import re
import struct
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
FORMATS = ("csv", "po", "xliff", "deepluna")
WHOLE = ("textjson", "mrg")   # import only: a whole built text (a language's text.json; a game patch's script_text.mrg)
STATUSES = ("empty", "draft", "reviewed", "final")
XLIFF_NS = "urn:oasis:names:tc:xliff:document:1.2"


_TOOLS = {}


def _tool(name):
    """A tool of this folder, loaded once."""
    if name not in _TOOLS:
        spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, f"{name}.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _TOOLS[name] = mod
    return _TOOLS[name]


# ---- the faces as tags ------------------------------------------------------------------------------------------------------------------
FACES = (("i", 0xE020, 0xE07E, 0xE000), ("m", 0xE0A0, 0xE0FE, 0xE080), ("mi", 0xE120, 0xE17E, 0xE100), ("a", 0xE1A0, 0xE1FE, 0xE180),
         ("u", 0xE2A0, 0xE2FE, 0xE280))
CODES = {"i": "i", "m": "r", "mi": "ri", "a": "g", "u": "flip_vertical"}   # deepLuna's control codes for the faces (build_pt.apply_codes)
EXPONENT = 0xE200


def face_of(c):
    o = ord(c)
    for name, a, b, off in FACES:
        if a <= o <= b:
            return name, chr(o - off)
    return None, c


def runs(s):
    """[(face or None, text)]: the line in runs of one face (its letters as ASCII), the exponent and other private-use letters by themselves."""
    out = []
    for c in s:
        o = ord(c)
        if o == EXPONENT:
            out.append(("e", ""))
            continue
        name, letter = face_of(c)
        if name is None and 0xE000 <= o <= 0xF8FF:
            out.append(("pua", f"{o:04X}"))
            continue
        if out and out[-1][0] == name and name not in ("e", "pua"):
            out[-1] = (name, out[-1][1] + letter)
        else:
            out.append((name, letter))
    return out


def to_tags(s):
    """A line with its faces as <i>...</i> (<m> <mi> <a> <u>, <e/>, <pua XXXX/>): what CSV and PO carry."""
    out = []
    for name, text in runs(s):
        if name is None:
            out.append(text)
        elif name == "e":
            out.append("<e/>")
        elif name == "pua":
            out.append(f"<pua {text}/>")
        else:
            out.append(f"<{name}>{text}</{name}>")
    return "".join(out)


TAG = re.compile(r"<(/?)(i|m|mi|a|u)>|<e/>|<pua ([0-9A-Fa-f]{4})/>")


def from_tags(s):
    """to_tags undone: the letters between <i> and </i> as italics, and so on. ValueError where the tags do not close."""
    out, face, at = [], None, 0
    for m in TAG.finditer(s):
        out.append(face_text(s[at:m.start()], face))
        at = m.end()
        if m.group(0) == "<e/>":
            out.append(chr(EXPONENT))
        elif m.group(3):
            out.append(chr(int(m.group(3), 16)))
        elif m.group(1):
            if face != m.group(2):
                raise ValueError(f"</{m.group(2)}> without <{m.group(2)}>")
            face = None
        else:
            if face:
                raise ValueError(f"<{m.group(2)}> inside <{face}>")
            face = m.group(2)
    if face:
        raise ValueError(f"<{face}> not closed")
    out.append(face_text(s[at:], face))
    return "".join(out)


def face_text(text, face):
    if not face:
        return text
    off = next(f[3] for f in FACES if f[0] == face)
    return "".join(chr(ord(c) + off) if 0x20 <= ord(c) <= 0x7E else c for c in text)


def to_codes(s, breaks="none"):
    """A line as deepLuna writes its scripts: the faces as %{i} ... %{/i} (and %{r} %{ri} %{g} %{flip_vertical}, %{e_35}). In a "deepluna"
    language a line break is a space again, deepLuna laying the rows out anew; a row of the translator's own is ^, which goes through as it is.
    (A %{n} the translator once wrote is not told apart from deepLuna's wraps in the port's text: on Portuguese, 38 of 24,757 lines read back
    with a row laid out otherwise. Telling them apart by whether the row was full, as reflow.js does, laid 85 out otherwise: deepLuna sets a
    glued line's first row part way along, and moves words between lines, which a row by itself does not show.) Elsewhere a line break is
    the translator's own: %{n}."""
    out = []
    for name, text in runs(re.sub(r" ?\n ?", " ", s) if breaks == "deepluna" else s.replace("\n", "%{n}")):
        if name is None:
            out.append(text)   # (a line never has "%{": build_layer.py refuses it, and deepLuna has no way to write one)
        elif name == "e":
            out.append("%{e_35}")
        elif name == "pua":
            out.append(chr(int(text, 16)))
        else:
            out.append(f"%{{{CODES[name]}}}{text}%{{/{CODES[name]}}}")
    return "".join(out)


# ---- where the lines are --------------------------------------------------------------------------------------------------------------
class Game:
    """The game's lines and the line map, from an installed app or this checkout."""

    def __init__(self, root=None, apps=None, read=None, line_map=None):
        if read:
            self.read = read           # (the editor's server: the app it reads, and the line map it made)
        elif apps:
            self.read = _tool("gamefiles").GameFiles(apps).read
        else:
            self.read = _tool("line_map").disk_reader(os.path.join(root, "web", "assets"))
        self.root = None if (apps or read) else root
        self.english = json.loads(self.read("text.json"))
        self.map = line_map or _tool("line_map").build(read=self.read)
        self.names = [s["name"] for s in self.map["scenes"]]
        self.order, self.first_scene, self.page = {}, {}, {}
        for ln in self.map["lines"]:
            live = [a for a in ln["at"] if not a.get("dead")] or ln["at"]
            if live:
                a = min(live, key=lambda a: (a["s"], a["pc"], a["nth"]))
                self.order[ln["id"]] = (a["s"], a["pc"], a["nth"])
                self.first_scene[ln["id"]] = self.names[a["s"]]
                pg = a.get("page")
                self.page[ln["id"]] = None if pg is None else self.map["pages"][pg]["k"] + 1
        self.texts = {"en": self.english}

    def text(self, lang):
        if lang not in self.texts:
            raw = self.read("text.json" if lang == "en" else f"{lang}/text.json")
            self.texts[lang] = json.loads(raw) if raw is not None else None
        return self.texts[lang]


def rows_of(folder):
    """{line: (its row, its file's scene)} from a translations folder."""
    Folder = _tool("translations").Folder
    f = Folder(folder)
    out = {}
    for scene, rows in f.load()["files"].items():
        for r in rows:
            out.setdefault(r["id"], (r, scene))
    return out


def language(folder):
    path = os.path.join(folder, "language.json")
    if not os.path.isfile(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ---- export ----------------------------------------------------------------------------------------------------------------------------
def export_lines(game, folder, scenes=None, every=False):
    """[(scene, id, row or None)] in script order: the lines the scripts show, translated ones only unless every."""
    have = rows_of(folder)
    pat = re.compile(scenes) if scenes else None
    out = []
    for i in sorted(game.order, key=lambda i: game.order[i]):
        scene = have[i][1] if i in have else game.first_scene[i]
        if pat and not pat.search(scene):
            continue
        row = have.get(i, (None,))[0]
        translated = bool(row and row.get("text") and row.get("status", "draft") != "empty")
        if translated or every:
            out.append((scene, i, row if translated else None))
    return out


def po_quote(s):
    body = s.replace("\\", "\\\\").replace('"', '\\"').replace("\t", "\\t").replace("\r", "\\r")
    parts = body.split("\n")
    if len(parts) == 1:
        return f'"{body}"'
    pieces = [p + "\\n" for p in parts[:-1]] + ([parts[-1]] if parts[-1] else [])
    return '""\n' + "\n".join(f'"{p}"' for p in pieces)


def reference(s):
    """A source or English line as the export shows it beside the translation: the engine's own rows (Japanese) and reflow's soft breaks out."""
    return (s or "").replace("\ue3fe", "").replace("\ue3ff", " ")


def export(fmt, game, folder, out, scenes=None, every=False, source=None):
    """Write the folder in a format: a file (csv, po, xliff) or a folder (deepluna). Returns how many lines."""
    meta = language(folder)
    code = meta.get("code") or "xx"
    source = source or meta.get("from") or ("ja" if game.text("ja") else "en")
    src = [reference(x) for x in (game.text(source) or game.english)]
    english = [reference(x) for x in game.english]
    lines = export_lines(game, folder, scenes, every)
    status = lambda row: (row or {}).get("status", "empty") if row else "empty"
    text = lambda row: (row or {}).get("text", "") if row else ""
    note = lambda row: (row or {}).get("note", "") if row else ""
    if fmt == "csv":
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\n")
        w.writerow(["id", "scene", "page", "status", source, "en", "text", "note"])
        for scene, i, row in lines:
            w.writerow([i, scene, game.page.get(i) or "", status(row), to_tags(src[i]), to_tags(english[i]), to_tags(text(row)), note(row)])
        data = "\ufeff" + buf.getvalue()
        write_file(out, data)
    elif fmt == "po":
        name = meta.get("name") or code
        head = [f"# Tsukihime: {name} ({code}), exported by the translator tool (web-dev/tools/exchange.py).", 'msgid ""', 'msgstr ""',
                '"Content-Type: text/plain; charset=UTF-8\\n"', f'"Language: {code}\\n"', f'"X-Source-Language: {source}\\n"', ""]
        body = []
        for scene, i, row in lines:
            if not src[i]:
                continue
            e = [f"#. en: {to_tags(english[i])}".replace("\n", "\\n")] if source != "en" else []
            e.append(f"#. status: {status(row)}")
            if note(row):
                e += [f"# {x}" for x in note(row).split("\n")]
            if status(row) == "draft":
                e.append("#, fuzzy")
            e += [f'msgctxt "{scene}#{i}"', f"msgid {po_quote(to_tags(src[i]))}", f"msgstr {po_quote(to_tags(text(row)))}", ""]
            body += e
        write_file(out, "\n".join(head + body))
    elif fmt == "xliff":
        ET.register_namespace("", XLIFF_NS)
        root = ET.Element(f"{{{XLIFF_NS}}}xliff", {"version": "1.2"})
        files = {}
        state = {"empty": "new", "draft": "needs-review-translation", "reviewed": "translated", "final": "final"}
        for scene, i, row in lines:
            if scene not in files:
                f = ET.SubElement(root, f"{{{XLIFF_NS}}}file", {"original": scene, "source-language": source, "target-language": code, "datatype": "plaintext"})
                files[scene] = ET.SubElement(f, f"{{{XLIFF_NS}}}body")
            u = ET.SubElement(files[scene], f"{{{XLIFF_NS}}}trans-unit", {"id": str(i), "{http://www.w3.org/XML/1998/namespace}space": "preserve"})
            put_runs(ET.SubElement(u, f"{{{XLIFF_NS}}}source"), src[i])
            put_runs(ET.SubElement(u, f"{{{XLIFF_NS}}}target", {"state": state[status(row)]}), text(row))
            if note(row):
                ET.SubElement(u, f"{{{XLIFF_NS}}}note", {"from": "translator"}).text = note(row)
            if source != "en":
                ET.SubElement(u, f"{{{XLIFF_NS}}}note", {"from": "en", "annotates": "source"}).text = to_tags(english[i])
        indent(root)
        write_file(out, '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="unicode") + "\n")
    elif fmt == "deepluna":
        os.makedirs(out, exist_ok=True)
        by_scene, lost = {}, []
        ja = [reference(x) for x in game.text("ja")] if game.text("ja") else None
        for scene, i, row in lines:
            by_scene.setdefault(scene, []).append((i, row))
        for scene, items in by_scene.items():
            parts = []
            for i, row in items:
                coded = to_codes(text(row), meta.get("breaks", "none"))
                # (the readable format drops what follows -- or //, and a line of nothing but spaces: such a line cannot be written in it)
                if row and (re.search(r"--|//", coded) or not coded.strip()):
                    lost.append(i)
                # A block as deepLuna writes one, so that deepLuna reads it back (it takes nothing between blocks, and its newer copies
                # want the "-- Page P, Offset N." row in each): the line's Japanese, the English and the source as "--" rows inside.
                head = [f"-- Page {game.page.get(i) or '?'}, Offset {i}."]
                if ja:
                    head.append(f"-- {ja[i]}".replace("\n", " "))
                head.append(f"-- en: {to_codes(english[i], 'deepluna')}")
                if source not in ("en", "ja"):
                    head.append(f"-- {source}: {to_codes(src[i])}")
                parts.append(f"[offset:{i}]{{\n" + "\n".join(head) + f"\n{coded}\n}}\n")
            write_file(os.path.join(out, f"{scene}.txt"), "\n".join(parts))
        if lost:
            print(f"{len(lost)} lines cannot be read back from deepLuna's readable format as they are (it takes -- and // for comments, and drops a "
                  f"line of spaces): {', '.join(map(str, lost[:12]))}")
    else:
        raise SystemExit(f"{fmt}: not a format ({', '.join(FORMATS)})")
    return len(lines)


def indent(el, level=0):
    """Rows and indents between XLIFF's elements, never inside a <source>, <target> or <note> (ET.indent would put them into the lines)."""
    if el.tag.split("}")[-1] in ("source", "target", "note"):
        return
    kids = list(el)
    if kids:
        el.text = "\n" + " " * (level + 1)
        for k in kids:
            indent(k, level + 1)
            k.tail = "\n" + " " * (level + 1)
        kids[-1].tail = "\n" + " " * level


def put_runs(el, s):
    """A line into an XLIFF element: its text, and each run of a face as <g ctype="..."> (the CAT tools show those as tags)."""
    ctype = {"i": "italic", "m": "x-mirrored", "mi": "x-mirrored-italic", "a": "x-archaic", "u": "x-upside-down"}
    last, k = None, 0
    el.text = ""
    for name, text in runs(s):
        if name is None:
            if last is None:
                el.text += text
            else:
                last.tail = (last.tail or "") + text
            continue
        k += 1
        if name in ("e", "pua"):
            g = ET.SubElement(el, f"{{{XLIFF_NS}}}x", {"id": str(k), "ctype": "x-exponent" if name == "e" else f"x-pua-{text}"})
        else:
            g = ET.SubElement(el, f"{{{XLIFF_NS}}}g", {"id": str(k), "ctype": ctype[name]})
            g.text = text
        last = g


def get_runs(el):
    """put_runs undone (and plain text from another tool's XLIFF, its other inline elements read as their text)."""
    back = {"italic": "i", "x-mirrored": "m", "x-mirrored-italic": "mi", "x-archaic": "a", "x-upside-down": "u"}
    out = [el.text or ""]
    for child in el:
        tag = child.tag.split("}")[-1]
        ct = child.get("ctype", "")
        if tag == "x" and ct == "x-exponent":
            out.append(chr(EXPONENT))
        elif tag == "x" and ct.startswith("x-pua-"):
            out.append(chr(int(ct[6:], 16)))
        elif tag in ("g", "pc") and ct in back:
            out.append(face_text("".join(child.itertext()), back[ct]))
        else:
            out.append("".join(child.itertext()))
        out.append(child.tail or "")
    return "".join(out)


def write_file(path, data):
    _tool("build_layer").write_whole(path, data)


# ---- import ----------------------------------------------------------------------------------------------------------------------------
def read_csv(path):
    """[(where, id or None, source or None, text, status or None, note or None)]."""
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))
    if not rows:
        return []
    head = [h.strip().lower() for h in rows[0]]
    col = lambda name: head.index(name) if name in head else None
    ci, ct, cs, cn = col("id"), col("text"), col("status"), col("note")
    if ct is None:
        raise SystemExit(f"{path}: no column named text")
    srcs = [k for k, h in enumerate(head) if h in ("ja", "en", "source")]
    out = []
    for n, r in enumerate(rows[1:], 2):
        cell = lambda k: r[k] if k is not None and k < len(r) else ""
        idv = cell(ci).strip()
        out.append((f"row {n}", int(idv) if idv.isdigit() else None, cell(srcs[0]) if srcs else None, cell(ct),
                    cell(cs).strip() or None, cell(cn) if cn is not None else None))
    return out


def po_unquote(chunks):
    s = "".join(chunks)
    return re.sub(r'\\(.)', lambda m: {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\"}.get(m.group(1), m.group(1)), s)


def read_po(path):
    with open(path, encoding="utf-8") as f:
        lines = f.read().split("\n")
    entries, cur, key = [], None, None

    def flush():
        if cur and (cur.get("msgid") or cur.get("msgctxt")):
            entries.append(cur)
    for n, line in enumerate(lines + [""], 1):
        line = line.rstrip("\r")
        if not line.strip():
            flush()
            cur, key = None, None
            continue
        if cur is None:
            cur = {"line": n, "comments": [], "flags": [], "extracted": []}
        if line.startswith("#,"):
            cur["flags"] += [x.strip() for x in line[2:].split(",")]
        elif line.startswith("#."):
            cur["extracted"].append(line[2:].strip())
        elif line.startswith("#~") or line.startswith("#|") or line.startswith("#:"):
            continue
        elif line.startswith("#"):
            cur["comments"].append(line[1:].strip())
        else:
            m = re.match(r'(msgctxt|msgid|msgstr)\s+(".*")\s*$', line)
            if m:
                key = m.group(1)
                cur[key] = [m.group(2)[1:-1]]
            elif line.startswith('"') and key:
                cur[key].append(line.strip()[1:-1])
    out = []
    for e in entries:
        if not e.get("msgid") or e["msgid"] == [""] and not e.get("msgctxt"):
            continue   # (the header)
        ctx = po_unquote(e.get("msgctxt", []))
        m = re.search(r"#(\d+)$", ctx)
        st = None
        if "fuzzy" in e["flags"]:
            st = "draft"
        else:
            said = next((x.split(":", 1)[1].strip() for x in e["extracted"] if x.startswith("status:")), None)
            st = said if said in ("reviewed", "final") else "reviewed"
        out.append((f"entry at line {e['line']}", int(m.group(1)) if m else None, po_unquote(e["msgid"]), po_unquote(e.get("msgstr", [])), st,
                    "\n".join(e["comments"]) if e["comments"] else None))
    return out


def read_xliff(path):
    tree = ET.parse(path)
    out = []
    state = {"new": None, "needs-translation": None, "needs-adaptation": "draft", "needs-l10n": "draft", "needs-review-translation": "draft",
             "needs-review-adaptation": "draft", "needs-review-l10n": "draft", "translated": "reviewed", "signed-off": "reviewed", "final": "final",
             "initial": "draft", "reviewed": "reviewed"}
    for u in tree.iter():
        tag = u.tag.split("}")[-1]
        if tag not in ("trans-unit", "unit"):
            continue
        uid = u.get("id", "")
        m = re.search(r"(\d+)$", uid)
        seg = next((c for c in u if c.tag.split("}")[-1] == "segment"), u)   # (2.0: the text is in a segment)
        src = next((c for c in seg if c.tag.split("}")[-1] == "source"), None)
        tgt = next((c for c in seg if c.tag.split("}")[-1] == "target"), None)
        notes = [c for c in u.iter() if c.tag.split("}")[-1] == "note" and c.get("from", c.get("category", "")) in ("translator", "")]
        st = state.get((tgt.get("state") if tgt is not None else None) or seg.get("state") or "", "draft")
        out.append((f"unit {uid}", int(m.group(1)) if m else None, get_runs(src) if src is not None else None,
                    get_runs(tgt) if tgt is not None else "", st, "\n".join(n.text or "" for n in notes) if notes else None))
    return out


def same_japanese(said, port):
    """A deepLuna block's copy of the Japanese against the port's line, whitespace, the engine's own marks and ruby readings aside (on
    HanabiWorks' copy of deepLuna's export, every one of 43,960 blocks agrees with the port's line at the number its comment names)."""
    bare = lambda s: re.sub(r"[\s-]", "", re.sub(r"<([^|<>]*)\|[^<>]*>", r"\1", s or ""))
    return bare(said) == bare(port)


def read_deepluna(path, game, db=None, revision=None):
    """A deepLuna project folder (its lines laid out by build_pt.py's rules, row breaks and all), or readable-format files. A block goes on
    the line its first row names, "-- Page P, Offset N." (deepLuna writes it in every block, an [sha:H] one too), when the Japanese in its
    comment is that line's; an [offset:N] on N; an [sha:H] with no such row on the lines with that hash in the project's database (--db), but
    not where a block names the line itself. A line two blocks name with other texts takes the first. Returns (items, notes, breaks, not placed)."""
    bp = _tool("build_pt")
    if os.path.isdir(path) and os.path.isfile(os.path.join(path, "deepluna_db.json")) and os.path.isdir(os.path.join(path, "scripts", "TL")):
        _, english, scenes, files, tl, out, notes = bp.read_project(game.root, path, revision, None if game.root else game.read)
        laid = [("project", o, None, out[o], None, None) for o in sorted(tl) if 0 <= o < len(out)]
        return laid, notes, "deepluna", []
    paths = [path] if os.path.isfile(path) else sorted(os.path.join(d, f) for d, _, fs in os.walk(path) for f in fs if f.endswith(".txt"))
    by_hash, scenes = {}, None
    if db:
        _, d, english, scenes, jp = bp.load(game.root, os.path.dirname(os.path.abspath(db)), None if game.root else game.read)
        for v in scenes.values():
            for c in v:
                by_hash.setdefault(c["jp_hash"], []).append(c["offset"])
    ja = game.text("ja")
    blocks, notes, unplaced, unchecked = [], [], [], 0
    for p in paths:
        for kind, key, text, said, japanese in bp.readable_entries(p):
            if not text:
                continue
            where = f"{os.path.basename(p)} [{kind}:{key}]"
            if kind == "offset" or said is not None:
                ids, by_line = [int(key) if kind == "offset" else said], True
                if japanese is not None and ja is None:
                    unchecked += 1
                elif japanese is not None and ids[0] < len(ja) and not same_japanese(japanese, ja[ids[0]]):
                    unplaced.append((where, f"line {ids[0]}'s Japanese is not the one in its comment (a file numbered otherwise?)"))
                    continue
            else:
                ids, by_line = [o for o in by_hash.get(key, []) if o in game.order], False
                if not ids:
                    unplaced.append((where, "no line number in it (deepLuna begins a block with \"-- Page P, Offset N.\"), and "
                                     + ("no line the scripts show has its hash in deepluna_db.json" if db else
                                        "no deepluna_db.json to look its hash up in (exchange.py --db)")))
                    continue
            try:
                coded = bp.apply_codes(text.replace("\n", ""), pua=True)
            except bp.LineError as e:
                unplaced.append((where, str(e)))
                continue
            blocks.append((not by_line, where, ids, coded, text.replace("\n", "")))
    if unchecked:
        notes.append(f"{unchecked} blocks' line numbers were not checked against the Japanese in their comments: the game here has no Japanese text")
    out, written, taken = [], {}, {}
    for by_hash_only, where, ids, coded, raw in sorted(blocks, key=lambda b: b[0]):   # (the blocks that name their line first)
        for i in ids:
            if i in taken:
                if not by_hash_only and taken[i][1] != coded:
                    unplaced.append((where, f"line {i} is in {taken[i][0]} too, with another text: that one is taken"))
                continue
            taken[i] = (where, coded)
            written[i] = raw
            out.append((where, i, None, coded, None, None))
    if scenes is None:
        return out, notes, "none", unplaced
    # with the project's database, the rows laid out as deepLuna lays them (build_pt.py lay_out): its 55-cell breaks, glued lines on one row
    laid = {}
    for scene, cmds in scenes.items():
        if any(c["offset"] in written for c in cmds):
            try:
                bp.lay_out(scene, cmds, written, jp, lambda o: english[o], laid, pua=True)
            except bp.LineError as e:
                notes.append(f"{scene}: {e}")
    for cmds in scenes.values():
        for c in cmds:
            o = c["offset"]
            if c.get("is_choice") and o in laid and english[o].startswith(" ") and not laid[o].startswith(" "):
                laid[o] = " " + laid[o]
    return [(w, i, None, laid.get(i, t), st, n) for w, i, _, t, st, n in out], notes, "deepluna", unplaced


def mrg_lines(data):
    """script_text.mrg (the game's dialogue: an mrgd00 archive of offset tables and texts, a pair a language): the first language's lines."""
    if data[:6] != b"mrgd00":
        raise ValueError("not an mrgd00 archive (script_text.mrg)")
    n = struct.unpack_from("<H", data, 6)[0]
    head = 8 + 8 * n
    starts = []
    for k in range(n):
        so, bo = struct.unpack_from("<HH", data, 8 + 8 * k)
        starts.append(head + so * 0x800 + bo)
    end = starts[2] if n > 2 else len(data)
    return data[starts[1]:end].decode("utf-8", "replace").split("\r\n")


CJK_WORDS = re.compile(r"[\u3040-\u30ff\u4e00-\u9fff]")


def read_whole(path, fmt, game):
    """A whole built text, a line a number: its lines that are the translation's. A line that is the English is left (the port shows the
    English there anyway), and so is a line in Japanese where the English has none: deepLuna leaves a line not translated yet in Japanese."""
    if fmt == "mrg":
        with open(path, "rb") as f:
            lines = mrg_lines(f.read())
    else:
        with open(path, encoding="utf-8") as f:
            lines = json.load(f)
        if not isinstance(lines, list) or not all(isinstance(x, str) for x in lines):
            raise ValueError("not a list of lines (a text.json)")
    notes = []
    if len(lines) != len(game.english):
        notes.append(f"{len(lines)} lines where the port's text has {len(game.english)}: laid on the same numbers as far as they go")
    pages = {}
    for ln in game.map["lines"]:
        pages[ln["id"]] = {a["page"] for a in ln["at"] if a.get("page") is not None}
    mine, same, ja = {}, [], 0
    for i, t in enumerate(lines[:len(game.english)]):
        if i not in game.order or not t:
            continue
        if t == game.english[i]:
            same.append(i)
        elif CJK_WORDS.search(t) and not CJK_WORDS.search(game.english[i]):
            ja += 1
        else:
            mine[i] = t
    # a line the same in both ("……", a name) on a page that is translated is the translation's too: else the page reads as half done
    done_pages = {p for i in mine for p in pages.get(i, ())}
    kept = [i for i in same if pages.get(i, set()) & done_pages]
    for i in kept:
        mine[i] = lines[i]
    out = [(f"line {i}", i, None, t, None, None) for i, t in sorted(mine.items())]
    notes.append(f"left out: {len(same) - len(kept)} lines that are the English's (on pages not translated), {ja} lines still in Japanese "
                 f"(not translated yet); taken: {len(kept)} lines the same as the English on translated pages")
    return out, notes


def normalize(s):
    return re.sub(r"\s+", " ", (s or "").replace("\u3000", " ")).strip()


def import_(fmt, src, folder, game, status="draft", overwrite=False, dry=False, db=None, revision=None, say=print):
    """Lay a file's lines into the translations folder. Returns the report: {placed, same, kept, unplaced: [(where, why)], notes}."""
    meta = language(folder)
    notes, unplaced = [], []
    breaks = None
    if fmt == "csv":
        items = read_csv(src)
    elif fmt == "po":
        items = read_po(src)
    elif fmt == "xliff":
        items = read_xliff(src)
    elif fmt == "deepluna":
        items, notes, breaks, unplaced = read_deepluna(src, game, db, revision)
    elif fmt in WHOLE:
        items, notes = read_whole(src, fmt, game)
    else:
        raise SystemExit(f"{fmt}: not a format ({', '.join(FORMATS + WHOLE)})")
    lang = meta.get("from") or ("ja" if game.text("ja") else "en")
    by_source = {}
    for l in dict.fromkeys([lang, "en", "ja"]):
        t = game.text(l)
        if t:
            for i in game.order:
                by_source.setdefault(normalize(t[i]), set()).add(i)
    have = rows_of(folder)
    report = {"placed": 0, "same": 0, "kept": [], "unplaced": list(unplaced), "notes": notes, "files": set()}
    changes = {}
    for where, i, source, text, st, note in items:
        if fmt in ("csv", "po"):
            try:
                text = from_tags(text)
                source = from_tags(source) if source else source
            except ValueError as e:
                report["unplaced"].append((where, f"its tags: {e}"))
                continue
        if not text:
            report["unplaced"].append((where, "no translation in it"))
            continue
        if i is None:
            ids = sorted(by_source.get(normalize(source), ())) if source else []
            if not ids:
                report["unplaced"].append((where, "no line number, and its source is no line of the game"))
                continue
        else:
            if i not in game.order:
                report["unplaced"].append((where, f"line {i}: the scripts show no such line" if 0 <= i < len(game.english) else f"line {i}: no such line"))
                continue
            ids = [i]
        for i in ids:
            old, scene = have.get(i, (None, None))
            st_i = st if st in STATUSES and st != "empty" else status
            if old and old.get("text") and old.get("status", "draft") != "empty":
                if old.get("text") == text:
                    report["same"] += 1
                    continue
                if not overwrite:
                    report["kept"].append((where, f"line {i} has another translation already (--overwrite to take this one)"))
                    continue
            new = dict(old) if old else {"id": i}
            new.update({"text": text, "status": st_i})
            if note:
                new["note"] = note
            src_text = game.text(lang)
            if src_text and i < len(src_text):
                new["from"] = {"lang": lang, "hash": hashlib.sha1(src_text[i].encode("utf-8")).hexdigest()[:12]}
            scene = scene or game.first_scene[i]
            changes.setdefault(scene, {})[i] = {"id": i, "before": old, "after": new}
            report["placed"] += 1
            report["files"].add(scene)
    if breaks == "deepluna" and meta.get("breaks", "none") != "deepluna":
        report["notes"].append("these lines carry deepLuna's 55-cell row breaks: set language.json \"breaks\" to \"deepluna\" (the Language button)")
    if not dry and changes:
        Folder = _tool("translations").Folder
        Folder(folder, game.map).save({"files": [{"scene": sc, "changes": list(ch.values())} for sc, ch in sorted(changes.items())]})
    return report


def say_report(r, dry, say=print):
    say(f"{'would place' if dry else 'placed'} {r['placed']} lines in {len(r['files'])} scene files; {r['same']} were so already; "
        f"{len(r['kept'])} kept as they were; {len(r['unplaced'])} not placed")
    for kind in ("kept", "unplaced"):
        for where, why in r[kind][:20]:
            say(f"  {kind}: {where}: {why}")
        if len(r[kind]) > 20:
            say(f"  ... {len(r[kind]) - 20} more {kind}")
    for n in r["notes"][:20]:
        say(f"  note: {n}")


def main(argv):
    opts, args = {"app": [], "status": "draft"}, []
    it = iter(argv[1:])
    for a in it:
        if a == "--app":
            opts["app"].append(next(it, None))
        elif a in ("--root", "--scenes", "--source", "--status", "--db", "--revision"):
            opts[a[2:]] = next(it, None)
        elif a in ("--all", "--overwrite", "--dry-run"):
            opts[a[2:]] = True
        else:
            args.append(a)
    if len(args) != 4 or args[0] not in ("export", "import") or args[1] not in FORMATS + (WHOLE if args[0] == "import" else ()):
        raise SystemExit(__doc__)
    if opts["status"] not in STATUSES[1:]:
        raise SystemExit(f"--status: one of {', '.join(STATUSES[1:])}")
    root = None if opts["app"] else os.path.abspath(opts.get("root") or os.path.join(HERE, "..", ".."))
    try:
        game = Game(root, opts["app"])
    except ValueError as e:
        raise SystemExit(str(e))
    what, fmt, a, b = args
    if what == "export":
        if not os.path.isdir(a):
            raise SystemExit(f"{a}: no such translations folder")
        n = export(fmt, game, a, b, opts.get("scenes"), opts.get("all", False), opts.get("source"))
        print(f"{b}: {n} lines")
    else:
        if not os.path.isdir(b):
            raise SystemExit(f"{b}: no such translations folder (make it first)")
        r = import_(fmt, a, b, game, opts["status"], opts.get("overwrite", False), opts.get("dry-run", False), opts.get("db"), opts.get("revision"))
        say_report(r, opts.get("dry-run", False))


if __name__ == "__main__":
    main(sys.argv)
