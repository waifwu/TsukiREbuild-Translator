#!/usr/bin/env python3
"""line_map.py [repo root]: where every line of text.json is in the scripts -> web-dev/data/line_map.json.

Stage 0 of the translator tool (web-dev/TRANSLATOR-TOOL-PLAN.md). A translation is kept by line number; this map says
where each number is in the game: its scene, its script and command, the page it is on, whether it is glued to the row
before or is a choice, and its voice. It holds numbers and names only (scene names, op names, voice file names), never a
word of the game's text, so it can sit in the repository and ship with the tool.

Built from the English scripts (web/assets/scripts), which English (Tsukihimates and Aniplex) and Portuguese play.
Japanese and Chinese play web/assets/ja/scripts for 241 scripts the English rewrote: their commands are under "ja".

What the scripts say, and how it is read here (web/app/js/vm.js and textbox.js):
  - A line is named as $NNNNNN in an MSG, MSAD or SELR command (langsave.js idsOf). One command may name two (an MSG
    "$a^$b"), and 22 lines are named by two or three commands (the same text on two branches): every command is kept.
  - A page ends at the click after its last line, where the script sets F823 back to 0 (WKST F823 eq 0; CLO2 clears it
    too). Pages are cut there in a straight read of the script. A page's "runs" are the stretches of commands it is
    played from when a branch inside it (IF__, IFSC, IFUR, GOTS, GOTO) makes that read wrong: one list per way through.
  - IFP4 always jumps (the PlayStation 4 version's block, vm.js op_IFP4): its commands never run in the port. Lines
    named only there are "dead" and have no page; "play from here" must not aim at them.
  - A line is glued when the port sets it on the row of the line before it: an MSAD (text added to the message on
    screen) with no row break (^) before it, or an MSG with @x. That is deepLuna's is_glued (713 lines) plus the
    English's timed continuations ("$a@k@e@n" then MSAD "$b"), which are on the same row too.
  - A voice is named by VPLY just before its message (16,680 lines); VPL2 plays a second one on top (voice2).
  - A page's "w" is the text window's style and place as the page starts (F1105-F1107, F1111-F1113: balloons in the
    Q&A corners), from the same straight read. Commands inside the page that change it are played by the fit page.
"""
import hashlib
import json
import os
import re
import sys

IDS = re.compile(r"\$(\d+)")
TEXT_OPS = ("MSG", "MSAD", "SELR")
WINDOW = ("F1105", "F1106", "F1107", "F1111", "F1112", "F1113")
FORKS = ("IF__", "IFSC", "IFUR")          # go to the label or on
ENDS = ("JUMP", "RTM_", "RTMN", "END_")   # the page goes on in another script, or the story stops
MAX_PATHS = 64


def names_line(op):
    """A text command that names a line (the debug menus' SELRs have literal scene names instead)."""
    return op[0] in TEXT_OPS and any(IDS.search(x) for x in op[1:])


def is_reset(op):
    return (op[0] == "WKST" and op[1:2] == ["F823"] and op[3:4] == ["0"]) or op[0] == "CLO2"


def label_of(op):
    """The label a jump command goes to (or labels, for GOTS), and whether it may also go on."""
    k = op[0]
    if k in FORKS:
        return [op[4] if k == "IF__" else op[2]], True
    if k == "IFP4":
        return [op[2]], False
    if k == "GOTO":
        return [op[1]], False
    if k == "GOTS":
        return [x for x in op[2:] if x], True
    return [], True


def scene_info(name):
    """Route, day and part from a scene's name: 05_01_CIEL05_3 is Ciel's day 5; 14_01B_02_CIEL14B_2 Ciel's day 14, part B."""
    m = re.match(r"(\d\d)_(\d\d)([AB]?)_", name + "_")
    if name in ("00_00", "00_01", "00_02"):
        return {"route": "prologue", "day": 0}
    if m and "ARC" in name:
        return {"route": "arcueid", "day": int(m[1])}
    if m and "CIEL" in name:
        info = {"route": "ciel", "day": int(m[1])}
        if m[3]:
            info["part"] = m[3]
        return info
    m = re.fullmatch(r"QA_(\d\d)", name)
    if m:
        return {"route": "qa", "episode": int(m[1])}
    return {"route": "system"}


def dead_ranges(ops, labels, wanted):
    """Commands inside an IFP4 block: from the IFP4 to its label, unless a label inside is jumped to from elsewhere."""
    at = {}
    for name, pc in labels.items():
        at.setdefault(pc, []).append(name)
    dead = set()
    for pc, op in enumerate(ops):
        if op[0] != "IFP4" or op[2] not in labels:
            continue
        end = labels[op[2]]
        for p in range(pc + 1, end):
            if any(n in wanted for n in at.get(p, [])):
                break
            dead.add(p)
    return dead


LITERAL = re.compile(r"-?\d+")


def decide(facts, var, cmp, value):
    """What a test of `var` against a literal comes to on a path that has already tested or set it: True, False or None."""
    if cmp not in ("eq", "ne") or not LITERAL.fullmatch(value) or var not in facts:
        return None
    kind, known = facts[var]
    v = int(value)
    if kind == "is":
        same = known == v
    elif v in known:
        same = False
    else:
        return None
    return same if cmp == "eq" else not same


def learn(facts, var, cmp, value, holds):
    if cmp not in ("eq", "ne") or not LITERAL.fullmatch(value):
        return facts
    facts = dict(facts)
    v = int(value)
    if (cmp == "eq") == holds:
        facts[var] = ("is", v)
    elif var not in facts or facts[var][0] == "not":
        facts[var] = ("not", (facts[var][1] if var in facts else frozenset()) | {v})
    return facts


def paths(ops, labels, starts):
    """Every way through a page from `start` to the click that ends it: lists of [from, to) runs, with whether the
    count was capped. Two ways that show the same lines are one, and a way that shows none is left out. A path keeps what
    it has learnt of a variable from the tests it passed (and literal WKSTs), so IF__ F075 ne 0 then IF__ F075 eq 0
    is one choice row, not both."""
    done, seen, capped = [], set(), False
    todo = [(start, [], frozenset(), {}) for start in reversed(starts)]
    while todo:
        pc, visited, onpath, facts = todo.pop()
        texted = any(names_line(ops[p]) for p in visited)
        while True:
            if pc >= len(ops) or pc in onpath:
                break
            op = ops[pc]
            if texted and is_reset(op):
                break
            visited = visited + [pc]
            onpath = onpath | {pc}
            k = op[0]
            if names_line(op):
                texted = True
            if k in ENDS:
                break
            if k == "WKST" and len(op) > 3:
                facts = {**facts, op[1]: ("is", int(op[3]))} if LITERAL.fullmatch(op[3]) else {x: y for x, y in facts.items() if x != op[1]}
            elif k in ("WKAD", "WKOR") and len(op) > 1 and op[1] in facts:
                facts = {x: y for x, y in facts.items() if x != op[1]}
            targets, on = label_of(op)
            targets = [labels[t] for t in targets if t in labels]
            if targets and not on:   # GOTO, IFP4: always
                pc = targets[0]
                continue
            if k == "IF__" and targets:   # goes to the label when the test fails
                holds = decide(facts, op[1], op[2], op[3])
                if holds is False:
                    facts = learn(facts, op[1], op[2], op[3], False)
                    pc = targets[0]
                    continue
                if holds is None:
                    if len(seen) + len(todo) + 1 >= MAX_PATHS:
                        capped = True
                    else:
                        todo.append((targets[0], visited, onpath, learn(facts, op[1], op[2], op[3], False)))
                    facts = learn(facts, op[1], op[2], op[3], True)
                pc += 1
                continue
            for t in targets:        # IFSC, IFUR, GOTS: there, or on
                if len(seen) + len(todo) + 1 >= MAX_PATHS:
                    capped = True
                    break
                todo.append((t, visited, onpath, facts))
            pc += 1
        key = tuple(p for p in visited if names_line(ops[p]))
        if not key or key in seen:
            continue
        seen.add(key)
        runs = []
        for p in visited:
            if runs and runs[-1][1] == p:
                runs[-1][1] = p + 1
            else:
                runs.append([p, p + 1])
        done.append(runs)
    return done, capped


def scan(ops, labels, wanted, entries=()):
    """One script: its commands that name lines, and its pages (a straight read)."""
    dead = dead_ranges(ops, labels, wanted)
    cmds, pages = [], []
    window = {k: 0 for k in WINDOW}
    page = None
    voice = voice2 = None
    tail = None   # what the message on screen ends with after its last line (an MSAD after "^" starts a new row)
    for pc, op in enumerate(ops):
        if pc in dead:
            if op[0] in TEXT_OPS:
                for nth, i in enumerate(int(x) for x in IDS.findall(",".join(op[1:]))):
                    cmds.append({"pc": pc, "nth": nth, "id": i, "op": op[0], "dead": 1, "page": None})
            continue
        k = op[0]
        if k in ("WKST", "WKAD") and len(op) > 2 and op[1] in WINDOW:
            v = op[-1]
            if re.fullmatch(r"-?\d+", v):
                window[op[1]] = int(v) if k == "WKST" else window[op[1]] + int(v)
        if is_reset(op) and page and page["texted"]:
            page["b"] = pc
            pages.append(page)
            page = None
        if page is None:
            page = {"a": pages[-1]["b"] if pages else 0, "texted": False, "w": [window[k] for k in WINDOW]}
        if k in ("VPLY", "VPL2"):
            if k == "VPLY":
                voice = op[1]
            else:
                voice2 = op[1]
            continue
        if k not in TEXT_OPS:
            continue
        arg = ",".join(op[1:])
        if names_line(op):
            page["texted"] = True
        parts = re.split(r"(\$\d+)", arg)
        nth = 0
        for j, piece in enumerate(parts):
            m = re.fullmatch(r"\$(\d+)", piece)
            if not m:
                continue
            c = {"pc": pc, "nth": nth, "id": int(m[1]), "op": k, "page": len(pages)}
            before = "".join(parts[:j])
            if k == "SELR":
                c["choice"] = 1
            elif nth == 0 and k == "MSG":
                if "@x" in arg:
                    c["glued"] = 1
            elif nth == 0:   # MSAD: on the row of the text before it unless a ^ comes between
                if tail is not None and "^" not in tail and "^" not in before:
                    c["glued"] = 1
            elif "^" not in IDS.split(before)[-1]:
                c["glued"] = 1
            if k != "SELR":
                if voice:
                    c["voice"] = voice
                if voice2:
                    c["voice2"] = voice2
            cmds.append(c)
            nth += 1
        if k != "SELR":
            voice = voice2 = None
            # after a blank MSG an MSAD starts that MSG's own row, so it is not glued to anything
            tail = IDS.split(arg)[-1] if nth else ("^" if k == "MSG" else (tail or "") + arg)
        else:
            tail = None
    if page and page["texted"]:
        page["b"] = len(ops)
        pages.append(page)
    entry = sorted(labels[n] for n in entries if n in labels)
    every = sorted(set(labels.values()))
    for p in pages:
        # a page is played from its start, and from a label inside it that another script jumps to (or, when no way from
        # those shows a line, from any label inside: the flowchart and the gallery enter scenes at labels too)
        inside = lambda pcs: [e for e in pcs if p["a"] < e < p["b"]]
        runs, capped = paths(ops, labels, [p["a"]] + inside(entry))
        if not runs:
            runs, capped = paths(ops, labels, [p["a"]] + inside(every))
        last = max(pc for pc in range(p["a"], p["b"]) if names_line(ops[pc]) and pc not in dead)
        # one straight run from the page's start past its last line: the page is [a, b) as it stands
        if not (len(runs) == 1 and len(runs[0]) == 1 and runs[0][0][0] == p["a"] and runs[0][0][1] > last):
            p["runs"] = runs
        if capped:
            p["capped"] = True
        del p["texted"]
        if not any(p["w"]):
            del p["w"]
    # A branch can put a line on the page before the one the straight read gives it (IF__ ... GOTO past the next click):
    # such a line belongs to the page whose way through shows it.
    covers = lambda p, pc: any(x <= pc < y for run in p.get("runs", [[[p["a"], p["b"]]]]) for x, y in run)
    for c in cmds:
        if c["page"] is None or covers(pages[c["page"]], c["pc"]):
            continue
        near = [k for k, p in enumerate(pages) if covers(p, c["pc"])]
        if near:
            c["page"] = min(near, key=lambda k: abs(pages[k]["a"] - c["pc"]))
        else:
            c["stray"] = 1   # no way through a page reaches it from the page's start (the report counts these)
    return cmds, pages


def disk_reader(assets):
    """read(rel) -> the bytes of a game file under `assets` ("scripts/0.json"), or None where it is not there."""
    def read(rel):
        try:
            with open(os.path.join(assets, *rel.split("/")), "rb") as f:
                return f.read()
        except (FileNotFoundError, NotADirectoryError):
            return None
    return read


def load_scripts(folder, names, base=None, read=None):
    """Script i from `folder`, or from `base` where `folder` has no copy (Japanese has only the scripts it changed). Folders on disk, or with
    `read` (disk_reader, web-dev/tools/gamefiles.py GameFiles.read) paths under the game's files ("scripts", "ja/scripts")."""
    if read is None:
        def read(path):
            try:
                with open(path, "rb") as f:
                    return f.read()
            except (FileNotFoundError, NotADirectoryError):
                return None
    out = []
    for i in range(len(names)):
        path = f"{folder}/{i}.json"
        raw = read(path)
        if raw is None and base:
            path = f"{base}/{i}.json"
            raw = read(path)
        if raw is None:
            raise FileNotFoundError(f"{folder}/{i}.json")
        out.append((path, raw, json.loads(raw)))
    return out


def wanted_labels(scripts, index):
    """Per script, the labels something jumps to (in the script, or a JUMP from another), and those JUMPs reach."""
    by_id = {int(k): v for k, v in index["jump"].items()}
    want = [set() for _ in scripts]
    entries = [set() for _ in scripts]
    for i, (_, _, s) in enumerate(scripts):
        for op in s["ops"]:
            targets, _ = label_of(op)
            want[i].update(targets)
            if op[0] == "JUMP" and len(op) > 2 and op[2]:
                t = by_id.get(int(op[1])) if op[1].isdigit() else None
                if t is not None:
                    want[t].add(op[2])
                    entries[t].add(op[2])
    return want, entries


def build(root=None, read=None):
    """The map of the scripts in `root`/web/assets, or of the game's files `read` gives (gamefiles.py: an installed app's)."""
    if read is None:
        read = disk_reader(os.path.join(root, "web", "assets"))
    index = json.loads(read("scripts/index.json"))
    names = index["names"]
    count = len(json.loads(read("text.json")))
    scripts = load_scripts("scripts", names, read=read)
    want, entries = wanted_labels(scripts, index)
    digest = hashlib.sha1()
    lines = [{"id": i, "at": []} for i in range(count)]
    pages = []
    for i, (_, raw, s) in enumerate(scripts):
        digest.update(raw)
        cmds, own = scan(s["ops"], s["labels"], want[i], entries[i])
        first = len(pages)
        for k, p in enumerate(own):
            pages.append({"s": i, "k": k, **p})
        for c in cmds:
            ln = lines[c["id"]]
            at = {"s": i, "pc": c["pc"], "nth": c["nth"], "op": c["op"], "page": None if c["page"] is None else first + c["page"]}
            for key in ("dead", "stray"):
                if c.get(key):
                    at[key] = 1
            ln["at"].append(at)
            for key in ("glued", "choice", "voice", "voice2"):
                if key in c:
                    ln[key] = c[key]
    for ln in lines:
        live = [a for a in ln["at"] if not a.get("dead")]
        if ln["at"] and not live:
            ln["dead"] = 1
    # Japanese and Chinese: the commands that name each line in the scripts they play, where those differ.
    ja = {"scripts": [], "at": {}}
    own = [i for i in range(len(names)) if read(f"ja/scripts/{i}.json") is not None]
    if own:
        ja["scripts"] = own
        ja_scripts = load_scripts("ja/scripts", names, "scripts", read=read)
        ja_want, _ = wanted_labels(ja_scripts, index)
        where = {}
        for i in own:
            cmds, _ = scan(ja_scripts[i][2]["ops"], ja_scripts[i][2]["labels"], ja_want[i])
            for c in cmds:
                where.setdefault(c["id"], []).append({"s": i, "pc": c["pc"], "nth": c["nth"], "op": c["op"]})
        for i, ln in enumerate(lines):
            en = [{"s": a["s"], "pc": a["pc"], "nth": a["nth"], "op": a["op"]} for a in ln["at"] if a["s"] in own]
            jw = where.get(i, [])
            if en != jw:
                ja["at"][str(i)] = jw
    return {
        "format": 1,
        "about": "web-dev/tools/line_map.py: where each text.json line is in the scripts. Numbers and names only.",
        "source": {"scripts": "web/assets/scripts", "sha1": digest.hexdigest(), "scripts_count": len(names), "lines": count},
        "scenes": [{"name": n, **scene_info(n)} for n in names],
        "unnamed": [ln["id"] for ln in lines if not ln["at"]],
        "twice": [ln["id"] for ln in lines if len(ln["at"]) > 1],
        "pages": pages,
        "lines": lines,
        "ja": ja,
    }


def dumps(m):
    """The map as line_map.json has it: one page or line a row, so a change to the scripts shows as a small diff."""
    dump = lambda x: json.dumps(x, ensure_ascii=True, separators=(",", ":"))
    head = {k: v for k, v in m.items() if k not in ("scenes", "pages", "lines", "ja")}
    out = ["{"]
    for k, v in head.items():
        out.append(f"{json.dumps(k)}:{dump(v)},")
    for k in ("scenes", "pages", "lines"):
        out.append(f"{json.dumps(k)}:[")
        out.append(",\n".join(dump(x) for x in m[k]))
        out.append("],")
    out.append(f'"ja":{dump(m["ja"])}')
    out.append("}")
    return "\n".join(out) + "\n"


def write(m, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(dumps(m))


def main():
    root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
    m = build(root)
    out = os.path.join(root, "web-dev", "data", "line_map.json")
    write(m, out)
    lines = m["lines"]
    named = sum(1 for ln in lines if ln["at"])
    multi = [p for p in m["pages"] if len(p.get("runs", [])) > 1]
    print(f"{out}: {named} of {len(lines)} lines named ({len(m['unnamed'])} never, {len(m['twice'])} by more than one command, "
          f"{sum(1 for ln in lines if ln.get('dead'))} only in PS4 blocks); {len(m['pages'])} pages, {len(multi)} with branches "
          f"({sum(1 for p in m['pages'] if p.get('capped'))} capped); {sum(1 for ln in lines if ln.get('voice'))} voiced, "
          f"{sum(1 for ln in lines if ln.get('glued'))} glued, {sum(1 for ln in lines if ln.get('choice'))} choices; "
          f"Japanese: {len(m['ja']['scripts'])} scripts of its own, {len(m['ja']['at'])} lines at other commands")


if __name__ == "__main__":
    main()
