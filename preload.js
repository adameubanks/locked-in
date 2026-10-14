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
  onZoom:     (cb)    => ipcRenderer.on("zoom", (_e, d) => cb(d))
});
