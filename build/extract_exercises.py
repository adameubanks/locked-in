#!/usr/bin/env python3
"""Map each section to its exercise group.

Both volumes collect exercises at the end of a chapter and separate the
per-section groups with horizontal rules (Vol 3 Ch 1 says so explicitly in its
"Note to the student"). The rules are vector graphics, so pdftotext drops them
entirely -- they have to be found in a rendered page.

N sections are delimited by N+1 rules. Figure/example boxes also draw full-width
horizontals, but those come in close pairs (a top and a bottom edge), so a rule
with a neighbour within MIN_GAP px is discarded.

Vol 3 Ch 0 is the degenerate case: its exercises are numbered against the chapter
rather than the section, so there is one undivided group and no rule at all.
"""
import subprocess, glob, os, re, json, tempfile, sys
from PIL import Image
import numpy as np

DPI, MIN_FRAC = 100, 0.40
EXNUM = re.compile(r"^\d+\.\d+\.?$")

def words_on(pdf, page):
    """(y-fraction, text) for every word on the page, top to bottom."""
    xml = subprocess.run(["pdftotext","-bbox","-f",str(page),"-l",str(page),pdf,"-"],
                         capture_output=True, text=True).stdout
    m = re.search(r'<page width="([\d.]+)" height="([\d.]+)"', xml)
    if not m: return []
    ph = float(m.group(2))
    out = []
    for w in re.finditer(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>', xml):
        out.append((float(w.group(2))/ph, float(w.group(1)), w.group(5).strip()))
    out.sort(key=lambda t: (t[0], t[1]))   # by line, then left-to-right
    return out

def rules_on(pdf, page, tmp):
    subprocess.run(["pdftoppm","-r",str(DPI),"-f",str(page),"-l",str(page),
                    "-gray","-png",pdf,os.path.join(tmp,"pg")], check=True)
    f = sorted(glob.glob(os.path.join(tmp,"pg-*.png")))
    if not f: return [], 1
    a = np.asarray(Image.open(f[0]).convert("L")); h, w = a.shape
    for x in f: os.remove(x)
    dark = a < 128
    found = []
    for y in range(h):
        xs = np.flatnonzero(dark[y])
        if len(xs) < w*MIN_FRAC: continue
        segs = np.split(xs, np.flatnonzero(np.diff(xs) > 1)+1)
        seg = max(segs, key=len)
        if len(seg) > w*MIN_FRAC: found.append((y, int(seg[0]), int(seg[-1])))
    # collapse a thick rule's several rows into one
    merged = []
    for r in found:
        if merged and r[0] - merged[-1][0] <= 3: merged[-1] = r
        else: merged.append(r)

    def boxed(y, x0, x1):
        """True if a vertical stroke meets the horizontal at either end -- the
        corner of a table or figure box, never a section divider."""
        for x in (x0, x0+1, x1-1, x1):
            if not (0 <= x < w): continue
            for lo, hi in ((max(0, y-14), max(0, y-2)), (min(h, y+2), min(h, y+14))):
                col = dark[lo:hi, x]
                if len(col) >= 8 and col.mean() > 0.85: return True
        return False

    keep = [y for y, x0, x1 in merged if not boxed(y, x0, x1)]
    return keep, h

def main():
    man = json.load(open("content/manifest.json"))
    out = {}
    for v in man["volumes"]:
        for c in v["chapters"]:
            if not c["file"]: continue
            ch = json.load(open("content/" + c["file"]))
            ex = ch.get("exercises")
            if not ex: continue
            secs = ch["sections"]
            marks, rejected = [], []
            pages = list(range(ex["from"], ex["to"]+1))
            with tempfile.TemporaryDirectory() as tmp:
                allrules, allwords = {}, {}
                for bp in pages:
                    pp = bp + v["pageOffset"]
                    ys, h = rules_on(v["pdf"], pp, tmp)
                    allrules[bp] = [y/h for y in ys]
                    allwords[bp] = words_on(v["pdf"], pp)

                def band_below(bp, yf):
                    """Text just under a rule. Uses a band rather than one line,
                    because stray math glyphs form their own micro-lines. Spills
                    to the next page (past its running head) for a foot-of-page
                    rule."""
                    band = [t for wy, wx, t in allwords[bp] if yf + 0.004 < wy < yf + 0.05]
                    if band: return band
                    ws = allwords.get(bp + 1) or []
                    if not ws: return []
                    top = ws[0][0]
                    body = [w for w in ws if w[0] > top + 0.012]      # skip running head
                    if not body: return []
                    ly = body[0][0]
                    return [t for wy, wx, t in body if wy < ly + 0.05]

                for bp in pages:
                    for yf in allrules[bp]:
                        # A divider is followed by an exercise number. A
                        # running-head rule is followed by a heading, a box edge
                        # by prose, and the closing rule by the Notes section.
                        band = band_below(bp, yf)
                        if any(EXNUM.match(t) for t in band) or (band and band[0].lower().startswith("note")):
                            marks.append((bp, round(yf, 4)))
                        else:
                            rejected.append((bp, round(yf, 4), " ".join(band[:6])))
            need = len(secs) + 1
            if not marks and len(secs) == 1:
                # A chapter whose exercises are numbered against the chapter
                # rather than the section (Vol 3 Ch 0) has one undivided group,
                # so there is no divider to find. The group is the whole range;
                # it opens at the "Exercises" heading rather than at the top of
                # the page, because the chapter text runs on above it.
                head = [wy for wy, wx, t in allwords[ex["from"]] if t.lower().startswith("exercise")]
                marks = [(ex["from"], round(head[0] - 0.006, 4) if head else 0.0)]
                need = 1
            status = "ok" if len(marks) == need else f"MISMATCH (want {need})"
            print(f"{v['id']} ch{ch['chapter']}: {len(secs)} sections, {len(marks)} rules  {status}")
            if len(marks) != need and os.environ.get("EXDEBUG"):
                for r in rejected: print(f"     rejected p{r[0]} y={r[1]}  next line: {r[2]!r}")
            if len(marks) >= need:
                # rule i opens section i's group
                for i, s in enumerate(secs):
                    bp, fy = marks[i]
                    s["exFrom"] = {"page": bp, "y": fy}
                    nxt = marks[i+1] if i+1 < len(marks) else (ex["to"], 1.0)
                    s["exTo"] = {"page": nxt[0], "y": nxt[1]}
            else:
                for s in secs: s.pop("exFrom", None); s.pop("exTo", None)
            ch["exMarks"] = [{"page": p, "y": y} for p, y in marks]
            json.dump(ch, open("content/"+c["file"], "w"), indent=1, ensure_ascii=False)
            out[v["id"]+":"+ch["chapter"]] = len(marks)
    return out

main()
