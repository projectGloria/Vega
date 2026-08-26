"use strict";
const electron = require("electron");
function subscribe(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  electron.ipcRenderer.on(channel, listener);
  return () => {
    electron.ipcRenderer.removeListener(channel, listener);
  };
}
const api = {
  window: {
    minimize: () => electron.ipcRenderer.send("window:minimize"),
    toggleMaximize: () => electron.ipcRenderer.send("window:toggle-maximize"),
    close: () => electron.ipcRenderer.send("window:close"),
    onMaximizeChange: (cb) => subscribe("window:maximize-changed", cb)
  },
  bootstrap: {
    onProgress: (cb) => subscribe("bootstrap:progress", cb),
    retry: () => electron.ipcRenderer.send("bootstrap:retry"),
    continueAnyway: () => electron.ipcRenderer.send("bootstrap:continue")
  },
  media: {
    probe: (url) => electron.ipcRenderer.invoke("media:probe", url),
    probeEntry: (url) => electron.ipcRenderer.invoke("media:probe-entry", url)
  },
  queue: {
    add: (requests) => electron.ipcRenderer.invoke("queue:add", requests),
    pause: (id) => electron.ipcRenderer.invoke("queue:pause", id),
    resume: (id) => electron.ipcRenderer.invoke("queue:resume", id),
    cancel: (id) => electron.ipcRenderer.invoke("queue:cancel", id),
    retry: (id) => electron.ipcRenderer.invoke("queue:retry", id),
    remove: (id) => electron.ipcRenderer.invoke("queue:remove", id),
    clearFinished: () => electron.ipcRenderer.invoke("queue:clear-finished"),
    list: () => electron.ipcRenderer.invoke("queue:list"),
    onUpdate: (cb) => subscribe("queue:items", cb),
    onItemProgress: (cb) => subscribe("queue:progress", cb),
    getLog: (id) => electron.ipcRenderer.invoke("queue:log", id)
  },
  settings: {
    get: () => electron.ipcRenderer.invoke("settings:get"),
    set: (patch) => electron.ipcRenderer.invoke("settings:set", patch),
    pickDownloadDir: () => electron.ipcRenderer.invoke("settings:pick-dir"),
    versions: () => electron.ipcRenderer.invoke("settings:versions"),
    updateYtdlp: () => electron.ipcRenderer.invoke("settings:update-ytdlp")
  },
  clipboardInbox: {
    list: () => electron.ipcRenderer.invoke("inbox:list"),
    remove: (id) => electron.ipcRenderer.invoke("inbox:remove", id),
    clear: () => electron.ipcRenderer.invoke("inbox:clear"),
    retry: (id) => electron.ipcRenderer.invoke("inbox:retry", id),
    onUpdate: (cb) => subscribe("inbox:items", cb)
  },
  history: {
    list: () => electron.ipcRenderer.invoke("history:list"),
    remove: (id) => electron.ipcRenderer.invoke("history:remove", id),
    clear: () => electron.ipcRenderer.invoke("history:clear"),
    onUpdate: (cb) => subscribe("history:items", cb),
    fileExists: (path) => electron.ipcRenderer.invoke("history:file-exists", path)
  },
  categories: {
    create: (name) => electron.ipcRenderer.invoke("categories:create", name),
    remove: (id) => electron.ipcRenderer.invoke("categories:remove", id)
  },
  cookies: {
    browsers: () => electron.ipcRenderer.invoke("cookies:browsers"),
    capture: (browser) => electron.ipcRenderer.invoke("cookies:capture", browser),
    clear: () => electron.ipcRenderer.invoke("cookies:clear")
  },
  system: {
    diskSpace: () => electron.ipcRenderer.invoke("system:disk-space"),
    readClipboard: () => electron.ipcRenderer.invoke("system:clipboard"),
    writeClipboard: (text) => electron.ipcRenderer.invoke("system:write-clipboard", text),
    openPath: (path) => electron.ipcRenderer.invoke("system:open-path", path),
    showInFolder: (path) => electron.ipcRenderer.invoke("system:show-in-folder", path),
    openExternal: (url) => electron.ipcRenderer.invoke("system:open-external", url)
  }
};
electron.contextBridge.exposeInMainWorld("api", api);
