# LOCKED IN

A study environment for ACME Volumes 3 and 4. The textbook and the study
scaffolding live in one window, so reading and retrieval aren't in separate apps.

Pick a section and you get two modes over it: **Read** (questions through the
text) and **Explain** (the book's definitions, which you write in your own words
first). Every revealed answer also carries alternate registers &mdash; brain rot,
an example, why you'd care, just the math. Plus a find bar over both volumes
that steps through the hits and draws them on the page, and an exercises pane.

## Install

Linux, Node 18+, and your own copies of the two textbook PDFs. Electron ships
its own runtime, so that is the whole list. Verified on Node 18.20.3 / npm
10.7.0.

From the project directory:

    npm install

That pulls Electron 32, pdf.js and the Anthropic SDK — about 500 MB, nearly all
of it the Electron binary. The Anthropic SDK is the client for `ask ai`, which
talks to DeepSeek over its Anthropic-compatible endpoint; no Anthropic account
is involved.

Then point the app at the books. Each volume in `content/manifest.json` carries
an absolute path and a page offset, and those paths are the only thing you have
to change:

    { "id": "vol3", ..., "pdf": ".../Vol3.pdf",        "pageOffset": 6 }
    { "id": "vol4", ..., "pdf": ".../Vol4_Ch1-4.pdf",  "pageOffset": 0 }

Get one wrong and the reader says so in the pane and names the file it expected.
`pageOffset` is pdfPage minus bookPage — re-derive it if your scan is numbered
differently by opening to any page with a printed number and subtracting.

    npm start

`~/.locked-in/` is created on first run. Nothing else is written outside the
repo, and nothing but `ask ai` touches the network.

## Generating the glossary

`content/glossary.json` is not in the repo. It is the book's own text — every
definition, theorem and lemma lifted from the PDFs — so it stays with whoever
owns the book. Build your own copy:

    sudo apt install poppler-utils
    pip3 install pillow numpy
    python3 build/extract_glossary.py

`extract_glossary.py` keeps its own `BOOKS` list at the top of the file, with
the same two absolute paths as the manifest — point those at your PDFs as well.

Until you run it, Explain mode and the hover/click definitions come up empty.
Reading, the cards, the exercises pane and search all work without it. Re-run it
whenever a new chapter ships.

## Launcher

    cp build/locked-in.desktop ~/.local/share/applications/

Linux only. It hardcodes the repo location in `Exec`, `Path` and `Icon`, so edit
those three lines if it doesn't live in `~/Projects/locked-in`.

## If the window comes up blank

    LOCKEDIN_NOGPU=1 npm start

Disables hardware acceleration, which some GPU and driver combinations need.

## Ask ai

Optional, and the only part of the app that touches the network. It runs on
DeepSeek, through the Anthropic-compatible endpoint at
`https://api.deepseek.com/anthropic`, so it needs a DeepSeek key:

    ~/.locked-in/config.json     { "apiKey": "sk-…" }

or an exported `DEEPSEEK_API_KEY` before `npm start`. The config file is the
primary path because a `.desktop` launcher inherits no shell environment. The key
is read in the main process and never crosses into the renderer, and it is the
only key consulted — an exported `ANTHROPIC_API_KEY` is ignored rather than sent
to DeepSeek.

`config.json` also takes `model` (default `deepseek-v4-pro`; `deepseek-v4-flash`
is the cheaper one), `effort` (default `medium`), `maxTokens` (default 32000) and
`thinking` (set it to `false` to send no reasoning parameter at all).
