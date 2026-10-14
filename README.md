# LOCKED IN

A study environment for a folder of PDFs, built around ACME Volumes 3 and 4.
Every PDF in `books/` is in the library (sidebar: `B`; quick open: `O` or
`Ctrl+P`, or click the title). An ACME volume opens beside its study pane;
anything else reads full width.

For an ACME section you get its question cards, each with alternate registers
&mdash; brain rot, an example, why you'd care, just the math &mdash; and an
exercises pane that follows the section.
Everywhere: a find bar that draws its
hits on the page (both volumes in ACME, the open PDF otherwise), and `listen`, which reads the body text aloud in a local neural
voice and marks each word on the page as it's spoken (`R`; `[` and `]` step a
sentence). Select text and choose listen to start there.

## Install

Linux, Node 18+, and your own copies of the two textbook PDFs. Electron ships
its own runtime, so that is the whole list. Verified on Node 18.20.3 / npm
10.7.0.

From the project directory:

    npm install

That pulls Electron 32, pdf.js and kokoro-js (the voice) — about 700 MB, most of it the Electron binary and the ONNX runtime.

Then put the books in `books/` (gitignored — they're copyrighted). The paths in
`content/manifest.json` are relative to the repo:

    { "id": "vol3", ..., "pdf": "books/Vol3.pdf",        "pageOffset": 6 }
    { "id": "vol4", ..., "pdf": "books/Vol4_Ch1-4.pdf",  "pageOffset": 0 }

Get one wrong and the reader says so in the pane and names the file it expected.
`pageOffset` is pdfPage minus bookPage — re-derive it if your scan is numbered
differently by opening to any page with a printed number and subtracting.

    npm start

`~/.locked-in/` is created on first run. Nothing else is written outside the
repo. The network is touched once, by `listen`: the first time
it runs it downloads the Kokoro voice model (~330 MB) from Hugging Face into
`node_modules/`, and speaks offline from then on.

## Launcher

    cp build/locked-in.desktop ~/.local/share/applications/

Linux only. It hardcodes the repo location in `Exec`, `Path` and `Icon`, so edit
those three lines if it doesn't live in `~/Projects/locked-in`.

## If the window comes up blank

    LOCKEDIN_NOGPU=1 npm start

Disables hardware acceleration, which some GPU and driver combinations need.
