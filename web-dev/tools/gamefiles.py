#!/usr/bin/env python3
"""gamefiles.py: the game's files as a copy of the port has them, for the translator tool (web-dev/TRANSLATOR-TOOL-PLAN.md, decision 1).

A translator works over the app they downloaded, not over this checkout. The tool reads the page's files and the game's files from one or more
folders, the first that has a file giving it:

  - a `web/` folder: `app/` (the page) and `assets/` (the game's files), as this checkout has it once web-dev/tools/fetch_assets.py has run;
  - the desktop app's `www` (the page, with `assets/` inside it): `Tsukihime.app/Contents/Resources/www` on a Mac, `resources/www` beside
    `Tsukihime.exe` on Windows and Linux; a Mac `.app` may be named itself;
  - the desktop app's data folder (`~/Library/Application Support/Tsukihime`, `%APPDATA%\\Tsukihime`, `~/.config/Tsukihime`): the update it plays
    (`update/state.json` names it; `update/<id>/files` holds what it changed, and the languages downloaded since, laid out as `www` is). Name it
    before the app's `www`, as the app reads it first (web-dev/desktop/updater.js).

The apps keep a downloaded language's small files in packs (`<lang>/pack/index.json` and `<lang>-<hash>.pack`, web-dev/tools/build_langpacks.py): a
file that is not there by itself is read out of its pack, so `ja/text.json` is found in an app that has Japanese.
Standard library only.
"""
import json
import os

PACK_FOLDER = "pack"


def _isfile(p):
    return os.path.isfile(p)


def resolve(folder):
    """(the page's folder, the game's files' folder, what it is) for one folder given, or raise ValueError saying what is wanted."""
    folder = os.path.abspath(os.path.expanduser(folder))
    if not os.path.isdir(folder):
        raise ValueError(f"{folder}: no such folder")
    www = os.path.join(folder, "Contents", "Resources", "www")
    if folder.endswith(".app") and os.path.isdir(www):
        folder = www
    state = os.path.join(folder, "update", "state.json")
    if _isfile(state):
        with open(state, encoding="utf-8") as f:
            st = json.load(f)
        cur = st.get("current") if isinstance(st, dict) else None
        files = os.path.join(folder, "update", str(cur), "files") if cur else None
        if not files or not os.path.isdir(files):
            # an app that never took an update (or gave one up) plays its own files: nothing here to read, and that is no error
            return None, None, f"data folder {folder}: no update in use (skipped)"
        return files, os.path.join(files, "assets"), f"update {cur} of {folder}"
    if _isfile(os.path.join(folder, "app", "index.html")) and os.path.isdir(os.path.join(folder, "assets")):
        return os.path.join(folder, "app"), os.path.join(folder, "assets"), f"web folder {folder}"
    if _isfile(os.path.join(folder, "index.html")) and os.path.isdir(os.path.join(folder, "assets")):
        return folder, os.path.join(folder, "assets"), f"app files {folder}"
    raise ValueError(f"{folder}: neither a web/ folder (app/ and assets/), an app's www (index.html and assets/), a Mac .app nor the desktop "
                     f"app's data folder (update/state.json)")


class GameFiles:
    """The page's and the game's files from the folders given, the first that has a file giving it."""

    def __init__(self, folders):
        found = [resolve(f) for f in folders]
        self.skipped = [what for app, _, what in found if app is None]
        self.layers = [x for x in found if x[0] is not None]
        if not self.layers:
            raise ValueError("no folder of the game's files given" + (f" ({'; '.join(self.skipped)})" if self.skipped else ""))
        self._packs = {}

    def describe(self):
        return [what for _, _, what in self.layers] + self.skipped

    @staticmethod
    def _inside(base, rel):
        full = os.path.normpath(os.path.join(base, *[p for p in rel.split("/") if p]))
        return full if full.startswith(os.path.join(os.path.normpath(base), "")) else None

    def page_file(self, rel):
        """The page's file at `rel` ("index.html", "js/main.js"), or None. (The game's files are under assets/: asset.)"""
        for app, _, _ in self.layers:
            full = self._inside(app, rel)
            if full and _isfile(full):
                return full
        return None

    def asset_path(self, rel):
        """A game file by itself on disk ("text.json", "ja/text.json"), or None."""
        for _, assets, _ in self.layers:
            full = self._inside(assets, rel)
            if full and _isfile(full):
                return full
        return None

    def _pack_index(self, assets, lang):
        key = (assets, lang)
        if key not in self._packs:
            where = None
            ix_path = self._inside(assets, f"{lang}/{PACK_FOLDER}/index.json")
            if ix_path and _isfile(ix_path):
                try:
                    with open(ix_path, encoding="utf-8") as f:
                        ix = json.load(f)
                    if ix.get("version") == 1:
                        where = {}
                        for name, files in ix["packs"]:
                            at = 0
                            for k in range(0, len(files), 2):
                                where[files[k]] = (name, at, files[k + 1])
                                at += files[k + 1]
                except (OSError, ValueError, KeyError, TypeError):
                    where = None
            self._packs[key] = where
        return self._packs[key]

    def packed(self, rel):
        """(pack path, offset, size) of a language's file that is only in a pack, or None."""
        lang, _, rest = rel.partition("/")
        if not rest or not lang.isalpha():
            return None
        for _, assets, _ in self.layers:
            where = self._pack_index(assets, lang)
            if where and rest in where:
                name, at, size = where[rest]
                path = self._inside(assets, f"{lang}/{PACK_FOLDER}/{name}")
                if path and _isfile(path):
                    return path, at, size
        return None

    def read(self, rel):
        """A game file's bytes ("scripts/0.json", "ja/text.json"), by itself or out of its pack, or None where no folder has it."""
        path = self.asset_path(rel)
        if path:
            with open(path, "rb") as f:
                return f.read()
        p = self.packed(rel)
        if p:
            with open(p[0], "rb") as f:
                f.seek(p[1])
                return f.read(p[2])
        return None

    def has(self, rel):
        return self.asset_path(rel) is not None or self.packed(rel) is not None

    def languages(self):
        """The folders of lines there are: "en" (text.json itself) and every folder with a text.json of its own, by itself or in a pack."""
        found = ["en"] if self.has("text.json") else []
        names = set()
        for _, assets, _ in self.layers:
            if os.path.isdir(assets):
                names.update(d for d in os.listdir(assets) if d.isalpha() and d.islower() and os.path.isdir(os.path.join(assets, d)))
        found += sorted(d for d in names if self.has(f"{d}/text.json"))
        return found
