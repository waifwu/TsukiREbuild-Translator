#!/usr/bin/env bash
# export_repo.sh DEST: the translator tool's repository (github.com/waifwu/TsukiREbuild-Translator) from this working folder, into DEST (a clone
# of it). The files keep the paths they have here (web/server.py, web-dev/tools/..., web-dev/translator-app/...), so the tool runs and tests
# the same in both. What goes:
#   - the tool's files (tool-files.json) and the one that describes them for updates (translator_manifest.py);
#   - the app (main.js, updater.js, build.sh, package.json and its lock, icons, README.md);
#   - the tests of the tool and the app, and web/app/js/languages.js, which they use as an app's language table (the port's code);
#   - the repository's own README.md, .gitignore and release workflow (repo/ here).
# Nothing of the game goes: no assets, no game text (the tests use invented lines). DEST's .git is left alone; files of the tool no longer
# listed are removed from DEST only where this script put them before (web-dev/translator, web-dev/fit, web-dev/tests, web-dev/tools).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
dest="${1:?usage: export_repo.sh DEST}"
mkdir -p "$dest"
dest="$(cd "$dest" && pwd)"
[ "$dest" != "$root" ] || { echo "DEST is this working folder" >&2; exit 2; }

files=()
while IFS= read -r f; do files+=("$f"); done < <(python3 -c 'import json,sys; [print(f) for f in json.load(open(sys.argv[1]))["files"]]' "$here/tool-files.json")
files+=(
    web-dev/tools/translator_manifest.py
    web-dev/translator-app/main.js web-dev/translator-app/updater.js web-dev/translator-app/tool-files.json web-dev/translator-app/build.sh
    web-dev/translator-app/export_repo.sh web-dev/translator-app/package.json web-dev/translator-app/package-lock.json
    web-dev/translator-app/README.md web-dev/translator-app/.gitignore web-dev/translator-app/build/icon.png web-dev/translator-app/build/icon-mac.png
    web-dev/tests/translator.test.mjs web-dev/tests/translator-update.test.mjs web-dev/tests/exchange.test.mjs
    web-dev/tests/build-layer.test.mjs web-dev/tests/line-map.test.mjs
    web/app/js/languages.js
)
for d in web-dev/translator web-dev/fit web-dev/tests web-dev/tools; do rm -rf "${dest:?}/$d"; done
for f in "${files[@]}"; do
    [ -f "$root/$f" ] || { echo "missing: $f" >&2; exit 1; }
    mkdir -p "$dest/$(dirname "$f")"
    cp -p "$root/$f" "$dest/$f"
done
cp -p "$here/repo/README.md" "$here/repo/.gitignore" "$dest/"
mkdir -p "$dest/.github/workflows"
cp -p "$here/repo/.github/workflows/release.yml" "$dest/.github/workflows/"
chmod +x "$dest/web-dev/translator-app/build.sh" "$dest/web-dev/translator-app/export_repo.sh"
echo "exported ${#files[@]} files and the repository's own into $dest"
