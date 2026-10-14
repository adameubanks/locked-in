const { app, BrowserWindow, ipcMain, utilityProcess } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Headless X11 here has a flaky GPU process; the capture harness turns it off.
if (process.env.LOCKEDIN_NOGPU) app.disableHardwareAcceleration();

const STORE_DIR = path.join(os.homedir(), ".locked-in");
const STATE_FILE = path.join(STORE_DIR, "state.json");
const CONTENT_DIR = path.join(__dirname, "content");

let win = null;

function ensureStore() {
  try { fs.mkdirSync(STORE_DIR, { recursive: true }); } catch (e) {}
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0B0D12",
    title: "LOCKED IN",
    icon: path.join(__dirname, "build", "icon-512.png"),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.webContents.on("console-message", (_e, level, msg, line, src) => {
    if (level >= 2) console.log(`[renderer] ${msg}  (${src}:${line})`);
  });
  // Chromium's page zoom leaves unpainted tiles over the canvases; route it to the reader's zoom.
  const zoom = (d) => { win.webContents.setZoomFactor(1); win.webContents.send("zoom", d); };
  win.webContents.on("before-input-event", (e, i) => {
    const d = { "-": -1, "_": -1, "=": 1, "+": 1, "0": 0 }[i.key];
    if (i.type === "keyDown" && (i.control || i.meta) && d !== undefined) { e.preventDefault(); zoom(d); }
  });
  win.webContents.on("zoom-changed", (_e, dir) => zoom(dir === "in" ? 1 : -1));
  win.webContents.on("did-finish-load", () => win.webContents.setZoomFactor(1));
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());

  // Debug affordance: LOCKEDIN_SHOT=/path/to.png captures the window once loaded.
  if (process.env.LOCKEDIN_SHOT) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          if (process.env.LOCKEDIN_EVAL) {
            await win.webContents.executeJavaScript(process.env.LOCKEDIN_EVAL);
            await new Promise(r => setTimeout(r, 900));
          }
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.LOCKEDIN_SHOT, img.toPNG());
          console.log("SHOT_OK " + process.env.LOCKEDIN_SHOT);
        } catch (e) { console.log("SHOT_FAIL " + e.message); }
        if (process.env.LOCKEDIN_SHOT_QUIT) app.quit();
      }, parseInt(process.env.LOCKEDIN_SHOT_DELAY || "6000", 10));
    });
  }
  // The renderer owns the title: it reports the chapter/section you are in.
  win.on("page-title-updated", (e) => e.preventDefault());
}

app.whenReady().then(() => {
  ensureStore();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/* ---------------- IPC ---------------- */

ipcMain.handle("manifest", () => {
  const p = path.join(CONTENT_DIR, "manifest.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
});

ipcMain.handle("chapter", (_e, file) => {
  // file comes from the manifest, never from user input
  const safe = path.basename(String(file));
  const p = path.join(CONTENT_DIR, safe);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
});

ipcMain.handle("state:get", () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    return null;
  }
});

ipcMain.handle("state:set", (_e, data) => {
  ensureStore();
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, STATE_FILE); // atomic-ish: never leave a half-written state
  return true;
});

ipcMain.handle("pdf:check", (_e, p) => {
  p = path.resolve(__dirname, p);
  try { return fs.existsSync(p) && fs.statSync(p).size > 0; } catch (e) { return false; }
});

ipcMain.handle("pdf:read", (_e, p) => {
  // Electron blocks file:// XHR from a file:// page, so the bytes come over IPC.
  const buf = fs.readFileSync(path.resolve(__dirname, p));
  return new Uint8Array(buf).buffer;
});

// Every PDF under books/, as repo-relative paths like the manifest's.
ipcMain.handle("library", () => {
  try {
    return fs.readdirSync(path.join(__dirname, "books"), { recursive: true })
      .filter(f => /\.pdf$/i.test(f)).map(f => "books/" + f.split(path.sep).join("/")).sort();
  } catch (e) { return []; }
});

/* ---------------- listen ----------------
   Kokoro, an open neural voice, run here on the CPU. The model (~330 MB)
   comes from Hugging Face on first use and is cached under node_modules;
   after that it runs offline, in its own process so the window never waits
   on it. The renderer asks for one sentence at a time. */
let ttsP = null, ttsN = 0;
const ttsWait = new Map();
function tts(words, voice, speed) {
  if (!ttsP) {
    ttsP = utilityProcess.fork(path.join(__dirname, "tts.js"));
    ttsP.on("message", ({ id, ok, err }) => { const [res, rej] = ttsWait.get(id); ttsWait.delete(id); err ? rej(new Error(err)) : res(ok); });
    ttsP.on("exit", () => { ttsWait.forEach(([, rej]) => rej(new Error("The voice process stopped."))); ttsWait.clear(); ttsP = null; });
  }
  return new Promise((res, rej) => { ttsWait.set(++ttsN, [res, rej]); ttsP.postMessage({ id: ttsN, words, voice, speed }); });
}
ipcMain.handle("tts:voices", () => tts());
ipcMain.handle("tts", (_e, words, voice, speed) => tts(words.map(String), voice, +speed || 1));

ipcMain.handle("title", (_e, t) => {
  if (win) win.setTitle(t);
  return true;
});

/* ---------------- ask ai, generate cards ----------------
   Gemini, handed the whole PDF rather than an extract of it: it reads the pages
   as pages, so the mathematics arrives intact and an answer can draw on the rest
   of the book. The Files API keeps an upload for 48 hours; the URI is remembered
   per file, so a PDF goes up once every two days, not once per question. The key
   lives in the main process only; the renderer never sees it, and the page CSP
   still blocks every outbound request from the renderer. */

const CONFIG_FILE = path.join(STORE_DIR, "config.json");
const FILES_FILE = path.join(STORE_DIR, "gemini-files.json");

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch (e) { return {}; }
}

// A .desktop launcher inherits no shell environment, so config.json is the
// primary path and an exported key is the override.
function apiKey() {
  return process.env.GEMINI_API_KEY || readConfig().geminiKey || null;
}

let ai = null, aiKey = null, askCtl = null;
function gemini() {
  const key = apiKey();
  if (!key) return null;
  if (key !== aiKey) { const { GoogleGenAI } = require("@google/genai"); ai = new GoogleGenAI({ apiKey: key }); aiKey = key; }
  return ai;
}
const model = () => readConfig().model || "gemini-2.5-flash";

async function pdfPart(rel, onUpload) {
  const p = path.resolve(__dirname, rel), st = fs.statSync(p), id = `${p}:${st.size}:${st.mtimeMs}`;
  let known = {};
  try { known = JSON.parse(fs.readFileSync(FILES_FILE, "utf8")); } catch (e) {}
  if (!(known[id] && known[id].expires > Date.now() + 3600e3)) {
    if (onUpload) onUpload();
    let f = await gemini().files.upload({ file: p, config: { mimeType: "application/pdf" } });
    while (f.state === "PROCESSING") { await new Promise(r => setTimeout(r, 2000)); f = await gemini().files.get({ name: f.name }); }
    if (f.state === "FAILED") throw new Error("Gemini couldn't read this PDF.");
    known[id] = { uri: f.uri, expires: Date.parse(f.expirationTime) || Date.now() + 47 * 3600e3 };
    fs.writeFileSync(FILES_FILE, JSON.stringify(known, null, 1));
  }
  return { fileData: { fileUri: known[id].uri, mimeType: "application/pdf" } };
}

function aiError(e) {
  const m = (e && e.message) || String(e);
  if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(m)) return "no-key";
  if (e && e.status === 429) return "Gemini's free-tier limit is used up for now — wait a minute, or until tomorrow for the daily cap.";
  if (/fetch failed|ENOTFOUND|ECONNRESET/i.test(m)) return "Can't reach Gemini. Check your connection.";
  return m;
}

const ASK_SYSTEM = `You are helping a senior undergraduate in BYU's ACME program (Applied and Computational Mathematics) read their textbook: ACME Volume 3, Uncertainty and Data, and Volume 4, Dynamic Modeling.

The volume they are reading is attached as a PDF. They select a passage and ask about it; the passage and its page come with the question. Answer from the book: tie the passage to where its ideas are set up and where they are used, and cite printed page numbers ("p. 112") when you point elsewhere.

Explain concepts. Lead with the one-sentence version, then the substance. Use the book's own notation and terminology. When the passage is a definition or theorem, the hypotheses are usually the interesting part — say what they rule out and why it is stated that way.

Hard constraint: this student's program forbids AI-produced coursework. Do not solve textbook exercises, do not write their code, and do not produce a worked answer to a numbered problem, even when asked directly and even when the problem looks trivial. If they ask for that, say so in one sentence, then explain the concept the problem is testing or ask what they have already tried. Explaining ideas, checking their understanding, and helping them name their own confusion are all fine and are the point of this tool.

Be direct and reasonably brief — this is a study aid, not a lecture. No preamble, no restating the question. Plain prose; write mathematics in words or unicode ("the integral of f from a to b", "‖x‖ ≤ L") rather than LaTeX, since the display has no math renderer.`;

// The same tutor for any other PDF in the library: a paper, notes, another book.
const ASK_ANY = ASK_SYSTEM
  .replace(/^[\s\S]*?(?=The volume they are reading)/, "You are helping a senior undergraduate in BYU's ACME program (Applied and Computational Mathematics) read a PDF from their library — a paper, lecture notes, or a book.\n\n")
  .replace("The volume they are reading", "The document")
  .replace("Answer from the book", "Answer from the document")
  .replace("the book's own notation", "the document's own notation")
  .replace("textbook exercises", "exercises or homework problems");

ipcMain.handle("ask", async (_e, req) => {
  if (askCtl) askCtl.abort();
  if (!gemini()) return { error: "no-key" };
  const ctl = askCtl = new AbortController();
  const send = (ch, t) => { if (win && !win.isDestroyed()) win.webContents.send(ch, t); };
  try {
    const file = await pdfPart(req.pdf, () => send("ask:think", "Uploading the PDF to Gemini — once every two days. "));
    const contents = req.messages.map((m, i) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: i === 0 ? [file, { text: m.content }] : [{ text: m.content }]
    }));
    const stream = await gemini().models.generateContentStream({
      model: model(), contents,
      config: { systemInstruction: req.acme ? ASK_SYSTEM : ASK_ANY, thinkingConfig: { includeThoughts: true }, abortSignal: ctl.signal }
    });
    let said = false, why = null;
    for await (const ch of stream) {
      const c = ch.candidates && ch.candidates[0];
      if (!c) continue;
      if (c.finishReason && c.finishReason !== "STOP") why = c.finishReason;
      // The model reasons before it answers; the renderer shows that so the
      // wait doesn't look like a hang.
      for (const part of (c.content && c.content.parts) || []) {
        if (!part.text) continue;
        send(part.thought ? "ask:think" : "ask:delta", part.text);
        if (!part.thought) said = true;
      }
    }
    if (!said && why) return { refusal: "Gemini stopped without answering (" + why + ")." };
    return { ok: true };
  } catch (e) {
    if (ctl.signal.aborted) return { aborted: true };
    return { error: aiError(e) };
  } finally {
    if (askCtl === ctl) askCtl = null;
  }
});

ipcMain.handle("ask:cancel", () => {
  if (askCtl) askCtl.abort();
  return true;
});

const CARDS_SYSTEM = `You write retrieval-practice cards for a senior undergraduate in BYU's ACME program, from the attached PDF.

A card is a question that forces recall or reasoning about the section — why a hypothesis is there, what breaks without it, how two ideas connect, what a result buys you — not a definition lookup. The answer is a few sentences that settle it, grounded in the book's own notation.

Write HTML, not Markdown or LaTeX: <b>, <i>, <sub>, <sup>, <br>, <p>, and <div class='eq'>…</div> for a displayed formula; mathematics in unicode or HTML entities. Each card also carries four alternate registers of the answer: rot (casual, lowercase, the lowest-effort way to get it), ex (one concrete instance, worked), why (what it buys you, why anyone cares), math (just the mathematics, stripped of prose). page is the printed page the card is about.

Never write a card that solves, or walks through, one of the book's numbered exercises.`;

const { Type } = require("@google/genai");
const CARD_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT, required: ["q", "a", "page", "r"],
    properties: {
      q: { type: Type.STRING }, a: { type: Type.STRING }, page: { type: Type.INTEGER },
      r: { type: Type.OBJECT, required: ["rot", "ex", "why", "math"],
           properties: { rot: { type: Type.STRING }, ex: { type: Type.STRING }, why: { type: Type.STRING }, math: { type: Type.STRING } } }
    }
  }
};

ipcMain.handle("cards", async (_e, req) => {
  if (!gemini()) return { error: "no-key" };
  const prompt = `Write ${req.n} new cards for §${req.sec} of ${req.title}: printed pages ${req.from}–${req.to}, which are PDF pages ${req.from + req.off}–${req.to + req.off}.\n\n` +
    (req.examples.length ? `Match the style of these existing cards:\n${JSON.stringify(req.examples)}\n\n` : "") +
    (req.have.length ? `Don't repeat what these already ask:\n${req.have.map(q => "- " + q).join("\n")}` : "");
  try {
    const r = await gemini().models.generateContent({
      model: model(),
      contents: [{ role: "user", parts: [await pdfPart(req.pdf), { text: prompt }] }],
      config: { systemInstruction: CARDS_SYSTEM, responseMimeType: "application/json", responseSchema: CARD_SCHEMA }
    });
    return { cards: JSON.parse(r.text) };
  } catch (e) {
    return { error: aiError(e) };
  }
});

ipcMain.handle("fullscreen", (_e, on) => {
  if (!win) return false;
  win.setFullScreen(!!on);
  return win.isFullScreen();
});
