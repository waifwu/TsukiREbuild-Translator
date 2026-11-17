# Tsukihime Translator (the translator tool as an app)

`Tsukihime Translator.exe` is the translator tool (`web-dev/TRANSLATOR-TOOL-PLAN.md`) for people who have the game's PC build installed. It runs on top of that game: it reads the game's files and never changes them. The translation is kept in a folder of the translator's own, usually their own repository.

It is published from its own repository, [waifwu/TsukiREbuild-Translator](https://github.com/waifwu/TsukiREbuild-Translator): the app is downloaded from that repository's Releases page, and installed apps update themselves from its latest release (see "Updates" and "Publishing" below).

```bash
web-dev/translator-app/build.sh          # out/TsukihimeTranslator-win-x64.zip (about 150 MB)
web-dev/translator-app/build.sh mac      # out/mac-arm64/, for trying it on a Mac (it uses the Mac's python3)
```

## For a translator

1. Have the game: the Windows zip from arcueid.date, extracted into a folder of its own (`Tsukihime.exe`, with `resources\www` beside it).
2. Download `TsukihimeTranslator-win-x64.zip` from the [latest release](https://github.com/waifwu/TsukiREbuild-Translator/releases/latest) and extract it anywhere, for example next to the game. Run `Tsukihime Translator.exe`.
   - It is not signed, as the game is not. Windows shows its SmartScreen notice: More info, Run anyway.
3. It finds the game by itself. It looks:
   - where it found it last;
   - in its own folder and the one above it;
   - in Downloads, Desktop, Documents, the home folder, `C:\Games`, `D:\Games`, Program Files and `%LOCALAPPDATA%\Programs`, in any folder whose name has "tsuki" (and one level inside).

   Otherwise it asks where `Tsukihime.exe` is, with a link to get the game.
4. The first time, it asks for the translation's folder. An empty folder starts a new translation. File → Open another translation folder changes it later.
5. The editor opens in its window, on the line last worked on: scenes, columns, checks, preview, glossary, search, import and export (the plan's Stages 2–6). "Help" in its bar explains how it works: five steps to a first line, the window, the keys and the marks. "Play from here" opens the game in a second window of the app, playing the translation as it is saved.

Lines are saved into the translation's folder a moment after each change, as one JSON file per scene. Commit that folder to the translators' repository. Releasing it as a language of the port is the port's owner's job (`build_layer.py`).

## Updates

`updater.js`, called from `main.js`:

1. **Looking.** Once the editor is up, the app reads `update.json` from the repository's latest release (`https://github.com/waifwu/TsukiREbuild-Translator/releases/latest/download/update.json`; `tool-files.json` "repository"). That file names every tool file (the server, the editor, the fit page: `tool-files.json`) with its size and SHA-256, a version made from all of them, the commit's time, the release's tag, and the app it needs ("shell").
2. **Taking a newer release.** When the release is another version, newer than the tool in use and not one given up before, the app puts it together in its data folder (`%APPDATA%\Tsukihime Translator\tool-updates\<version>\tool`):
   - files it already has are copied;
   - the others are downloaded from the release (each an asset named by its SHA-256) and checked against their hashes;
   - only GitHub's own hosts are accepted.

   It then asks to restart the editor ("Later": the next time it opens). The tool it ran before stays until the new one has come up.
3. **A release the app cannot take.** When the release needs a newer app (its `shell` is higher than `main.js` `TOOL_SHELL`), the app does not take it and offers the releases page instead (once per release).
4. **When an update fails.** When an update's server does not start, the tool from before it is started. If that one comes up, the update is given up and never offered again. An update whose editor does not come up twice running is given up too.
5. **A new app.** A new download of the app (another `bundled.json`) drops all updates.

Help → Check for updates and Help → About are in the menu. Nothing but GitHub is reached beyond this computer, and the translation folder is never touched by an update.

## Publishing (the maintainer)

1. **Fill the repository.** `web-dev/translator-app/export_repo.sh <clone of TsukiREbuild-Translator>` copies the tool, the app, their tests and the repository's own README, `.gitignore` and release workflow (`repo/` here) into a clone of the repository, at the same paths as here. Commit and push there.
2. **Release.** A tag `vYYYY.MM.DD` pushed to that repository makes a release (`repo/.github/workflows/release.yml`):
   - the tests run;
   - `build.sh` builds the Windows app, with `TOOL_TIME` set to the commit's time;
   - `translator_manifest.py --release` writes `update.json` and the tool files;
   - the release is made as a draft with all of it attached, then published.
3. **What reaches installed apps.** A change to the tool's files reaches installed apps by itself. A change to the app itself (`main.js`, `updater.js`, Electron, the bundled Python) reaches only new downloads. When the tool comes to need such a change, raise `shell` in `tool-files.json` and `TOOL_SHELL` in `main.js` together (a test pins them equal).
4. **Public.** The repository must be public: GitHub serves a private repository's release files only to people signed in to it, so neither the download nor the updates would work.

## How it works

- `main.js` (Electron, the desktop game's version 45.3.0) finds the game's page and files (`<game>\resources\www`) and the game app's own data folder (`%APPDATA%\Tsukihime`). The data folder holds the update the game plays and the languages it downloaded, Japanese among them, so the default Japanese column is there once the game has it.
- It then starts the tool's server: `resources\python\python.exe -I -X utf8 resources\tool\web-dev\tools\dev_server.py <a free port> --app <data folder> --app <www> --translations <folder>`. The Python is python.org's embeddable package (3.15.2, its SHA-256 pinned in `build.sh` and checked at every build).
  - The server listens on this computer only. It is the same one as in the checkout: its writes need the editor's own page and token (`dev_server.py`).
  - `-X utf8` keeps the console in UTF-8 under any Windows code page, so a folder named in Spanish works.
- The editor opens at `http://localhost:<port>/translator/`.
  - Other addresses open in the computer's browser.
  - The window asks before closing with lines not yet saved, since Electron would otherwise close without asking.
  - Closing it stops the server.
- What the app packs of the tool is `package.json` `extraResources`, the files `tool-files.json` lists:
  - `web/server.py`;
  - `web-dev/tools`: `dev_server.py`, `gamefiles.py`, `line_map.py`, `translations.py`, `build_layer.py`, `exchange.py`, `build_pt.py`, `story-font-cover.json`;
  - `web-dev/translator`;
  - `web-dev/fit`;
  - and `bundled.json`, which `build.sh` writes to describe them (`translator_manifest.py --bundle`).

  `web-dev/tests/translator.test.mjs` checks that this covers every file the server loads; `translator-update.test.mjs` that it is exactly `tool-files.json`'s list.
- The app keeps its settings (the game's place, the translation's folder, the port) and the tool's updates (`tool-updates\`) in its own data folder, `%APPDATA%\Tsukihime Translator`.
  - The port is the last one used, where it is free. The editor's own settings (columns, widths, where you left off) are kept by the page per `http://localhost:PORT`, so a new port would forget them.

## Tried

- **2026-11-17, on this Mac:**
  - unpacked (`npm start` with `--game` / `--translations`), over a folder laid out as the Windows game is, with a translation folder of over 20,000 lines;
  - it started the server with this Mac's Python and opened the editor;
  - the preview laid a page out, and "Play from here" opened the game in a second window, playing the translated line;
  - quitting stopped the server.
- **Updates, 2026-11-17, on this Mac:** a hidden second copy of the app (`--user-data-dir`, `--test-answer`), started on an older tool (the editor before Help), against a release folder served on this computer:
  - it found the release, downloaded the 3 changed files, restarted on them on the same port, and confirmed them;
  - started again, it ran the update and found nothing newer;
  - a release whose server exits was given up, and the editor came back on the version before it;
  - a release with a higher `shell` was not taken, and the app offered the releases page.

  A real release redirect (a public project's `releases/latest/download/…`) ends on `release-assets.githubusercontent.com`, which the updater accepts.
- **The Windows zip's own files:** the packed tool files were run by themselves (this Mac's Python, over the same folder), and the editor, fit page, draft and checks all answered.
- **Not run on Windows:** there is no Windows machine here. The `.exe` (a 64-bit Windows program by `file`) and its Python have never been started, as with the game's own Windows and Linux builds.

## For testing (unpacked)

`npm start -- --game=DIR --translations=DIR [--python=PATH]`. For the updates: `--tool=DIR` (a tool tree with a `bundled.json`, e.g. an `export_repo.sh` copy with older files and `translator_manifest.py --bundle`), `--update-origin=http://127.0.0.1:PORT` (a folder written by `translator_manifest.py --release DIR --tag TAG`, served on this computer), `--test-answer=restart|later` (answers the app's questions, writes its log to the terminal and keeps the window hidden), and `--user-data-dir=DIR` (its own data folder; without it a second copy hands over to the one already open, Electron keeping its data by the app's name). Electron's own install script is not run by `npm install` here, so run the desktop app's copy: `../desktop/node_modules/.bin/electron . --game=…`. `--remote-debugging-port=9333` lets Playwright (`chromium.connectOverCDP`) drive the window.
