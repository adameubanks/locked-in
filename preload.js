const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  manifest:   ()      => ipcRenderer.invoke("manifest"),
  chapter:    (f)     => ipcRenderer.invoke("chapter", f),
  getState:   ()      => ipcRenderer.invoke("state:get"),
  setState:   (d)     => ipcRenderer.invoke("state:set", d),
  pdfCheck:   (p)     => ipcRenderer.invoke("pdf:check", p),
  pdfRead:    (p)     => ipcRenderer.invoke("pdf:read", p),
  library:    ()      => ipcRenderer.invoke("library"),
  tts:        (t, v, s) => ipcRenderer.invoke("tts", t, v, s),
  voices:     ()      => ipcRenderer.invoke("tts:voices"),
  setTitle:   (t)     => ipcRenderer.invoke("title", t),
  fullscreen: (on)    => ipcRenderer.invoke("fullscreen", on),
  ask:        (req)   => ipcRenderer.invoke("ask", req),
  cards:      (req)   => ipcRenderer.invoke("cards", req),
  askCancel:  ()      => ipcRenderer.invoke("ask:cancel"),
  onAskDelta: (cb)    => ipcRenderer.on("ask:delta", (_e, t) => cb(t)),
  onAskThink: (cb)    => ipcRenderer.on("ask:think", (_e, t) => cb(t)),
  onZoom:     (cb)    => ipcRenderer.on("zoom", (_e, d) => cb(d))
});
