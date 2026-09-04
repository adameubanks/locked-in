# LOCKED IN

A study environment for ACME Volumes 3 and 4. The textbook and the study
scaffolding live in one window, so reading and retrieval aren't in separate apps.

Pick a section and you get three modes over it: **Read** (questions through the
text), **Explain** (the book's definitions, which you write in your own words
first), and **Brain rot** (the same concepts at the lowest cognitive load).
Plus full-text search across both volumes and an exercises pane.

## Install

Linux, Node 18+, and your own copies of the two textbook PDFs (see
**Textbooks** below). Electron ships its own runtime, so that is the whole
list. Verified on Node 18.20.3 / npm 10.7.0.

From the project directory:

    npm install

That pulls Electron 32, pdf.js and the Anthropic SDK — about 500 MB, nearly all
of it the Electron binary.

    npm start

`~/.locked-in/` is created on first run. Nothing else is written outside the
repo, and nothing but `ask ai` touches the network.

## Textbooks

The PDFs are not in git. Drop your copies in `textbooks/` at the repo root,
using these names:

    textbooks/V3aFall2026-full_text_with_corrected_ch1.pdf   # Volume 3
    textbooks/Volume 4 Chapters 1-4.pdf                      # Volume 4

`content/manifest.json` points at those files with paths relative to the repo
root. The app resolves them from there, so you do not set an absolute path on
your machine.

    { "id": "vol3", ..., "pdf": "textbooks/V3aFall2026-full_text_with_corrected_ch1.pdf", "pageOffset": 6 }
    { "id": "vol4", ..., "pdf": "textbooks/Volume 4 Chapters 1-4.pdf",                    "pageOffset": 0 }

If you use different filenames, put the files in `textbooks/` anyway and update
the `pdf` fields to match. Get a name wrong and the reader says so in the pane
and names the file it expected.

`pageOffset` is pdfPage minus bookPage. Re-derive it if your scan is numbered
differently by opening to any page with a printed number and subtracting.

## Generating the glossary

`content/glossary.json` is not in the repo. It is the book's own text — every
definition, theorem and lemma lifted from the PDFs — so it stays with whoever
owns the book. Build your own copy:

    sudo apt install poppler-utils
    pip3 install pillow numpy
    python3 build/extract_glossary.py

`extract_glossary.py` reads the PDF paths from the manifest. Page ranges for
the extract live in that script.

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

Optional, and the only part of the app that touches the network. It needs a key:

    ~/.locked-in/config.json     { "apiKey": "sk-ant-…" }

or an exported `ANTHROPIC_API_KEY` before `npm start`. The config file is the
primary path because a `.desktop` launcher inherits no shell environment. The key
is read in the main process and never crosses into the renderer. `config.json`
also takes `model` (default `claude-opus-5`) and `effort` (default `medium`).
