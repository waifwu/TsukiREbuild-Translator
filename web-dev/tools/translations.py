#!/usr/bin/env python3
"""translations.py: a translations folder as the translator tool's editor reads and writes it (web-dev/TRANSLATOR-TOOL-PLAN.md, Stage 2).

The folder is build_layer.py's form, kept in the translators' own repository: <scene>.json a scene, {"scene", "lines": [{id, text, status, note,
from}]}, one line a row (build_layer.scene_text), and an optional language.json. web-dev/tools/dev_server.py serves the editor and calls this to
load the folder and to save what was changed. Only that folder is written, only files named after a scene of the game (or language.json), and a
file is written whole (beside its place, then renamed over it).

A save names, for every line it changes, the line as the editor last had it from the folder ("before") and the line as it is to be ("after"). A
line that is not as "before" on disk any more (another editor, a teammate's lines pulled with git) is a conflict: nothing is written and the line
as it now is goes back, so the translator chooses. Lines nobody changed are written back as they were, their keys in their order, and keys the
tool does not know are kept.
Standard library only.
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
STATUSES = ("empty", "draft", "reviewed", "final")
SCENE = re.compile(r"[A-Za-z0-9_]{1,64}")
LANG = re.compile(r"[a-z]{2,12}")
HASH = re.compile(r"[0-9a-f]{12}")
ORDER = ("id", "text", "status", "note", "from")
MOST_TEXT = 20000


def _layer():
    import importlib.util
    spec = importlib.util.spec_from_file_location("build_layer", os.path.join(HERE, "build_layer.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Refused(Exception):
    """A request the folder does not take: (HTTP status, what to say)."""

    def __init__(self, status, body):
        super().__init__(body.get("error") if isinstance(body, dict) else str(body))
        self.status = status
        self.body = body if isinstance(body, dict) else {"error": str(body)}


def ordered(old, new):
    """`new` with the keys `old` had in their order first, then its own in the usual order (id, text, status, note, from, others)."""
    out = {k: new[k] for k in (old or {}) if k in new}
    for k in ORDER:
        if k in new and k not in out:
            out[k] = new[k]
    for k in new:
        if k not in out:
            out[k] = new[k]
    return out


class Folder:
    def __init__(self, path, line_map=None, lines=None):
        self.path = os.path.abspath(path)
        self.bl = _layer()
        self.lines = lines                      # how many lines the text has (or None)
        self.scene_names = None
        self.scenes_of = {}                     # line -> the scenes that show it
        self.position = {}                      # (scene, line) -> where the scene shows it first, for placing a new row
        self._cache = {}                        # file -> (mtime, size, rows or error)
        if line_map:
            names = [s["name"] for s in line_map["scenes"]]
            self.scene_names = set(names)
            self.lines = line_map["source"]["lines"]
            for ln in line_map["lines"]:
                shown = self.scenes_of.setdefault(ln["id"], set())
                for a in ln["at"]:
                    shown.add(names[a["s"]])
                    key = (names[a["s"]], ln["id"])
                    pos = (0 if not a.get("dead") else 1, a["pc"], a["nth"])
                    if key not in self.position or pos < self.position[key]:
                        self.position[key] = pos

    # ---- reading ------------------------------------------------------------------------------------------------------------------------
    def _file(self, scene):
        return os.path.join(self.path, f"{scene}.json")

    def _read(self, name):
        """A scene file's rows (cached while it is unchanged on disk), or an error string."""
        full = os.path.join(self.path, name)
        try:
            st = os.stat(full)
        except FileNotFoundError:
            self._cache.pop(name, None)
            return None
        hit = self._cache.get(name)
        if hit and hit[0] == st.st_mtime_ns and hit[1] == st.st_size:
            return hit[2]
        try:
            with open(full, encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict) or not isinstance(data.get("lines"), list) or not isinstance(data.get("scene"), str):
                got = 'not {"scene": ..., "lines": [...]}'
            elif data["scene"] != name[:-5]:
                got = f"its scene is {data['scene']}, not {name[:-5]}"
            elif not all(isinstance(r, dict) and isinstance(r.get("id"), int) for r in data["lines"]):
                got = 'a line that is not {"id": <number>, ...}'
            else:
                got = data["lines"]
        except (OSError, ValueError) as e:
            got = f"not JSON: {e}"
        self._cache[name] = (st.st_mtime_ns, st.st_size, got)
        return got

    def scene_files(self):
        return sorted(n for n in os.listdir(self.path) if n.endswith(".json") and n not in self.bl.RESERVED and SCENE.fullmatch(n[:-5]))

    def language(self):
        p = os.path.join(self.path, "language.json")
        if not os.path.isfile(p):
            return None
        with open(p, encoding="utf-8") as f:
            return json.load(f)

    def glossary(self):
        p = os.path.join(self.path, "glossary.json")
        if not os.path.isfile(p):
            return None
        with open(p, encoding="utf-8") as f:
            return json.load(f)

    def load(self):
        """{"path", "language", "files": {scene: rows}, "problems": [...]}: everything the editor shows."""
        files, problems = {}, []
        for name in self.scene_files():
            got = self._read(name)
            if isinstance(got, str):
                problems.append({"file": name, "error": got})
            elif got is not None:
                files[name[:-5]] = got
        try:
            lang = self.language()
        except (OSError, ValueError) as e:
            lang = None
            problems.append({"file": "language.json", "error": f"not JSON: {e}"})
        try:
            glossary = self.glossary()
        except (OSError, ValueError) as e:
            glossary = None
            problems.append({"file": "glossary.json", "error": f"not JSON: {e}"})
        return {"path": self.path, "language": lang, "glossary": glossary, "files": files, "problems": problems}

    def translated(self):
        """line -> its text, for every line the folder has translated (a status other than empty, and text): the draft the game plays."""
        out = {}
        for name in self.scene_files():
            got = self._read(name)
            if isinstance(got, list):
                for r in got:
                    t = r.get("text")
                    if isinstance(t, str) and t and r.get("status", "draft") != "empty" and r["id"] not in out:
                        out[r["id"]] = t
        return out

    def owners(self):
        """line -> the scene file that has it."""
        own = {}
        for name in self.scene_files():
            got = self._read(name)
            if isinstance(got, list):
                for r in got:
                    own.setdefault(r["id"], name[:-5])
        return own

    # ---- writing ------------------------------------------------------------------------------------------------------------------------
    def _check_row(self, i, row):
        if not isinstance(row, dict) or row.get("id") != i:
            return "not a line with that id"
        if not isinstance(row.get("text", ""), str) or len(row.get("text", "")) > MOST_TEXT:
            return "its text is not a string (or far too long)"
        if row.get("status", "empty") not in STATUSES:
            return f"status {row.get('status')!r} is none of {', '.join(STATUSES)}"
        if "note" in row and (not isinstance(row["note"], str) or len(row["note"]) > MOST_TEXT):
            return "its note is not a string"
        src = row.get("from")
        if src is not None and not (isinstance(src, dict) and LANG.fullmatch(str(src.get("lang", "")))
                                    and (src.get("hash") is None or HASH.fullmatch(str(src["hash"])))):
            return 'from is not {"lang": <code>, "hash": <12 hex>}'
        return None

    def save(self, req):
        """Apply {"files": [{"scene", "changes": [{"id", "before", "after"}]}]}: all or nothing. Returns what is on disk now for those lines."""
        if not isinstance(req, dict) or not isinstance(req.get("files"), list) or not req["files"]:
            raise Refused(400, {"error": 'not {"files": [{"scene": ..., "changes": [...]}]}'})
        own = self.owners()
        plans, conflicts, errors, seen = [], [], [], set()
        for f in req["files"]:
            scene = f.get("scene") if isinstance(f, dict) else None
            changes = f.get("changes") if isinstance(f, dict) else None
            if not isinstance(scene, str) or not SCENE.fullmatch(scene) or not isinstance(changes, list):
                raise Refused(400, {"error": "a file that is not {scene, changes}"})
            if self.scene_names is not None and scene not in self.scene_names:
                raise Refused(400, {"error": f"{scene}: no scene of the game is called that"})
            rows = self._read(f"{scene}.json")
            if isinstance(rows, str):
                raise Refused(409, {"error": f"{scene}.json: {rows}: put it right first (nothing was written)"})
            rows = [dict(r) for r in (rows or [])]
            at = {r["id"]: k for k, r in enumerate(rows)}
            for c in changes:
                i = c.get("id") if isinstance(c, dict) else None
                if not isinstance(i, int) or isinstance(i, bool):
                    raise Refused(400, {"error": "a change with no line id"})
                where = f"{scene} line {i}"
                if i in seen:
                    raise Refused(400, {"error": f"{where}: changed twice in one save"})
                seen.add(i)
                if self.lines is not None and not 0 <= i < self.lines:
                    errors.append(f"{where}: no such line (the text has {self.lines})")
                    continue
                shown = self.scenes_of.get(i)
                if shown and scene not in shown:
                    errors.append(f"{where}: this scene does not show it ({', '.join(sorted(shown))} does)")
                    continue
                if own.get(i, scene) != scene:
                    conflicts.append({"scene": scene, "id": i, "owner": own[i], "current": None,
                                      "why": f"the line is kept in {own[i]}.json"})
                    continue
                after = c.get("after")
                if after is not None:
                    bad = self._check_row(i, after)
                    if bad:
                        errors.append(f"{where}: {bad}")
                        continue
                current = rows[at[i]] if i in at else None
                if current != c.get("before"):
                    conflicts.append({"scene": scene, "id": i, "current": current, "why": "changed on disk since it was loaded"})
                    continue
            plans.append((scene, rows, at, changes))
        if errors:
            raise Refused(400, {"error": f"{len(errors)} lines not taken: nothing was written", "errors": errors})
        if conflicts:
            raise Refused(409, {"error": f"{len(conflicts)} lines changed on disk: nothing was written", "conflicts": conflicts})
        written = {}
        for scene, rows, at, changes in plans:
            for c in changes:
                i, after = c["id"], c.get("after")
                if i in at:
                    k = at[i]
                    rows[k] = None if after is None else ordered(rows[k], after)
                elif after is not None:
                    rows.append(ordered(None, after))
            rows = [r for r in rows if r is not None]
            pos = lambda r: self.position.get((scene, r["id"]))
            if all(pos(r) is not None for r in rows):
                # rows stay in the order the file had them: a new row goes in where the scene shows it
                new_ids = {c["id"] for c in changes if c["id"] not in at}
                kept = [r for r in rows if r["id"] not in new_ids]
                for r in sorted((r for r in rows if r["id"] in new_ids), key=pos):
                    k = next((n for n, o in enumerate(kept) if pos(o) > pos(r)), len(kept))
                    kept.insert(k, r)
                rows = kept
            self.bl.write_whole(self._file(scene), self.bl.scene_text(scene, rows))
            self._cache.pop(f"{scene}.json", None)
            got = {r["id"]: r for r in rows}
            written[scene] = [got.get(c["id"]) for c in changes]
        return {"ok": True, "written": written}

    def set_glossary(self, req):
        """{"before": glossary.json as loaded (or null), "after": {"terms": [...]}}: glossary.json written whole, one term a row (Stage 5)."""
        if not isinstance(req, dict) or not isinstance(req.get("after"), dict) or not isinstance(req["after"].get("terms"), list):
            raise Refused(400, {"error": 'not {"before": ..., "after": {"terms": [...]}}'})
        terms = req["after"]["terms"]
        for k, t in enumerate(terms):
            if not isinstance(t, dict) or not isinstance(t.get("target", ""), str) or len(json.dumps(t)) > 4000 \
                    or any(not (key in ("target", "note") and isinstance(v, str) or key == "also" and isinstance(v, list) and all(isinstance(x, str) for x in v)
                                or LANG.fullmatch(key) and isinstance(v, str)) for key, v in t.items()):
                raise Refused(400, {"error": f"glossary term {k}: not {{<language code>: <form>, ..., \"target\", \"also\": [...], \"note\"}}"})
        try:
            current = self.glossary()
        except (OSError, ValueError) as e:
            raise Refused(409, {"error": f"glossary.json: not JSON: {e}: put it right first"})
        if current != req.get("before"):
            raise Refused(409, {"error": "glossary.json changed on disk since it was loaded", "current": current})
        out = {**(current or {}), "terms": terms}
        body = ",\n".join(json.dumps(t, ensure_ascii=False, separators=(", ", ": ")) for t in terms)
        head = {k: v for k, v in out.items() if k != "terms"}
        text = "{" + "".join(f"{json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}, " for k, v in head.items()) + f'"terms": [\n{body}\n]}}\n'
        self.bl.write_whole(os.path.join(self.path, "glossary.json"), text)
        return {"ok": True, "glossary": out}

    def set_language(self, req):
        """{"before": language.json as loaded (or null), "after": {...}}: language.json written whole, its keys kept in their order."""
        if not isinstance(req, dict) or not isinstance(req.get("after"), dict):
            raise Refused(400, {"error": 'not {"before": ..., "after": {...}}'})
        after = req["after"]
        for key, ok in (("code", lambda v: re.fullmatch(r"[a-z]{2,3}", v or "")), ("name", lambda v: isinstance(v, str) and len(v) < 200),
                        ("breaks", lambda v: v in ("none", "deepluna")), ("from", lambda v: isinstance(v, str) and LANG.fullmatch(v))):
            if key in after and not ok(after[key]):
                raise Refused(400, {"error": f"language.json: {key} {after[key]!r} is not taken"})
        try:
            current = self.language()
        except (OSError, ValueError) as e:
            raise Refused(409, {"error": f"language.json: not JSON: {e}: put it right first"})
        if current != req.get("before"):
            raise Refused(409, {"error": "language.json changed on disk since it was loaded", "current": current})
        out = ordered(current, after) if current else dict(after)
        self.bl.write_whole(os.path.join(self.path, "language.json"), json.dumps(out, ensure_ascii=False, indent=1) + "\n")
        return {"ok": True, "language": out}
