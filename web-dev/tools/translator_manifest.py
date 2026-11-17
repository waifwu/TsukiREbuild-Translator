"""translator_manifest.py - the translator app's own files as its updates describe them (web-dev/translator-app/updater.js).

The files are the ones web-dev/translator-app/tool-files.json lists (the tool's server, editor and fit page: the app packs exactly those). A
description names each with its size and SHA-256, a version made from all of them, a time and the app ("shell") they need:

    {"version": "<12 hex>", "time": <seconds>, "shell": 1, "tag": "v2026.11.18",
     "files": {"web-dev/translator/editor.js": [size, "<sha256>"], ...}}

- The app's build (build.sh) writes one for the files it packs, bundled.json beside them: what the app was made with.
- A release of the app's repository (its workflow, .github/workflows/release.yml) carries update.json and each file as an asset named by its
  SHA-256 (--release). An app whose tool is older (another version, an earlier time) brings itself up to date from the latest release.
  A folder written by --release and served on this computer is the same, for trying an update (main.js --update-origin).

    translator_manifest.py --bundle OUT.json [--time SECONDS]
    translator_manifest.py --release DIR --tag TAG [--time SECONDS]
"""
import hashlib
import json
import os
import re
import sys
import time as clock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
LIST = "web-dev/translator-app/tool-files.json"
TAG = re.compile(r"^[A-Za-z0-9._-]{1,64}$")   # (updater.js TAG)


def read_list(root=ROOT):
    with open(os.path.join(root, LIST), encoding="utf-8") as f:
        spec = json.load(f)
    files = spec["files"]
    if not isinstance(spec.get("shell"), int) or not files or len(set(files)) != len(files):
        raise RuntimeError(f"{LIST}: no shell number, no files, or a file twice")
    return spec


def entry(path):
    with open(path, "rb") as f:
        data = f.read()
    return [len(data), hashlib.sha256(data).hexdigest()]


def version_of(files):
    """The version: the first 12 hex of the SHA-256 of every file's path, size and hash, in path order (updater.js versionOf: the same)."""
    text = "".join(f"{p} {files[p][0]} {files[p][1]}\n" for p in sorted(files))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def describe(root=ROOT, when=None):
    spec = read_list(root)
    files = {p: entry(os.path.join(root, *p.split("/"))) for p in spec["files"]}
    return {"version": version_of(files), "time": int(clock.time() if when is None else when), "shell": spec["shell"], "files": files}


def release(root, out, tag, when=None):
    """A release's update assets into folder `out`: each file under its SHA-256 (once), and update.json naming them and the tag."""
    if not TAG.match(tag or ""):
        raise RuntimeError(f"not a tag: {tag!r}")
    d = dict(describe(root, when), tag=tag)
    os.makedirs(out, exist_ok=True)
    for p, (_, sha) in d["files"].items():
        with open(os.path.join(root, *p.split("/")), "rb") as a, open(os.path.join(out, sha), "wb") as b:
            b.write(a.read())
    with open(os.path.join(out, "update.json"), "w", encoding="utf-8") as f:
        json.dump(d, f, indent=1, sort_keys=True)
        f.write("\n")
    return d


def main(argv):
    when = None
    if "--time" in argv:
        i = argv.index("--time")
        when = int(argv[i + 1])
        argv = argv[:i] + argv[i + 2:]
    if len(argv) == 2 and argv[0] == "--bundle":
        d = describe(ROOT, when)
        with open(argv[1], "w", encoding="utf-8") as f:
            json.dump(d, f, indent=1, sort_keys=True)
            f.write("\n")
        print(f"bundled.json: the tool {d['version']}, {len(d['files'])} files, shell {d['shell']}")
        return 0
    if len(argv) == 4 and argv[0] == "--release" and argv[2] == "--tag":
        d = release(ROOT, argv[1], argv[3], when)
        print(f"release {d['tag']}: the tool {d['version']}, {len(d['files'])} files, update.json in {argv[1]}")
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
