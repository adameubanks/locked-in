#!/usr/bin/env python3
"""Build content/glossary.json from the textbook PDFs.

Definitions/theorems are well-delimited blocks in both volumes, so they can be
lifted mechanically. Headwords are guessed from the phrasing and then overridden
by hand for the chapters we've authored (see curate.json).
"""
import subprocess, re, json, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = json.load(open(os.path.join(ROOT, "content", "manifest.json")))

def pdf_path(rel):
    return rel if os.path.isabs(rel) else os.path.join(ROOT, rel)

# Page ranges are extract-only; path/offset/ligatures come from the manifest.
BOOKS = [
    {"vol":"vol3","offset":6,"first":19,"last":378,"lig":False},
    {"vol":"vol4","offset":0,"first":3,"last":140,"lig":True},
]
for b in BOOKS:
    v = next(x for x in MANIFEST["volumes"] if x["id"] == b["vol"])
    b["pdf"] = pdf_path(v["pdf"])
    b["offset"] = v.get("pageOffset", b["offset"])
    b["lig"] = v.get("fixLigatures", b["lig"])
KINDS = r"(Definition|Theorem|Lemma|Corollary|Proposition|Axiom)"
START = re.compile(r"^\s*" + KINDS + r"\s+(\d+\.\d+\.\d+)\.?\s*(.*)$")
STOP  = re.compile(r"^\s*(" + KINDS + r"|Proof|Example|Remark|Nota Bene|Unexample|Figure|Algorithm|Exercise)\b")

# Vol 4's PDF has a broken glyph map. Each of these was pinned against a passage
# whose correct form is known, e.g. p.55: "|f(x1,t) - f(x2,t)| <= L|x1 - x2| for
# all (x1,t),(x2,t) in E" arrives as "↑f (x1 , t) ↓ f (x2 , t)↑ ′ L↑x1 ↓ x2 ↑ ... → E".
V4_MATH = {
    "↑": "\u2016",  # norm bars
    "↓": "\u2212",  # minus
    "′": "\u2264",  # <=
    "≃": "\u2265",  # >=
    "→": "\u2208",  # in
    "↗": "\u00d7",  # times
    "⇐": "\u2192",  # ->
    "⇒": "\u221e",  # infinity
    "↙": "\u2286",  # subset-eq
    "∞": "\u2200",  # for all
}
V4_TABLE = str.maketrans(V4_MATH)

def fix_lig(s):
    # ff/ffi ligatures are lost. Repair only between letters, so section headings
    # (where '!' means the digit 1) are untouched.
    s = re.sub(r"(?<=[A-Za-z])!(?=[a-z])", "ff", s)
    s = re.sub(r"(?<=[A-Za-z])\"(?=[a-z])", "ffi", s)
    s = s.replace("\u21d4=", "\u2260")          # two-char case, before the table
    # "→" is overloaded: spaced it means "in", but tight between alphanumerics it
    # is a superscript minus (k→1 is k-1, LT→1 is LT^-1). Resolve by spacing.
    s = re.sub(r"(?<=[A-Za-z0-9])\u2192(?=[A-Za-z0-9])", "\u2212", s)
    # a superscript can float free of its base in layout mode ("LT→1" -> " →1"),
    # and "in 1" is meaningless, so an arrow before a digit is always a minus
    s = re.sub(r"\u2192(?=[0-9])", "\u2212", s)
    return s.translate(V4_TABLE)   # simultaneous, so remapped chars aren't re-remapped

def clean(s):
    return re.sub(r"\s+", " ", s).strip()

def page_text(pdf, p):
    return subprocess.run(["pdftotext","-layout","-f",str(p),"-l",str(p),pdf,"-"],
                          capture_output=True, text=True).stdout

# --- headword heuristics, most specific first -------------------------------
PATTERNS = [
    (r"^\(([^)]{3,48})\)", 1),                                  # Theorem 2.3.1 (Picard-Lindelof)
    (r"\bBy\s+(?:the\s+)?([a-z][a-z \-]{2,40}?)\s*\((?:[A-Z]{2,6})\)?\s*we mean", 1),
    (r"\bBy\s+(?:the\s+)?([a-z][a-z \-]{2,40}?)\s+we mean", 1),
    (r"\bis called (?:the |a |an )?([a-z][a-z \-]{2,40}?)[\.,]", 1),
    (r"\bwe (?:say|call)[^.]{0,30}?\b(?:is|are)\s+([a-z][a-z \-]{2,40}?)[\.,]", 1),
    (r"^(?:The|A|An)\s+([a-z][a-z \-]{2,40}?)\s+of\b", 1),
    (r"^(?:The|A|An)\s+([a-z][a-z \-]{2,40}?)\s+(?:is|are|occurs)\b", 1),
    (r"^Given[^,]{0,60},\s*the\s+([a-z][a-z \-]{2,40}?)\s+(?:of|is)\b", 1),
    (r"\bthe\s+([a-z][a-z \-]{2,40}?)\s+of\s+[A-Z]\b", 1),
]
NOISE = {"following","form","set","function","same","above","case","value","values",
         "collection","result","quantity","number","point","space","sum"}

def headword(title, body):
    probe = (title + " " + body)[:320]
    for pat, g in PATTERNS:
        m = re.search(pat, probe)
        if m:
            t = clean(m.group(g)).strip(" .,;:").lower()
            t = re.sub(r"^(the|a|an)\s+", "", t)
            if 3 <= len(t) <= 48 and t not in NOISE and not t.split()[0] in NOISE:
                return t
    return None

entries = []
for b in BOOKS:
    buf, cur = [], None
    for p in range(b["first"], b["last"]+1):
        txt = page_text(b["pdf"], p)
        if b["lig"]: txt = fix_lig(txt)
        book_page = p - b["offset"]
        for line in txt.split("\n"):
            m = START.match(line)
            # A cross-reference that happens to wrap to the start of a line
            # ("...compare Proposition 5.8.1 below), but the different...")
            # matches too. A real block's statement opens with a capital or a
            # parenthesised name, never mid-sentence in lower case.
            if m and m.group(3).strip()[:1].islower(): m = None
            if m:
                if cur: entries.append(cur)
                cur = {"vol":b["vol"], "page":book_page, "kind":m.group(1),
                       "num":m.group(2), "title":m.group(3).strip(), "lines":[]}
            elif cur is not None:
                if STOP.match(line) or len(cur["lines"]) > 16:
                    entries.append(cur); cur = None
                elif line.strip():
                    cur["lines"].append(line.strip())
    if cur: entries.append(cur)

out = []
for e in entries:
    body = clean(" ".join(e["lines"]))
    if len(body) < 15: continue
    hw = headword(e["title"], body)
    out.append({
        "id": f"{e['vol']}-{e['num']}",
        "vol": e["vol"], "page": e["page"], "kind": e["kind"], "num": e["num"],
        "terms": [hw] if hw else [],
        "text": (clean(e["title"]) + " " + body).strip()[:900]
    })

# de-dup by id, keeping the first occurrence
seen, uniq = set(), []
for e in out:
    if e["id"] in seen: continue
    seen.add(e["id"]); uniq.append(e)

cur = json.load(open("build/curate.json"))
by = {e["id"]: e for e in uniq}
NOISE_HW = {"axioms","distribution","following","same","form"}
for k, v in cur.items():
    if k.startswith("_"): continue
    if k in by: by[k]["terms"] = v
    else: print("  curated id not in glossary:", k)
for e in uniq:
    if e["id"] not in cur:
        e["terms"] = [t for t in e["terms"] if t not in NOISE_HW and len(t) > 4]

json.dump({"entries": uniq}, open(os.path.join(ROOT, "content", "glossary.json"), "w"), indent=1, ensure_ascii=False)
named = sum(1 for e in uniq if e["terms"])
print(f"entries: {len(uniq)}  with headword: {named}  ({100*named//max(1,len(uniq))}%)")
from collections import Counter
print("by kind:", dict(Counter(e["kind"] for e in uniq)))
print("by vol :", dict(Counter(e["vol"] for e in uniq)))
