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

ipcMain.handle("fullscreen", (_e, on) => {
  if (!win) return false;
  win.setFullScreen(!!on);
  return win.isFullScreen();
});
