const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  manifest:   ()      => ipcRenderer.invoke("manifest"),
  chapter:    (f)     => ipcRenderer.invoke("chapter", f),
  getState:   ()      => ipcRenderer.invoke("state:get"),
  setState:   (d)     => ipcRenderer.invoke("state:set", d),
  pdfCheck:   (p)     => ipcRenderer.invoke("pdf:check", p),
  pdfRead:    (p)     => ipcRenderer.invoke("pdf:read", p),
  setTitle:   (t)     => ipcRenderer.invoke("title", t),
  fullscreen: (on)    => ipcRenderer.invoke("fullscreen", on),
  ask:        (req)   => ipcRenderer.invoke("ask", req),
  askCancel:  ()      => ipcRenderer.invoke("ask:cancel"),
  onAskDelta: (cb)    => ipcRenderer.on("ask:delta", (_e, t) => cb(t)),
  onAskThink: (cb)    => ipcRenderer.on("ask:think", (_e, t) => cb(t))
});
