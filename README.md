# LOCKED IN

A study environment for a folder of PDFs, built around ACME Volumes 3 and 4.
Every PDF in `books/` is in the library (sidebar: `B`; quick open: `O` or
`Ctrl+P`, or click the title). An ACME volume opens beside its study pane;
anything else reads full width.

For an ACME section you get its question cards, each with alternate registers
&mdash; brain rot, an example, why you'd care, just the math &mdash; and an
exercises pane that follows the section, and `generate` writes more cards for it.
Everywhere: a find bar that draws its
hits on the page (both volumes in ACME, the open PDF otherwise), `ask ai` on a
selection (answered with the whole PDF in view), and `listen`, which reads the body text aloud in a local neural
voice and marks each word on the page as it's spoken (`R`; `[` and `]` step a
sentence). Select text and choose listen to start there.

## Install

Linux, Node 18+, and your own copies of the two textbook PDFs. Electron ships
its own runtime, so that is the whole list. Verified on Node 18.20.3 / npm
10.7.0.

From the project directory:

    npm install

That pulls Electron 32, pdf.js, kokoro-js (the voice) and Google's Gen AI SDK —
about 700 MB, most of it the Electron binary and the ONNX runtime.

Then put the books in `books/` (gitignored — they're copyrighted). The paths in
`content/manifest.json` are relative to the repo:

    { "id": "vol3", ..., "pdf": "books/Vol3.pdf",        "pageOffset": 6 }
    { "id": "vol4", ..., "pdf": "books/Vol4_Ch1-4.pdf",  "pageOffset": 0 }

Get one wrong and the reader says so in the pane and names the file it expected.
`pageOffset` is pdfPage minus bookPage — re-derive it if your scan is numbered
differently by opening to any page with a printed number and subtracting.

    npm start

`~/.locked-in/` is created on first run. Nothing else is written outside the
repo. The network is touched by `ask ai` and `generate`, and once by `listen`: the first time
it runs it downloads the Kokoro voice model (~330 MB) from Hugging Face into
`node_modules/`, and speaks offline from then on.

## Launcher

    cp build/locked-in.desktop ~/.local/share/applications/

Linux only. It hardcodes the repo location in `Exec`, `Path` and `Icon`, so edit
those three lines if it doesn't live in `~/Projects/locked-in`.

## If the window comes up blank

    LOCKEDIN_NOGPU=1 npm start

Disables hardware acceleration, which some GPU and driver combinations need.

## Ask ai and generated cards

Optional. Both run on Gemini, which gets the whole PDF rather than an extract of
it, so it reads the mathematics as typeset and can point you elsewhere in the
book. The free tier of the Gemini API is enough; get a key at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey) (a Google One
or student plan doesn't change the API's limits either way) and put it in

    ~/.locked-in/config.json     { "geminiKey": "…" }

or export `GEMINI_API_KEY` before `npm start`. The config file is the primary
path because a `.desktop` launcher inherits no shell environment. The key is
read in the main process and never crosses into the renderer.

Each PDF is uploaded once and kept for 48 hours by Google; the upload's address
is remembered in `~/.locked-in/gemini-files.json`. On the free tier Google may
use what you send to improve its models, so don't ask about anything you
wouldn't share. `config.json` also takes `model` (default `gemini-2.5-flash`).

Generated cards are stored in `~/.locked-in/state.json`, tagged in the deck, and
never touch the authored decks in `content/`. Gemini is told not to work the
book's exercises, in cards or in answers.
