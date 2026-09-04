const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Headless X11 here has a flaky GPU process; the capture harness turns it off.
if (process.env.LOCKEDIN_NOGPU) app.disableHardwareAcceleration();

const STORE_DIR = path.join(os.homedir(), ".locked-in");
const STATE_FILE = path.join(STORE_DIR, "state.json");
const CONTENT_DIR = path.join(__dirname, "content");

function resolvePdfPath(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.join(__dirname, p);
}

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
  try {
    const abs = resolvePdfPath(p);
    return fs.existsSync(abs) && fs.statSync(abs).size > 0;
  } catch (e) { return false; }
});

ipcMain.handle("pdf:read", (_e, p) => {
  // Electron blocks file:// XHR from a file:// page, so the bytes come over IPC.
  const buf = fs.readFileSync(resolvePdfPath(p));
  return new Uint8Array(buf).buffer;
});

ipcMain.handle("title", (_e, t) => {
  if (win) win.setTitle(t);
  return true;
});

/* ---------------- ask ai ----------------
   The key lives in the main process only; the renderer never sees it, and the
   page CSP still blocks every outbound request from the renderer. */

const CONFIG_FILE = path.join(STORE_DIR, "config.json");

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch (e) { return {}; }
}

let sdk = null, askStream = null;

function haveExplicitKey() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || readConfig().apiKey);
}

function anthropic() {
  if (sdk) return sdk;
  const Anthropic = require("@anthropic-ai/sdk");
  // A .desktop launcher inherits no shell environment, so config.json is the
  // primary path here and an exported key is the override.
  const apiKey = process.env.ANTHROPIC_API_KEY || readConfig().apiKey;
  sdk = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  return sdk;
}

function askError(e) {
  const A = require("@anthropic-ai/sdk");
  if (e instanceof A.AuthenticationError) return "no-key";
  if (e instanceof A.RateLimitError) return "Rate limited — give it a moment and ask again.";
  if (e instanceof A.APIConnectionError) return "Can't reach the API. Check your connection.";
  if (e instanceof A.APIError) return "API error " + e.status + ": " + e.message;
  // Not an API error: the client constructs fine with no credentials and only
  // fails later, while resolving them — before any request leaves the machine.
  if (!haveExplicitKey()) return "no-key";
  return (e && e.message) || String(e);
}

const ASK_SYSTEM = `You are helping a senior undergraduate in BYU's ACME program (Applied and Computational Mathematics) read their textbook: ACME Volume 3, Uncertainty and Data, and Volume 4, Dynamic Modeling.

They select a passage and ask about it. You receive the passage and the full text of the page it came from, both extracted from the PDF. The extraction is imperfect — mathematical notation especially arrives mangled, and Volume 4's font loses some symbols entirely. Read symbols charitably from context, and say plainly when a formula is genuinely unreadable rather than guessing at it.

Explain concepts. Lead with the one-sentence version, then the substance. Use the book's own notation and terminology. When the passage is a definition or theorem, the hypotheses are usually the interesting part — say what they rule out and why it is stated that way.

Hard constraint: this student's program forbids AI-produced coursework. Do not solve textbook exercises, do not write their code, and do not produce a worked answer to a numbered problem, even when asked directly and even when the problem looks trivial. If they ask for that, say so in one sentence, then explain the concept the problem is testing or ask what they have already tried. Explaining ideas, checking their understanding, and helping them name their own confusion are all fine and are the point of this tool.

Be direct and reasonably brief — this is a study aid, not a lecture. No preamble, no restating the question. Plain prose; write mathematics in words or unicode ("the integral of f from a to b", "‖x‖ ≤ L") rather than LaTeX, since the display has no math renderer.`;

ipcMain.handle("ask", async (_e, req) => {
  if (askStream) { try { askStream.abort(); } catch (e) {} askStream = null; }
  const cfg = readConfig();
  try {
    const stream = anthropic().messages.stream({
      model: cfg.model || "claude-opus-5",
      max_tokens: 32000,
      system: ASK_SYSTEM,
      thinking: { type: "adaptive" },
      output_config: { effort: cfg.effort || "medium" },
      messages: req.messages
    });
    askStream = stream;
    stream.on("text", (t) => { if (win && !win.isDestroyed()) win.webContents.send("ask:delta", t); });
    const final = await stream.finalMessage();
    askStream = null;
    if (final.stop_reason === "refusal") {
      const d = final.stop_details || {};
      return { refusal: d.explanation || "The request was declined." };
    }
    return { ok: true, usage: final.usage };
  } catch (e) {
    askStream = null;
    if (e && e.name === "APIUserAbortError") return { aborted: true };
    const msg = askError(e);
    // Drop the memoised client so adding a key means asking again, not
    // restarting the app.
    if (msg === "no-key") sdk = null;
    return { error: msg };
  }
});

ipcMain.handle("ask:cancel", () => {
  if (askStream) { try { askStream.abort(); } catch (e) {} askStream = null; }
  return true;
});


ipcMain.handle("fullscreen", (_e, on) => {
  if (!win) return false;
  win.setFullScreen(!!on);
  return win.isFullScreen();
});
