// languages.js - the languages the port plays, a row each (the translator tool's Stage 1: web-dev/TRANSLATOR-TOOL-PLAN.md).
//
// Adding a language is a row here, its folder under web/assets (web-dev/tools/build_layer.py makes a text-only one from a translations folder), and its
// page strings (sitewords-table.js: the row's words in the page's other languages; welcome.js: its credit). Everything that lists the languages is
// worked out from this table:
//   lang.js       the codes (?lang=, the choice kept, a device's language), the folders laid over the shared files, whose scripts a language plays,
//                 the page's lang attribute
//   home.js       LANGUAGE's plates and list, PLAY's line, the apps' download note
//   update.js     the folders the apps download for a language, its name in their questions
//   web-dev/tools/app_manifest.py   what the apps are built without, which folders come in packs (and so tools/cloudflare/deploy.py's cache rule)
// app_manifest.py reads the table as JSON between its two marks, so it is written as JSON: keys in quotes, no trailing commas, no comments inside.
// This module does nothing as it loads (update.js imports it and nothing else).
//
// A row:
//   code      the language's code
//   plate     its word on LANGUAGE's plate, and its row's label there
//   name      its name in English (the apps' download questions)
//   row       what it is, on LANGUAGE's list
//   start     PLAY's line when the game starts in it
//   layers    the folders laid over the shared files, lowest first (lang.js LAYERS); none for English
//   scripts   whose scripts it plays: "en" for text laid over the English (a save goes between the two as it stands, vm.js restore), else its own
//   html      the page's lang attribute
//   original  set as the original game sets its text (Japanese, and Chinese over it: style.css html.ja)
//   device    a device in this language starts in it (lang.js deviceLang)
//   download  the apps are built without its folders and download them when it is first chosen (update.js langPlan)
//   packs     its folders come to the apps in packs, and the site keeps their media 30 days (pictures, movies and faces of its own)
//   gated     shown only where its folder is: a language not yet released, played from a copy of the port that has its files. No device starts in
//             it, and where its folder is not, the site plays English (lang.js langReady)
//   coming    listed on LANGUAGE with no plate (on its way): not a language that can be chosen
export const LANGUAGE_TABLE = /* languages: */ [
  { "code": "en", "plate": "ENGLISH", "name": "English", "row": "The Tsukihimates fan translation, or Aniplex's official one.",
    "start": "The game starts in English: the Tsukihimates translation.", "layers": [], "scripts": "en", "html": "en", "device": true },
  { "code": "ja", "plate": "日本語", "name": "Japanese", "row": "The original game's text.",
    "start": "The game starts in 日本語, the original game's text.", "layers": ["ja"], "scripts": "ja", "html": "ja", "original": true, "device": true,
    "download": true, "packs": true },
  { "code": "zh", "plate": "中文", "name": "Chinese", "row": "The Chinese fan translation.",
    "start": "The game starts in 中文, the Chinese fan translation.", "layers": ["ja", "zh"], "scripts": "zh", "html": "zh-Hans", "original": true,
    "device": true, "download": true, "packs": true },
  { "code": "pt", "plate": "PORTUGUÊS", "name": "Portuguese",
    "row": "HanabiWorks' Brazilian Portuguese fan translation, finished up to Ciel's day 5: the rest is in English.",
    "start": "The game starts in PORTUGUÊS, HanabiWorks' Brazilian Portuguese fan translation.", "layers": ["pt"], "scripts": "en", "html": "pt-BR",
    "device": true, "download": true },
  { "code": "es", "plate": "ESPAÑOL", "row": "Taikutsu Translations' Spanish fan translation is in the works, expected in early 2027.", "coming": true }
] /* :languages */;
// (ESPAÑOL: the user, 2026-11-17, "mention Spanish ... expected to release by early 2027"; no link on LANGUAGE: "too big link")

// What follows works on any table (the tests give it others): the languages that can be chosen, and what each list is made of.
export const playable = (table = LANGUAGE_TABLE) => table.filter((r) => !r.coming);
export const codesOf = (table = LANGUAGE_TABLE) => playable(table).map((r) => r.code);
export const rowOf = (code, table = LANGUAGE_TABLE) => playable(table).find((r) => r.code === code) || null;
// The codes a device's language may start the game in (never a language not yet released: `gated`).
export const deviceCodes = (table = LANGUAGE_TABLE) => playable(table).filter((r) => r.device && !r.gated).map((r) => r.code);
// The folders laid over the shared files for a language, lowest first; English's official translation (lang.js OFFICIAL) is a folder of its own.
export const layersOf = (code, official = false, table = LANGUAGE_TABLE) => (official ? ["aniplex"] : [...(rowOf(code, table)?.layers || [])]);
// Whose scripts a language plays (a save made in one is carried to the other's commands when they differ: vm.js restore).
export const scriptsOf = (code, table = LANGUAGE_TABLE) => (code && rowOf(code, table)?.scripts) || code || "en";
export const isOriginal = (code, table = LANGUAGE_TABLE) => !!rowOf(code, table)?.original;
export const htmlLangOf = (code, table = LANGUAGE_TABLE) => rowOf(code, table)?.html || "en";
// The apps: the folders each downloaded language needs (lowest first), all such folders in order, those that come in packs, and the names.
export const langDirsOf = (table = LANGUAGE_TABLE) => Object.fromEntries(playable(table).filter((r) => r.download).map((r) => [r.code, [...r.layers]]));
const foldersWhere = (pick, table) => [...new Set(playable(table).filter(pick).flatMap((r) => r.layers))];
export const foldersOf = (table = LANGUAGE_TABLE) => foldersWhere((r) => r.download, table);
export const packedOf = (table = LANGUAGE_TABLE) => foldersWhere((r) => r.packs, table);
export const namesOf = (table = LANGUAGE_TABLE) => Object.fromEntries(playable(table).map((r) => [r.code, r.name]));
// LANGUAGE: a plate a language (the plate sheet is drawn in this order), a row a language and a coming one, PLAY's lines.
export const platesOf = (table = LANGUAGE_TABLE) => playable(table).map((r) => ({ lang: r.code, plate: r.plate }));
export const rowsOf = (table = LANGUAGE_TABLE) => table.map((r) => [r.plate, r.row]);
export const startLinesOf = (table = LANGUAGE_TABLE) => Object.fromEntries(playable(table).map((r) => [r.code, r.start]));
// "日本語, 中文 and PORTUGUÊS are downloaded the first time they are chosen." (null where none is)
export function downloadNoteOf(table = LANGUAGE_TABLE) {
  const p = playable(table).filter((r) => r.download).map((r) => r.plate);
  if (!p.length) return null;
  const names = p.length === 1 ? p[0] : `${p.slice(0, -1).join(", ")} and ${p.at(-1)}`;
  return `${names} ${p.length === 1 ? "is" : "are"} downloaded the first time ${p.length === 1 ? "it is" : "they are"} chosen.`;
}
// The rows shown only where their folder is: the folder whose list answers says it is there (lang.js reads the same list).
export const gatedOf = (table = LANGUAGE_TABLE) => playable(table).filter((r) => r.gated);
