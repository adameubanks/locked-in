# LOCKED IN

A study environment for ACME Volumes 3 and 4. The textbook and the study
scaffolding live in one window, so reading and retrieval aren't in separate apps.

## Install

Linux, Node 18+, and your own copies of the two textbook PDFs. Electron ships
its own runtime, so that is the whole list. Verified on Node 18.20.3 / npm
10.7.0.

From the project directory:

    npm install

That pulls Electron 32, pdf.js and the Anthropic SDK — about 500 MB, nearly all
of it the Electron binary.

Then point the app at the books. Each volume in `content/manifest.json` carries
an absolute path and a page offset, and those paths are the only thing you have
to change:

    { "id": "vol3", ..., "pdf": ".../Vol3.pdf",        "pageOffset": 6 }
    { "id": "vol4", ..., "pdf": ".../Vol4_Ch1-4.pdf",  "pageOffset": 0 }

Get one wrong and the reader says so in the pane and names the file it expected,
so this is hard to get subtly wrong. `pageOffset` is pdfPage minus bookPage —
re-derive it if your scan is numbered differently by opening to any page with a
printed number and subtracting.

    npm start

`~/.locked-in/` is created on first run. Nothing else is written outside the
repo, and nothing but `ask ai` touches the network.

### Launcher

    cp build/locked-in.desktop ~/.local/share/applications/

Linux only. It hardcodes the repo location in `Exec`, `Path` and `Icon`, so edit
those three lines if it doesn't live in `~/Projects/locked-in`.

### If the window comes up blank

    LOCKEDIN_NOGPU=1 npm start

Disables hardware acceleration, which some GPU and driver combinations need.

### Definitions and clickable terms

`content/glossary.json` is not in the repo. It is the book's own text — the
definitions, theorems and lemmas lifted from the PDFs — so it stays with whoever
owns the book. Build your own copy from your own PDFs:

    sudo apt install poppler-utils
    pip3 install pillow numpy
    python3 build/extract_glossary.py

`extract_glossary.py` keeps its own `BOOKS` list at the top of the file, with
the same two absolute paths as the manifest; point those at your PDFs as well.
Until you run it, Explain mode and the hover/click definitions come up empty.
Reading, the cards, the exercises pane and search all work without it.

`ask ai` is optional and is the only part that needs an API key — see
[Ask ai](#ask-ai).

## The loop

The section selector at the top of the study pane is the only navigation
control. Pick a section and both panes go there — the textbook, the exercises,
and the cards. It lists every section of both volumes, so switching volume is
just picking a section in the other one; there is no separate volume control and
no button to press. Scrolling the textbook works the other way round: move into
a new section and the selector, the cards, and the exercises follow you.

It opens where you left off.

- **Read** — questions through the text, to check understanding as you go.
- **Explain** — the book's own definitions and theorems for that section. You
  write each one in your own words *before* seeing the book's wording. What you
  write is kept.
- **Brain rot** — every concept in the section re-explained at the lowest
  cognitive load, for when you're too fried for the real thing.

Every card is always available. There are no due dates, no queue, and nothing
is ever withheld until some interval elapses — pick a section and study it. The
count on each mode tells you what that section actually holds before you click
in.

Each mode shows the **whole section at once**. Every question is on screen from
the start; answers are collapsed one card at a time, so you can open the fourth
without touching the first three, work in any order, or hit `reveal all` and just
read the lot. Brain rot has nothing to reveal — it's all open by design. Opening
a card is a toggle, not a re-render, so it never moves the cards around you or
loses your place in the list.

Terms are live everywhere, including **inside the PDF**: hover any term the book
defines and its definition pops up, wherever in either volume it was defined.
Acronym headwords match only in their own case, so `MAP` and `BLUE` link where
they are meant to and the ordinary words "map" and "blue" are left alone.
Hover uses caret hit-testing rather than wrapping words, so selecting text still
works normally.

`lock in` goes fullscreen.

Attempting the exercises isn't a mode: `exercises` opens a second pane that
shows the current section's exercise group and follows you as you move.

## Layout

The textbook fills the left pane at full height. The right pane is the study
side: the question on top, and beneath it the current section's exercises.

`exercises` (top bar, or `e`) is the only toggle. The pane shows the current
section's exercise group and re-navigates whenever the section changes --
including when you just scroll the textbook into a new section. Drag the divider
to resize it.

Exercise pages are scaled to their text column rather than the full page, so the
type stays the same size as the textbook; the margins clip off the sides.

## Ask ai

Select a passage in the reader and `ask ai` — the only button on the selection
popover. (To copy, just `Ctrl-C`.) The passage is pinned as context
along with the full text of the page it came from, and you can ask follow-ups —
the passage stays in the history rather than being dropped after the first turn.
Answers stream in; `Stop` cuts one off and keeps what arrived. `Enter` sends,
`Shift-Enter` newlines, `Esc` closes.

**This is the only part of the app that touches the network.** It needs a key:

    ~/.locked-in/config.json     { "apiKey": "sk-ant-…" }

or an exported `ANTHROPIC_API_KEY` before `npm start`. The config file is the
primary path because a `.desktop` launcher inherits no shell environment. The
key is read in the main process and never crosses into the renderer — the page's
CSP still forbids the renderer from making any outbound request at all. Add a key
and just ask again; no restart. `config.json` also takes `model` (default
`claude-opus-5`) and `effort` (default `medium`).

### Scoping it to what the ACME policy allows

The policy permits LLMs for concept explanation and forbids AI-produced
coursework. Two things keep this on the right side of that line:

- The system prompt refuses to solve exercises, write code, or produce a worked
  answer to a numbered problem, and redirects to the concept being tested.
- Selecting from a page inside a chapter's exercise range shows a warning before
  you ask. It doesn't block you — it just makes it hard to wander across the line
  by accident.

Neither is a substitute for your own judgement about what you submit.

## Search

`/` or `Ctrl-F` searches every page of both volumes at once — body text, theorems,
and exercises. Results are one row per page in book order: printed page,
section, a snippet with the match highlighted, and a count when a page holds
several. `↓`/`↑` walk the results, `Enter` jumps the reader there and closes the
overlay. The query and the result list survive closing, so reopening puts you
back in the same list.

The index is built from the PDFs on first search (about three seconds for 532
pages) and kept for the rest of the session; it also warms the other volume, so
the first jump across volumes is instant afterwards.

Two repairs happen while indexing, or searching would quietly miss things:

- **Line breaks are kept.** pdf.js hands back text in fragments; joining them
  naively fuses the last word of a line to the first of the next (`phase` +
  `in` becomes `phasein`) and welds running heads onto body text. There are
  24,161 line breaks across the two volumes.
- **LaTeX's end-of-line hyphenation is undone** — `under-`/`standing` becomes
  `understanding`, about 600 words across both volumes. Anchoring on the line
  break means an inline compound like `two-dimensional` is left alone.

Vol 4 additionally loses its ff/ffi ligatures, so 82 of its 140 pages carry
`di!erent` for `different`; the indexer repairs those between letters, driven by
`fixLigatures` on the volume in `manifest.json`. Vol 3 doesn't need it — its four
apparent cases are large math delimiters, not broken ligatures.

Vol 4's **math** symbols stay as the PDF gives them, so snippets from equation-heavy
pages read poorly. The remap table in `build/extract_glossary.py` does *not* apply
here: `pdftotext` and pdf.js assign different code points to the same broken
glyphs (pdf.js gives `≃` where the glossary path sees `⇒` for ∞, and so on), so
reusing it would corrupt the text rather than fix it. Repairing it for search
would need its own pinning pass against known passages.

## Clickable terms

Terms in card text are underlined in amber. Clicking one shows the book's own
definition or theorem, with a button to open that page in the reader.

The glossary is built from the PDFs by `build/extract_glossary.py`, which lifts
every Definition/Theorem/Lemma/Corollary/Proposition block with its page number.
Headwords are guessed from phrasing and then overridden by `build/curate.json`
for the chapters we've authored. Rebuild after adding a chapter:

    python3 build/extract_glossary.py

Vol 4's PDF has a broken glyph map, so the extractor repairs it: `!`/`"` are the
lost ff/ffi ligatures, and the math symbols are remapped via a table pinned
against passages whose correct form is known. The overloaded arrow glyph means
both "in" and a superscript minus; spacing disambiguates.

## Chrome

`noise` brown noise, synthesized (no audio files) · `dim` inverts the page for
night reading · `lock in` goes fullscreen, so the app covers everything else.
The top bar stays either way — search, exercises, noise and dim are all things
you reach for mid-session.

Keys: `/` or `Ctrl-F` search · `n` noise · `d` dim · `l` lock in · `e` exercises
pane · `←`/`→` pages · `space` opens the next card still collapsed · `Esc` close
popover / search / ask / exit lock in.

## Adding a chapter

1. Write `content/vol<N>-ch<M>.json` (see `vol3-ch1.json` for the shape:
   `sections` with `from`/`to` **printed book** pages, `exercises`, and `cards`).
2. Point the chapter's `file` at it in `content/manifest.json`.
3. `python3 build/extract_exercises.py` — maps each section to its exercise
   group, and `python3 build/extract_glossary.py` — rebuilds clickable terms.

That's it — no code changes. When more of Vol 4 ships, add the chapters and
bump `pageOffset` if the new PDF renumbers. Set `fixLigatures` on a volume whose
PDF drops its ff/ffi ligatures.

Page offsets: Vol 3 pdfPage = bookPage + 6. Vol 4 pdfPage = bookPage.

## State

`~/.locked-in/state.json` — the definitions in your own words, reading position
in both panes, and preferences. Delete it to reset.

`~/.locked-in/config.json` — the API key for `ask ai`, and optional `model` and
`effort`. Not written by the app; create it yourself. Nothing else needs it.

## Logo

`build/icon-*.png`, `build/icon.ico`, `renderer/mark.svg`. The mark is a real
trajectory of x' = Ax with complex eigenvalues and negative real part — a
**spiral sink**. Converging onto a fixed point is what "locked in" means in
dynamical systems, and it's Figure 1.7 of Vol 4 §1.2. Regenerate from the
script in git history; geometry is `r = R·e^(−0.108θ)` over 3.25 turns.

## Debug hooks

    LOCKEDIN_SHOT=/tmp/x.png LOCKEDIN_SHOT_DELAY=9000 LOCKEDIN_SHOT_QUIT=1 npm start

Captures the window once loaded. `LOCKEDIN_EVAL='<js>'` runs JS in the renderer
first, for reaching views that need clicks.

## Per-section exercises

Both volumes collect exercises at the end of a chapter and separate the
per-section groups with horizontal rules. The rules are vector graphics, so
`pdftotext` drops them; `build/extract_exercises.py` finds them in a rendered
page and keeps only the real dividers:

- a **section divider** is followed by an exercise number
- a **running-head rule** is followed by a heading
- a **table or figure edge** has a vertical stroke meeting it at either end

N sections give N+1 rules, which is the check the script prints. All eleven
authored chapters match exactly.

Vol 3 Chapter 0 is the exception that proves the rule: its exercises are
numbered against the chapter (0.1--0.4) rather than against a section, so there
is a single undivided group and no rule at all to find. The script treats that
as the degenerate case and opens the group at the `Exercises` heading.
