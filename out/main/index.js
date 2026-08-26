"use strict";
const electron = require("electron");
const node_path = require("node:path");
const node_fs = require("node:fs");
const promises = require("node:fs/promises");
const node_stream = require("node:stream");
const promises$1 = require("node:stream/promises");
const yauzl = require("yauzl");
const node_child_process = require("node:child_process");
const node_crypto = require("node:crypto");
const node_os = require("node:os");
let cached = null;
function getPaths() {
  if (cached) return cached;
  const root = electron.app.getPath("userData");
  const bin = node_path.join(root, "bin");
  cached = {
    root,
    bin,
    cache: node_path.join(root, "cache"),
    logs: node_path.join(root, "logs"),
    ytdlpCache: node_path.join(root, "cache", "yt-dlp"),
    settingsFile: node_path.join(root, "settings.json"),
    queueFile: node_path.join(root, "queue.json"),
    historyFile: node_path.join(root, "history.json"),
    clipboardFile: node_path.join(root, "clipboard.json"),
    cookiesFile: node_path.join(root, "cookies.txt"),
    ytdlpExe: node_path.join(bin, "yt-dlp.exe"),
    ffmpegExe: node_path.join(bin, "ffmpeg.exe"),
    ffprobeExe: node_path.join(bin, "ffprobe.exe"),
    defaultDownloadDir: node_path.join(electron.app.getPath("downloads"), "VideoDownloader")
  };
  return cached;
}
function ensureDirs() {
  const p = getPaths();
  for (const dir of [p.root, p.bin, p.cache, p.logs, p.ytdlpCache]) {
    node_fs.mkdirSync(dir, { recursive: true });
  }
  return p;
}
const YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const FFMPEG_URLS = [
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
  "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
];
const MIN_YTDLP_BYTES = 2e6;
const MIN_ZIP_BYTES = 1e7;
async function downloadToFile(url, destPath, minBytes, onProgress, signal) {
  const partPath = destPath + ".part";
  await promises.mkdir(node_path.dirname(destPath), { recursive: true });
  await promises.rm(partPath, { force: true });
  const res = await fetch(url, {
    signal,
    redirect: "follow",
    headers: { "User-Agent": "VideoDownloader" }
  });
  if (!res.ok || !res.body) {
    throw new Error("HTTP " + res.status + " " + res.statusText + " for " + url);
  }
  const lengthHeader = res.headers.get("content-length");
  const totalBytes = lengthHeader ? Number(lengthHeader) : null;
  let receivedBytes = 0;
  const file = node_fs.createWriteStream(partPath);
  const counter = new node_stream.Writable({
    write(chunk, _enc, cb) {
      receivedBytes += chunk.length;
      onProgress({
        receivedBytes,
        totalBytes,
        percent: totalBytes ? Math.min(100, receivedBytes / totalBytes * 100) : null
      });
      file.write(chunk, () => cb());
    },
    final(cb) {
      file.end(() => cb());
    }
  });
  try {
    await promises$1.pipeline(res.body, counter);
  } catch (err) {
    await promises.rm(partPath, { force: true }).catch(() => {
    });
    throw err;
  }
  const written = await promises.stat(partPath);
  if (written.size < minBytes) {
    await promises.rm(partPath, { force: true });
    throw new Error(
      "Downloaded file is only " + written.size + " bytes, expected at least " + minBytes + ". The source may have returned an error page."
    );
  }
  await promises.rm(destPath, { force: true });
  await promises.rename(partPath, destPath);
}
async function downloadYtdlp(destPath, onProgress, signal) {
  await downloadToFile(YTDLP_URL, destPath, MIN_YTDLP_BYTES, onProgress, signal);
  await promises.chmod(destPath, 493).catch(() => {
  });
}
function extractBinariesFromZip(zipPath, targets, onProgress) {
  const wanted = Object.keys(targets);
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        reject(openErr ?? new Error("Could not open archive"));
        return;
      }
      const found = /* @__PURE__ */ new Set();
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        zipfile.close();
        reject(err);
      };
      zipfile.on("entry", (entry) => {
        const name = entry.fileName.replace(/\\/g, "/").toLowerCase();
        const match = wanted.find((w) => name.endsWith("/bin/" + w));
        if (!match || found.has(match)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            fail(streamErr ?? new Error("Read failed"));
            return;
          }
          const dest = targets[match];
          const partPath = dest + ".part";
          const run2 = async () => {
            await promises.mkdir(node_path.dirname(dest), { recursive: true });
            await promises$1.pipeline(readStream, node_fs.createWriteStream(partPath));
            await promises.rm(dest, { force: true });
            await promises.rename(partPath, dest);
            await promises.chmod(dest, 493).catch(() => {
            });
          };
          run2().then(
            () => {
              if (settled) return;
              found.add(match);
              onProgress(found.size, wanted.length);
              if (found.size === wanted.length) {
                settled = true;
                zipfile.close();
                resolve();
                return;
              }
              zipfile.readEntry();
            },
            (err) => {
              promises.rm(partPath, { force: true }).catch(() => {
              });
              fail(err);
            }
          );
        });
      });
      zipfile.on("end", () => {
        if (settled) return;
        settled = true;
        const missing = wanted.filter((w) => !found.has(w));
        reject(new Error("Archive did not contain: " + missing.join(", ")));
      });
      zipfile.on("error", fail);
      zipfile.readEntry();
    });
  });
}
async function downloadFfmpeg(binDir, cacheDir, onProgress, signal) {
  const zipPath = node_path.join(cacheDir, "ffmpeg-build.zip");
  let lastError = null;
  for (const url of FFMPEG_URLS) {
    try {
      await downloadToFile(
        url,
        zipPath,
        MIN_ZIP_BYTES,
        (p) => onProgress({ phase: "download", ...p }),
        signal
      );
      onProgress({ phase: "extract", receivedBytes: 0, totalBytes: 2, percent: 0 });
      await extractBinariesFromZip(
        zipPath,
        {
          "ffmpeg.exe": node_path.join(binDir, "ffmpeg.exe"),
          "ffprobe.exe": node_path.join(binDir, "ffprobe.exe")
        },
        (extracted, total) => onProgress({
          phase: "extract",
          receivedBytes: extracted,
          totalBytes: total,
          percent: extracted / total * 100
        })
      );
      await promises.rm(zipPath, { force: true });
      return;
    } catch (err) {
      lastError = err;
      await promises.rm(zipPath, { force: true }).catch(() => {
      });
      if (signal?.aborted) throw err;
    }
  }
  throw new Error("Could not obtain ffmpeg: " + (lastError?.message ?? "unknown error"));
}
function run$1(exe, args, timeoutMs = 9e4) {
  return new Promise((resolve, reject) => {
    node_child_process.execFile(
      exe,
      args,
      { timeout: timeoutMs, windowsHide: true, shell: false },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(err.message + (stderr ? "\n" + stderr.slice(0, 400) : "")));
          return;
        }
        resolve(stdout.toString().trim());
      }
    );
  });
}
async function fileExists(path) {
  try {
    await promises.access(path, promises.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
async function probeYtdlp(exe) {
  return run$1(exe, ["--version"]);
}
async function probeFfmpeg(exe) {
  const out = await run$1(exe, ["-version"]);
  const first = out.split("\n")[0] ?? "";
  const match = first.match(/ffmpeg version (\S+)/);
  return match ? match[1] : first.slice(0, 60);
}
const CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1e3;
const CACHE_MAX_BYTES = 200 * 1024 * 1024;
async function pruneCache(cacheDir) {
  let reclaimed = 0;
  const now = Date.now();
  let entries;
  try {
    entries = await promises.readdir(cacheDir);
  } catch {
    return 0;
  }
  const files = [];
  for (const name of entries) {
    const path = node_path.join(cacheDir, name);
    try {
      const s = await promises.stat(path);
      if (!s.isFile()) continue;
      if (now - s.mtimeMs > CACHE_MAX_AGE_MS) {
        await promises.rm(path, { force: true });
        reclaimed += s.size;
      } else {
        files.push({ path, size: s.size, mtime: s.mtimeMs });
      }
    } catch {
    }
  }
  let total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= CACHE_MAX_BYTES) return reclaimed;
  files.sort((a, b) => a.mtime - b.mtime);
  for (const f of files) {
    if (total <= CACHE_MAX_BYTES) break;
    try {
      await promises.rm(f.path, { force: true });
      total -= f.size;
      reclaimed += f.size;
    } catch {
    }
  }
  return reclaimed;
}
async function clearStaleParts(dir) {
  try {
    const entries = await promises.readdir(dir);
    await Promise.all(
      entries.filter((n) => n.endsWith(".part")).map((n) => promises.rm(node_path.join(dir, n), { force: true }).catch(() => {
      }))
    );
  } catch {
  }
}
async function writeJsonAtomic(path, value) {
  await promises.mkdir(node_path.dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await promises.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await promises.rename(tmp, path);
}
async function readJson(path) {
  try {
    return JSON.parse(await promises.readFile(path, "utf8"));
  } catch {
    return null;
  }
}
function defaultSettings() {
  return {
    downloadDir: getPaths().defaultDownloadDir,
    outputTemplate: "%(title)s [%(id)s].%(ext)s",
    concurrency: 3,
    defaultQuality: "best",
    audioCodec: "mp3",
    subtitleLangs: ["en"],
    embedSubs: false,
    embedThumbnail: true,
    embedMetadata: true,
    sponsorblock: false,
    autoUpdateYtdlp: true,
    lastYtdlpUpdateCheck: 0,
    accent: "#38bdf8",
    autoProbeOnPaste: true,
    watchClipboard: true,
    closeToTray: true,
    cookies: null,
    categories: [],
    defaultCategoryId: null
  };
}
const ILLEGAL_PATH_CHARS = /[<>:"/\\|?*]/g;
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function toFolderName(name) {
  const printable = Array.from(name.trim()).filter((ch) => (ch.codePointAt(0) ?? 0) >= 32).join("");
  const cleaned = printable.replace(ILLEGAL_PATH_CHARS, "").replace(/\s+/g, " ").replace(/[.\s]+$/, "").slice(0, 60).trim();
  if (!cleaned) return "Untitled";
  if (RESERVED_DEVICE_NAMES.test(cleaned)) return cleaned + "_";
  return cleaned;
}
let settings = null;
function sanitizeCategories(input) {
  if (!Array.isArray(input)) return [];
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const raw of input) {
    const candidate = raw;
    const name = typeof candidate?.name === "string" ? candidate.name.trim() : "";
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    result.push({
      id: typeof candidate.id === "string" && candidate.id ? candidate.id : node_crypto.randomUUID(),
      name: name.slice(0, 60),
      folder: typeof candidate.folder === "string" && candidate.folder ? toFolderName(candidate.folder) : toFolderName(name)
    });
  }
  return result;
}
function sanitize(input, base) {
  const merged = { ...base, ...input };
  const categories = sanitizeCategories(merged.categories);
  return {
    ...merged,
    concurrency: Math.min(8, Math.max(1, Math.round(merged.concurrency) || 3)),
    outputTemplate: merged.outputTemplate?.trim() || base.outputTemplate,
    downloadDir: merged.downloadDir?.trim() || base.downloadDir,
    subtitleLangs: Array.isArray(merged.subtitleLangs) ? merged.subtitleLangs : ["en"],
    categories,
    // A default pointing at a deleted category would silently file downloads nowhere.
    defaultCategoryId: categories.some((c) => c.id === merged.defaultCategoryId) ? merged.defaultCategoryId : null,
    cookies: merged.cookies ?? null
  };
}
async function loadSettings() {
  const base = defaultSettings();
  const stored = await readJson(getPaths().settingsFile);
  if (stored) {
    settings = sanitize(stored, base);
    const missing = Object.keys(base).filter((key) => !(key in stored));
    if (missing.length > 0) {
      await writeJsonAtomic(getPaths().settingsFile, settings).catch(() => {
      });
    }
    return settings;
  }
  settings = base;
  await writeJsonAtomic(getPaths().settingsFile, settings).catch(() => {
  });
  return settings;
}
function getSettings() {
  if (!settings) settings = defaultSettings();
  return settings;
}
async function updateSettings(patch) {
  settings = sanitize(patch, getSettings());
  await writeJsonAtomic(getPaths().settingsFile, settings);
  return settings;
}
function findCategory(id) {
  if (!id) return null;
  return getSettings().categories.find((c) => c.id === id) ?? null;
}
async function createCategory(name) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Category name cannot be empty.");
  const current = getSettings();
  if (current.categories.some((c) => c.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error('A category called "' + trimmed + '" already exists.');
  }
  const category = {
    id: node_crypto.randomUUID(),
    name: trimmed.slice(0, 60),
    folder: toFolderName(trimmed)
  };
  return updateSettings({ categories: [...current.categories, category] });
}
async function removeCategory(id) {
  const current = getSettings();
  return updateSettings({
    categories: current.categories.filter((c) => c.id !== id)
  });
}
async function isWritable(dir) {
  try {
    await promises.mkdir(dir, { recursive: true });
    await promises.access(dir, promises.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
async function saveQueue(items) {
  await writeJsonAtomic(getPaths().queueFile, items);
}
async function loadQueue() {
  const stored = await readJson(getPaths().queueFile);
  if (!Array.isArray(stored)) return [];
  return stored.map((item) => {
    const base = { ...item, categoryId: item.categoryId ?? null, uploader: item.uploader ?? null };
    if (base.status === "downloading" || base.status === "merging" || base.status === "probing") {
      return { ...base, status: "paused", speed: null, eta: null };
    }
    return base;
  });
}
const MAX_HISTORY = 1e3;
let history = null;
async function loadHistory() {
  const stored = await readJson(getPaths().historyFile);
  history = Array.isArray(stored) ? stored : [];
  const repaired = await repairMojibakePaths(history);
  if (repaired) await persistHistory();
  return history;
}
async function repairMojibakePaths(entries) {
  let changed = false;
  for (const entry of entries) {
    const path = entry.outputPath;
    if (!path || !path.includes("�")) continue;
    if (await exists$1(path)) continue;
    const folder = node_path.dirname(path);
    const target2 = node_path.basename(path);
    const names = await promises.readdir(folder).catch(() => []);
    const matches = names.filter((name) => mangleLikeAnsi(name) === target2);
    if (matches.length === 1) {
      entry.outputPath = node_path.join(folder, matches[0]);
      changed = true;
    }
  }
  return changed;
}
function mangleLikeAnsi(name) {
  const bytes = [];
  for (const char of name) {
    const code = char.codePointAt(0);
    const special = CP1252.get(char);
    if (code < 128) bytes.push(code);
    else if (special !== void 0) bytes.push(special);
    else if (code <= 255 && code >= 160) bytes.push(code);
  }
  return Buffer.from(bytes).toString("utf8");
}
const CP1252 = /* @__PURE__ */ new Map([
  ["€", 128],
  ["‚", 130],
  ["ƒ", 131],
  ["„", 132],
  ["…", 133],
  ["†", 134],
  ["‡", 135],
  ["ˆ", 136],
  ["‰", 137],
  ["Š", 138],
  ["‹", 139],
  ["Œ", 140],
  ["Ž", 142],
  ["‘", 145],
  ["’", 146],
  ["“", 147],
  ["”", 148],
  ["•", 149],
  ["–", 150],
  ["—", 151],
  ["˜", 152],
  ["™", 153],
  ["š", 154],
  ["›", 155],
  ["œ", 156],
  ["ž", 158],
  ["Ÿ", 159]
]);
async function exists$1(path) {
  return promises.access(path, promises.constants.F_OK).then(
    () => true,
    () => false
  );
}
function getHistory() {
  return history ?? [];
}
async function persistHistory() {
  await writeJsonAtomic(getPaths().historyFile, history ?? []).catch(() => {
  });
}
async function addHistoryEntry(entry) {
  const current = history ?? await loadHistory();
  const deduped = current.filter((e) => !(e.url === entry.url && e.selectionLabel === entry.selectionLabel));
  history = [entry, ...deduped].slice(0, MAX_HISTORY);
  await persistHistory();
  return history;
}
async function removeHistoryEntry(id) {
  history = (history ?? []).filter((e) => e.id !== id);
  await persistHistory();
  return history;
}
async function clearHistory() {
  history = [];
  await persistHistory();
  return history;
}
const MAX_CLIPBOARD_ENTRIES = 200;
let clipboardEntries = null;
async function loadClipboardEntries() {
  const stored = await readJson(getPaths().clipboardFile);
  clipboardEntries = Array.isArray(stored) ? stored : [];
  clipboardEntries = clipboardEntries.map(
    (e) => e.status === "pending" ? { ...e, status: "error", error: "Interrupted" } : e
  );
  return clipboardEntries;
}
async function saveClipboardEntries(entries) {
  clipboardEntries = entries.slice(0, MAX_CLIPBOARD_ENTRIES);
  await writeJsonAtomic(getPaths().clipboardFile, clipboardEntries).catch(() => {
  });
}
const STEP_LABELS = {
  appdata: "Preparing app data",
  ytdlp: "Checking yt-dlp",
  ffmpeg: "Checking ffmpeg",
  probe: "Verifying components",
  cache: "Tidying cache",
  settings: "Loading preferences"
};
const STEP_ORDER = ["appdata", "ytdlp", "ffmpeg", "probe", "cache", "settings"];
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return value.toFixed(value < 10 ? 1 : 0) + " " + units[unit];
}
const binaryVersions = { ytdlp: null, ffmpeg: null };
class Bootstrapper {
  constructor(emit) {
    this.emit = emit;
    this.steps = STEP_ORDER.map((id) => ({
      id,
      label: STEP_LABELS[id],
      status: "pending",
      percent: null,
      detail: null
    }));
  }
  emit;
  steps;
  error = null;
  done = false;
  abort = new AbortController();
  get state() {
    const per = 100 / this.steps.length;
    const overall = this.steps.reduce((sum, s) => {
      if (s.status === "done" || s.status === "skipped") return sum + per;
      if (s.status === "running" && s.percent !== null) return sum + per * s.percent / 100;
      return sum;
    }, 0);
    return {
      steps: this.steps.map((s) => ({ ...s })),
      overall: Math.min(100, Math.round(overall)),
      done: this.done,
      error: this.error
    };
  }
  patch(id, patch) {
    const step = this.steps.find((s) => s.id === id);
    if (!step) return;
    Object.assign(step, patch);
    this.emit(this.state);
  }
  cancel() {
    this.abort.abort();
  }
  /**
   * Runs every step in order. Throwing inside a step marks it failed and stops
   * the run; the splash then offers Retry or Continue anyway rather than
   * hanging on a spinner forever.
   */
  async run() {
    this.error = null;
    this.done = false;
    for (const step of this.steps) {
      if (step.status === "failed") {
        step.status = "pending";
        step.percent = null;
        step.detail = null;
      }
    }
    this.emit(this.state);
    try {
      await this.stepAppData();
      await this.stepYtdlp();
      await this.stepFfmpeg();
      await this.stepProbe();
      await this.stepCache();
      await this.stepSettings();
      this.done = true;
      this.emit(this.state);
    } catch (err) {
      const failing = this.steps.find((s) => s.status === "running");
      const id = failing?.id ?? "probe";
      const message = err instanceof Error ? err.message : String(err);
      this.patch(id, { status: "failed", detail: message.slice(0, 300) });
      this.error = {
        step: id,
        message,
        // Without yt-dlp there is nothing to continue to; other failures degrade gracefully.
        canContinue: id !== "ytdlp" && id !== "appdata"
      };
      this.emit(this.state);
    }
    return this.state;
  }
  /** Marks the run usable despite a non-fatal failure (user chose "Continue anyway"). */
  forceComplete() {
    this.error = null;
    this.done = true;
    this.emit(this.state);
    return this.state;
  }
  async stepAppData() {
    this.patch("appdata", { status: "running", percent: null });
    const paths = ensureDirs();
    await clearStaleParts(paths.bin);
    await clearStaleParts(paths.cache);
    this.patch("appdata", { status: "done", percent: 100, detail: null });
  }
  async stepYtdlp() {
    const paths = getPaths();
    this.patch("ytdlp", { status: "running", percent: null });
    if (await fileExists(paths.ytdlpExe)) {
      this.patch("ytdlp", { status: "done", percent: 100, detail: "Already installed" });
      return;
    }
    this.patch("ytdlp", { detail: "Downloading…", percent: 0 });
    await downloadYtdlp(
      paths.ytdlpExe,
      (p) => {
        this.patch("ytdlp", {
          percent: p.percent,
          detail: p.totalBytes ? formatBytes(p.receivedBytes) + " / " + formatBytes(p.totalBytes) : formatBytes(p.receivedBytes)
        });
      },
      this.abort.signal
    );
    this.patch("ytdlp", { status: "done", percent: 100, detail: "Downloaded" });
  }
  async stepFfmpeg() {
    const paths = getPaths();
    this.patch("ffmpeg", { status: "running", percent: null });
    const haveBoth = await fileExists(paths.ffmpegExe) && await fileExists(paths.ffprobeExe);
    if (haveBoth) {
      this.patch("ffmpeg", { status: "done", percent: 100, detail: "Already installed" });
      return;
    }
    this.patch("ffmpeg", { detail: "Downloading…", percent: 0 });
    await downloadFfmpeg(
      paths.bin,
      paths.cache,
      (p) => {
        if (p.phase === "extract") {
          this.patch("ffmpeg", { percent: 100, detail: "Extracting…" });
          return;
        }
        this.patch("ffmpeg", {
          percent: p.percent,
          detail: p.totalBytes ? formatBytes(p.receivedBytes) + " / " + formatBytes(p.totalBytes) : formatBytes(p.receivedBytes)
        });
      },
      this.abort.signal
    );
    this.patch("ffmpeg", { status: "done", percent: 100, detail: "Installed" });
  }
  async stepProbe() {
    const paths = getPaths();
    this.patch("probe", { status: "running", percent: null });
    binaryVersions.ytdlp = await probeYtdlp(paths.ytdlpExe).catch((err) => {
      throw new Error("yt-dlp is present but will not run: " + err.message);
    });
    binaryVersions.ffmpeg = await probeFfmpeg(paths.ffmpegExe).catch(() => null);
    this.patch("probe", {
      status: "done",
      percent: 100,
      detail: "yt-dlp " + binaryVersions.ytdlp + (binaryVersions.ffmpeg ? " · ffmpeg ok" : "")
    });
  }
  async stepCache() {
    const paths = getPaths();
    this.patch("cache", { status: "running", percent: null });
    const reclaimed = await pruneCache(paths.cache);
    this.patch("cache", {
      status: "done",
      percent: 100,
      detail: reclaimed > 0 ? "Freed " + formatBytes(reclaimed) : "Nothing to clean"
    });
  }
  async stepSettings() {
    this.patch("settings", { status: "running", percent: null });
    const settings2 = await loadSettings();
    if (!await isWritable(settings2.downloadDir)) {
      const fallback = getPaths().defaultDownloadDir;
      await updateSettings({ downloadDir: fallback });
      this.patch("settings", {
        status: "done",
        percent: 100,
        detail: "Download folder reset to default"
      });
      return;
    }
    this.patch("settings", { status: "done", percent: 100, detail: null });
  }
}
let logPath = null;
function target() {
  if (logPath) return logPath;
  try {
    const dir = node_path.join(electron.app.getPath("userData"), "logs");
    node_fs.mkdirSync(dir, { recursive: true });
    logPath = node_path.join(dir, "main.log");
    return logPath;
  } catch {
    return null;
  }
}
function write(level, args) {
  const message = args.map((a) => a instanceof Error ? a.stack ?? a.message : typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  const line = (/* @__PURE__ */ new Date()).toISOString() + " [" + level + "] " + message;
  if (level === "error") console.error(line);
  else console.log(line);
  const path = target();
  if (!path) return;
  try {
    node_fs.appendFileSync(path, line + "\n", "utf8");
  } catch {
  }
}
const log = {
  info: (...args) => write("info", args),
  warn: (...args) => write("warn", args),
  error: (...args) => write("error", args)
};
const PRELOAD = node_path.join(__dirname, "../preload/index.js");
const SECURE_WEB_PREFERENCES = {
  preload: PRELOAD,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,
  webSecurity: true
};
function rendererUrl(page) {
  const devServer = process.env["ELECTRON_RENDERER_URL"];
  if (is_dev() && devServer) {
    return { url: devServer + "/" + page + ".html" };
  }
  return { file: node_path.join(__dirname, "../renderer/" + page + ".html") };
}
function is_dev() {
  return !!process.env["ELECTRON_RENDERER_URL"];
}
function load(window, page) {
  const target2 = rendererUrl(page);
  window.webContents.on("did-fail-load", (_e, code, description, url) => {
    log.error("renderer failed to load", page, code, description, url);
  });
  window.webContents.on("render-process-gone", (_e, details) => {
    log.error("renderer process gone", page, details.reason);
  });
  log.info("loading", page, target2.url ?? target2.file);
  const promise = target2.url ? window.loadURL(target2.url) : window.loadFile(target2.file);
  promise.catch((err) => log.error("load failed for", page, err));
}
function createSplashWindow() {
  const splash = new electron.BrowserWindow({
    width: 460,
    height: 340,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    show: false,
    center: true,
    backgroundColor: "#00000000",
    title: "Starting…",
    webPreferences: SECURE_WEB_PREFERENCES
  });
  splash.once("ready-to-show", () => splash.show());
  load(splash, "splash");
  return splash;
}
function createMainWindow() {
  const window = new electron.BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 880,
    minHeight: 620,
    frame: false,
    show: false,
    backgroundColor: "#0b0e15",
    title: "Vega",
    webPreferences: SECURE_WEB_PREFERENCES
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void electron.shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const current = window.webContents.getURL();
    if (url !== current) {
      event.preventDefault();
      if (url.startsWith("https://") || url.startsWith("http://")) {
        void electron.shell.openExternal(url);
      }
    }
  });
  const notifyMaximize = () => {
    window.webContents.send("window:maximize-changed", window.isMaximized());
  };
  window.on("maximize", notifyMaximize);
  window.on("unmaximize", notifyMaximize);
  load(window, "index");
  return window;
}
function killTree(pid) {
  if (process.platform === "win32") {
    node_child_process.execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
      }
    }
  }
}
function lineReader(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r\n|\n|\r/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) onLine(trimmed);
    }
  };
}
function run(exe, args, options = {}) {
  let child;
  try {
    child = node_child_process.spawn(exe, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (err) {
    return {
      done: Promise.reject(err),
      kill: () => {
      },
      killed: false
    };
  }
  let killed = false;
  if (options.onStdoutLine) child.stdout.on("data", lineReader(options.onStdoutLine));
  if (options.onStderrLine) child.stderr.on("data", lineReader(options.onStderrLine));
  const done = new Promise((resolve, reject) => {
    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve(code));
  });
  return {
    done,
    kill() {
      if (killed) return;
      killed = true;
      if (child.pid) killTree(child.pid);
    },
    get killed() {
      return killed;
    }
  };
}
function runCapture(exe, args, timeoutMs = 9e4) {
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const handle = run(exe, args, {
      onStdoutLine: (line) => stdoutChunks.push(line),
      onStderrLine: (line) => stderrChunks.push(line)
    });
    const timer = setTimeout(() => {
      handle.kill();
      reject(new Error("Timed out after " + Math.round(timeoutMs / 1e3) + "s"));
    }, timeoutMs);
    handle.done.then(
      (code) => {
        clearTimeout(timer);
        const stdout = stdoutChunks.join("\n");
        const stderr = stderrChunks.join("\n");
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(stderr || "Exited with code " + code));
        }
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1e3;
const STARTUP_DELAY_MS = 3e4;
async function checkForYtdlpUpdate(force = false) {
  const paths = getPaths();
  const settings2 = getSettings();
  if (!force && !settings2.autoUpdateYtdlp) {
    return { ok: true, message: "Automatic updates are turned off." };
  }
  const age = Date.now() - (settings2.lastYtdlpUpdateCheck ?? 0);
  if (!force && age < CHECK_INTERVAL_MS) {
    return { ok: true, message: "Checked recently." };
  }
  try {
    const { stdout } = await runCapture(paths.ytdlpExe, ["-U"], 12e4);
    binaryVersions.ytdlp = await probeYtdlp(paths.ytdlpExe).catch(() => binaryVersions.ytdlp);
    await updateSettings({ lastYtdlpUpdateCheck: Date.now() });
    const message = stdout.split("\n").filter(Boolean).pop() ?? "yt-dlp is up to date.";
    log.info("yt-dlp update check:", message);
    return { ok: true, message };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("yt-dlp update check failed:", message);
    return { ok: false, message };
  }
}
function scheduleYtdlpUpdateCheck() {
  return setTimeout(() => {
    void checkForYtdlpUpdate();
  }, STARTUP_DELAY_MS);
}
const PROGRESS_PREFIX = "DLPROG";
const FILEPATH_PREFIX = "DLFILE";
const FIELDS = [
  "%(progress.status)s",
  "%(progress.downloaded_bytes)s",
  "%(progress.total_bytes)s",
  "%(progress.total_bytes_estimate)s",
  "%(progress.speed)s",
  "%(progress.eta)s",
  "%(progress.fragment_index)s",
  "%(progress.fragment_count)s"
].join("|");
function progressTemplateArgs() {
  return [
    "--newline",
    "--no-color",
    "--progress",
    "--progress-template",
    "download:" + PROGRESS_PREFIX + "|" + FIELDS,
    // Emits the final path once the file has been moved into place.
    "--print",
    "after_move:" + FILEPATH_PREFIX + "|%(filepath)s",
    // `--print` implies `--quiet`, which silenced every other console line —
    // and three things quietly depended on those lines: the "Processing"
    // status comes from seeing `[Merger]`/`[ExtractAudio]`, the per-item
    // details panel is that output, and parseDestinationLine is the fallback
    // for when after_move does not fire. A 17-second mp3 transcode still read
    // as "Downloading, 100%" and the log panel was always empty. This must
    // stay after --print: it is what puts the output back.
    "--no-quiet"
  ];
}
function num(raw) {
  if (!raw || raw === "NA" || raw === "None") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
function parseProgressLine(line) {
  if (!line.startsWith(PROGRESS_PREFIX + "|")) return null;
  const parts = line.split("|");
  const status = parts[1] ?? "downloading";
  const downloadedBytes = num(parts[2]);
  const totalBytes = num(parts[3]) ?? num(parts[4]);
  const fragmentIndex = num(parts[7]);
  const fragmentCount = num(parts[8]);
  let percent = null;
  if (downloadedBytes !== null && totalBytes) {
    percent = Math.min(100, downloadedBytes / totalBytes * 100);
  } else if (fragmentIndex !== null && fragmentCount) {
    percent = Math.min(100, fragmentIndex / fragmentCount * 100);
  }
  if (status === "finished") percent = 100;
  return {
    status,
    downloadedBytes,
    totalBytes,
    speed: num(parts[5]),
    eta: num(parts[6]),
    percent,
    fragmentIndex,
    fragmentCount
  };
}
function parseFilepathLine(line) {
  if (!line.startsWith(FILEPATH_PREFIX + "|")) return null;
  const path = line.slice(FILEPATH_PREFIX.length + 1).trim();
  return path.length > 0 && path !== "NA" ? path : null;
}
function parseDestinationLine(line) {
  const merger = line.match(/\[Merger\] Merging formats into "(.+)"$/);
  if (merger) return merger[1];
  const extractAudio = line.match(/\[ExtractAudio\] Destination: (.+)$/);
  if (extractAudio) return extractAudio[1];
  const destination = line.match(/^\[download\] Destination: (.+)$/);
  if (destination) return destination[1];
  const already = line.match(/^\[download\] (.+) has already been downloaded$/);
  if (already) return already[1];
  return null;
}
const POSTPROCESS_MARKERS = [
  "[Merger]",
  "[ExtractAudio]",
  "[VideoConvertor]",
  "[EmbedSubtitle]",
  "[Metadata]",
  "[ThumbnailsConvertor]",
  "[EmbedThumbnail]",
  "[SponsorBlock]",
  "[ModifyChapters]",
  "[FixupM3u8]",
  "[FixupM4a]"
];
function isPostProcessLine(line) {
  return POSTPROCESS_MARKERS.some((marker) => line.includes(marker));
}
function summarizeError(logLines) {
  const errors = logLines.filter((l) => l.includes("ERROR:"));
  const last = errors[errors.length - 1] ?? logLines[logLines.length - 1] ?? "Download failed";
  const cleaned = last.replace(/^ERROR:\s*/, "").replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, "").trim();
  if (/Sign in to confirm|not a bot/i.test(cleaned)) {
    return "This video requires sign-in. Try again later or use a different source.";
  }
  if (/Private video/i.test(cleaned)) return "This video is private.";
  if (/Video unavailable/i.test(cleaned)) return "Video unavailable.";
  if (/members-only|paid|purchase/i.test(cleaned)) return "This video requires a paid membership.";
  if (/Requested format is not available/i.test(cleaned)) {
    return "That format is no longer available. Try another quality.";
  }
  if (/Unable to download.*HTTP Error 4\d\d/i.test(cleaned)) {
    return "The server refused the download (" + (cleaned.match(/HTTP Error \d+/)?.[0] ?? "4xx") + ").";
  }
  if (/urlopen error|timed out|Temporary failure|getaddrinfo/i.test(cleaned)) {
    return "Network error — check your connection.";
  }
  if (/No space left/i.test(cleaned)) return "Not enough disk space.";
  return cleaned.slice(0, 200) || "Download failed";
}
function isRetryableError(message) {
  return /Network error|timed out|urlopen|Temporary failure|getaddrinfo|HTTP Error 5\d\d|Connection reset|refused the download \(HTTP Error 5/i.test(
    message
  );
}
function baseArgs(ctx) {
  const cookies = ctx.cookiesFile ? ["--cookies", ctx.cookiesFile] : [];
  return [
    ...cookies,
    "--ignore-config",
    "--no-color",
    "--encoding",
    "utf-8",
    "--cache-dir",
    ctx.cacheDir,
    "--ffmpeg-location",
    ctx.ffmpegDir
  ];
}
function formatSelector(selection) {
  switch (selection.mode) {
    case "best": {
      return ["-f", "bv*+ba/b"];
    }
    case "quality": {
      const h = selection.height;
      return [
        "-f",
        "bv*[height<=" + h + "]+ba/b[height<=" + h + "]/bv*+ba/b",
        "--merge-output-format",
        "mp4"
      ];
    }
    case "format": {
      const id = selection.formatId;
      return selection.needsAudio ? ["-f", id + "+ba/" + id, "--merge-output-format", "mp4"] : ["-f", id];
    }
    case "audio": {
      const quality = selection.quality === "best" ? "0" : selection.quality + "K";
      return [
        "-f",
        "ba/b",
        "-x",
        "--audio-format",
        selection.codec,
        "--audio-quality",
        quality
      ];
    }
  }
}
function buildDownloadArgs(req, ctx) {
  const baseDir = req.outputDir ?? ctx.outputDir;
  const outputDir = ctx.categoryFolder ? node_path.join(baseDir, ctx.categoryFolder) : baseDir;
  const args = [
    ...baseArgs(ctx),
    ...progressTemplateArgs(),
    ...formatSelector(req.selection),
    "--no-playlist",
    "--continue",
    "--no-mtime",
    // Keeps names valid on NTFS without mangling non-ASCII titles.
    "--windows-filenames",
    "--paths",
    "home:" + outputDir,
    "--paths",
    "temp:" + outputDir,
    "-o",
    ctx.outputTemplate,
    // Retries inside yt-dlp handle transient blips; the queue handles the rest.
    "--retries",
    "5",
    "--fragment-retries",
    "5"
  ];
  if (req.embedSubs && req.subtitleLangs && req.subtitleLangs.length > 0) {
    args.push("--embed-subs", "--sub-langs", req.subtitleLangs.join(","));
  }
  if (req.embedThumbnail) args.push("--embed-thumbnail");
  if (req.embedMetadata) args.push("--embed-metadata");
  if (req.sponsorblock) args.push("--sponsorblock-remove", "default");
  args.push("--", req.url);
  return args;
}
function shortCodec(codec) {
  if (!codec || codec === "none") return "";
  if (codec.startsWith("avc1")) return "H.264";
  if (codec.startsWith("av01")) return "AV1";
  if (codec.startsWith("vp9") || codec.startsWith("vp09")) return "VP9";
  if (codec.startsWith("hev1") || codec.startsWith("hvc1")) return "HEVC";
  if (codec.startsWith("mp4a")) return "AAC";
  return codec.split(".")[0];
}
function normalizeFormats(raw, duration = null) {
  const formats = [];
  for (const f of raw) {
    if (!f.format_id) continue;
    if (f.ext === "mhtml" || f.protocol === "mhtml") continue;
    const hasVideo = !!f.vcodec && f.vcodec !== "none";
    const hasAudio = !!f.acodec && f.acodec !== "none";
    if (!hasVideo && !hasAudio) continue;
    const kind = hasVideo && hasAudio ? "combined" : hasVideo ? "video" : "audio";
    const reported = f.filesize ?? f.filesize_approx ?? null;
    const bitrate = f.tbr ?? (!hasVideo ? f.abr : null) ?? null;
    const derived = reported === null && bitrate && duration ? Math.round(bitrate * 1e3 * duration / 8) : null;
    const filesize = reported ?? derived;
    let label;
    if (hasVideo) {
      const res = f.height ? f.height + "p" : f.format_note ?? "video";
      const fps = f.fps && f.fps >= 50 ? String(Math.round(f.fps)) : "";
      const codec = shortCodec(f.vcodec ?? null);
      label = res + fps + (codec ? " · " + codec : "");
    } else {
      const codec = shortCodec(f.acodec ?? null) || (f.ext ?? "audio");
      const bitrate2 = f.abr ? " " + Math.round(f.abr) + "k" : "";
      label = codec + bitrate2;
    }
    formats.push({
      formatId: f.format_id,
      ext: f.ext ?? "",
      height: f.height ?? null,
      width: f.width ?? null,
      fps: f.fps ?? null,
      vcodec: hasVideo ? f.vcodec ?? null : null,
      acodec: hasAudio ? f.acodec ?? null : null,
      filesize,
      // Anything that is not an exact `filesize` is an estimate, including the
      // bitrate-derived figure.
      filesizeIsEstimate: f.filesize == null && filesize !== null,
      tbr: f.tbr ?? null,
      label,
      kind
    });
  }
  formats.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0));
  return formats;
}
function qualityChips(formats) {
  const heights = /* @__PURE__ */ new Set();
  for (const f of formats) {
    if (f.kind !== "audio" && f.height) heights.add(f.height);
  }
  return [...heights].sort((a, b) => b - a).slice(0, 6);
}
function estimateBestSize(info) {
  const video = info.formats.filter((f) => f.kind !== "audio").sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0))[0];
  if (!video?.filesize) return null;
  if (video.kind === "combined") return video.filesize;
  const audio = info.formats.filter((f) => f.kind === "audio" && f.filesize).sort((a, b) => (b.tbr ?? 0) - (a.tbr ?? 0))[0];
  return video.filesize + (audio?.filesize ?? 0);
}
function validateUrl(raw) {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Enter a link first.");
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("That does not look like a valid link.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https links are supported.");
  }
  return parsed.toString();
}
function normalizeSubtitles(subs = {}, auto = {}) {
  const tracks = [];
  for (const [lang, entries] of Object.entries(subs)) {
    tracks.push({ lang, name: entries?.[0]?.name ?? lang, auto: false });
  }
  for (const [lang, entries] of Object.entries(auto)) {
    if (tracks.some((t) => t.lang === lang)) continue;
    tracks.push({ lang, name: entries?.[0]?.name ?? lang, auto: true });
  }
  return tracks.sort((a, b) => Number(a.auto) - Number(b.auto) || a.lang.localeCompare(b.lang));
}
function toVideoInfo(json, fallbackUrl) {
  const duration = typeof json.duration === "number" ? json.duration : null;
  const formats = normalizeFormats(
    Array.isArray(json.formats) ? json.formats : [],
    duration
  );
  return {
    id: String(json.id ?? ""),
    url: String(json.webpage_url ?? json.original_url ?? fallbackUrl),
    title: String(json.title ?? "Untitled"),
    uploader: json.uploader ?? json.channel ?? null,
    duration,
    thumbnail: json.thumbnail ?? null,
    extractor: json.extractor_key ?? null,
    isLive: json.is_live === true,
    formats,
    subtitles: normalizeSubtitles(
      json.subtitles,
      json.automatic_captions
    ),
    qualities: qualityChips(formats)
  };
}
function isNestedList(entry) {
  return entry._type === "playlist" || entry._type === "multi_video" || entry.ie_key === "YoutubeTab" || entry.ie_key === "YoutubePlaylist";
}
function sectionLabel(title) {
  const tail = title.split(" - ").pop()?.trim();
  return tail && tail.length > 0 ? tail : title.trim();
}
function toEntry(raw, section) {
  return {
    id: String(raw.id ?? ""),
    url: String(raw.webpage_url ?? raw.url),
    title: String(raw.title ?? "Untitled"),
    uploader: raw.uploader ?? raw.channel ?? null,
    duration: typeof raw.duration === "number" ? raw.duration : null,
    // Flat entries carry a thumbnail list rather than a single URL, smallest
    // first — the last one is the one worth showing.
    thumbnail: raw.thumbnail ?? raw.thumbnails?.[raw.thumbnails.length - 1]?.url ?? null,
    section
  };
}
const MAX_LIST_DEPTH = 2;
function collectEntries(raw, section, depth, entries, nested) {
  for (const item of raw) {
    if (!item) continue;
    const url = item.webpage_url ?? item.url;
    if (isNestedList(item)) {
      const label = sectionLabel(String(item.title ?? "Videos"));
      const inline = Array.isArray(item.entries) ? item.entries : [];
      if (inline.length > 0) {
        if (depth < MAX_LIST_DEPTH) collectEntries(inline, label, depth + 1, entries, nested);
      } else if (url) {
        nested.push({ url: String(url), title: label });
      }
      continue;
    }
    if (!url) continue;
    entries.push(toEntry(item, section));
  }
}
function splitEntries(json, section) {
  const raw = Array.isArray(json.entries) ? json.entries : [];
  const entries = [];
  const nested = [];
  collectEntries(raw, section, 0, entries, nested);
  return { entries, nested };
}
function toPlaylistInfo(json, fallbackUrl) {
  return {
    id: String(json.id ?? ""),
    url: String(json.webpage_url ?? fallbackUrl),
    title: String(json.title ?? "Playlist"),
    uploader: json.uploader ?? json.channel ?? null,
    entries: [],
    isChannel: false
  };
}
const CACHE_TTL_MS = 5 * 60 * 1e3;
const cache = /* @__PURE__ */ new Map();
const ENTRY_CACHE_TTL_MS = 30 * 60 * 1e3;
const entryCache = /* @__PURE__ */ new Map();
function clearProbeCache() {
  cache.clear();
  entryCache.clear();
}
function flatProbeArgs(ctx, url, limit) {
  return [
    ...baseArgs(ctx),
    "-J",
    "--flat-playlist",
    ...limit ? ["--playlist-end", String(limit)] : [],
    "--no-warnings",
    "--socket-timeout",
    "20",
    "--",
    url
  ];
}
async function flatProbeJson(ctx, url, timeoutMs, limit) {
  let stdout;
  try {
    ;
    ({ stdout } = await runCapture(ctx.ytdlpExe, flatProbeArgs(ctx, url, limit), timeoutMs));
  } catch (err) {
    throw new Error(cleanProbeError(err));
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("Could not read the video details for that link.");
  }
}
const MAX_NESTED_LISTS = 4;
const LIST_PROBE_TIMEOUT_MS = 24e4;
async function expandNested(ctx, nested) {
  const collected = [];
  for (const list of nested.slice(0, MAX_NESTED_LISTS)) {
    let json;
    try {
      json = await flatProbeJson(ctx, list.url, LIST_PROBE_TIMEOUT_MS);
    } catch {
      continue;
    }
    collected.push(...splitEntries(json, sectionLabel(list.title)).entries);
  }
  return collected;
}
function dedupeEntries(entries) {
  const seen = /* @__PURE__ */ new Set();
  return entries.filter((entry) => {
    const key = entry.id || entry.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
async function probe(url, ctx, options = {}) {
  const safeUrl = validateUrl(url);
  const expandLists = options.expandLists !== false;
  const cached2 = cache.get(safeUrl);
  if (cached2 && Date.now() - cached2.at < CACHE_TTL_MS && (cached2.expanded || !expandLists)) {
    return cached2.result;
  }
  const json = await flatProbeJson(
    ctx,
    safeUrl,
    LIST_PROBE_TIMEOUT_MS,
    expandLists ? void 0 : 1
  );
  let result;
  let expanded = true;
  if (json._type === "playlist" || json._type === "multi_video") {
    const info = toPlaylistInfo(json, safeUrl);
    const { entries, nested } = splitEntries(json, null);
    const fromLists = nested.length > 0 && expandLists ? await expandNested(ctx, nested) : [];
    info.entries = dedupeEntries([...entries, ...fromLists]);
    info.isChannel = info.entries.some((entry) => entry.section !== null);
    expanded = expandLists;
    result = { kind: "playlist", playlist: info };
  } else {
    result = { kind: "video", video: toVideoInfo(json, safeUrl) };
  }
  cache.set(safeUrl, { at: Date.now(), result, expanded });
  return result;
}
async function runEntryProbe(url, ctx) {
  const args = [
    ...baseArgs(ctx),
    "-J",
    "--no-playlist",
    "--no-warnings",
    "--socket-timeout",
    "20",
    "--",
    url
  ];
  let stdout;
  try {
    ;
    ({ stdout } = await runCapture(ctx.ytdlpExe, args));
  } catch (err) {
    throw new Error(cleanProbeError(err));
  }
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error("Could not read the video details for that link.");
  }
  if (json._type === "playlist" || json._type === "multi_video") {
    throw new Error("That link is a playlist, not a single video.");
  }
  return toVideoInfo(json, url);
}
const ENTRY_PROBE_CONCURRENCY = 3;
let activeEntryProbes = 0;
const waitingEntryProbes = [];
function releaseEntrySlot() {
  activeEntryProbes--;
  waitingEntryProbes.shift()?.();
}
async function takeEntrySlot() {
  if (activeEntryProbes < ENTRY_PROBE_CONCURRENCY) {
    activeEntryProbes++;
    return;
  }
  await new Promise((resolve) => waitingEntryProbes.push(resolve));
  activeEntryProbes++;
}
async function probeEntry(url, ctx) {
  const safeUrl = validateUrl(url);
  const cached2 = entryCache.get(safeUrl);
  if (cached2 && Date.now() - cached2.at < ENTRY_CACHE_TTL_MS) return cached2.info;
  await takeEntrySlot();
  try {
    const fresh = entryCache.get(safeUrl);
    if (fresh && Date.now() - fresh.at < ENTRY_CACHE_TTL_MS) return fresh.info;
    const info = await runEntryProbe(safeUrl, ctx);
    entryCache.set(safeUrl, { at: Date.now(), info });
    return info;
  } finally {
    releaseEntrySlot();
  }
}
function cleanProbeError(err) {
  const raw = err instanceof Error ? err.message : String(err);
  const line = raw.split("\n").find((l) => l.includes("ERROR:"))?.replace(/^ERROR:\s*/, "").replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, "");
  const message = (line ?? raw).trim();
  if (/Unsupported URL/i.test(message)) return "That site is not supported.";
  if (/Sign in to confirm|not a bot/i.test(message)) return "This video requires sign-in.";
  if (/Private video/i.test(message)) return "This video is private.";
  if (/Video unavailable/i.test(message)) return "Video unavailable.";
  if (/Timed out/i.test(message)) return "Timed out reading that link.";
  if (/urlopen error|getaddrinfo|Temporary failure/i.test(message)) {
    return "Network error — check your connection.";
  }
  return message.slice(0, 200) || "Could not read that link.";
}
const BROWSERS = [
  {
    id: "brave",
    label: "Brave",
    process: "brave.exe",
    roots: (e) => [node_path.join(e.local, "BraveSoftware", "Brave-Browser", "User Data")],
    resolve: resolveChromium
  },
  {
    id: "chrome",
    label: "Chrome",
    process: "chrome.exe",
    roots: (e) => [node_path.join(e.local, "Google", "Chrome", "User Data")],
    resolve: resolveChromium
  },
  {
    id: "edge",
    label: "Edge",
    process: "msedge.exe",
    roots: (e) => [node_path.join(e.local, "Microsoft", "Edge", "User Data")],
    resolve: resolveChromium
  },
  {
    id: "opera",
    label: "Opera",
    process: "opera.exe",
    roots: (e) => [
      node_path.join(e.roaming, "Opera Software", "Opera Stable"),
      node_path.join(e.roaming, "Opera Software", "Opera GX Stable")
    ],
    // Opera keeps its profile in the root itself rather than a Default subfolder.
    resolve: async (root) => ({ dir: root, spec: null, name: null })
  },
  {
    id: "vivaldi",
    label: "Vivaldi",
    process: "vivaldi.exe",
    roots: (e) => [node_path.join(e.local, "Vivaldi", "User Data")],
    resolve: resolveChromium
  },
  {
    id: "firefox",
    label: "Firefox",
    process: "firefox.exe",
    roots: (e) => [node_path.join(e.roaming, "Mozilla", "Firefox", "Profiles")],
    resolve: resolveFirefox
  }
];
const BROWSER_IDS = new Set(BROWSERS.map((b) => b.id));
function asCookieBrowser(value) {
  if (typeof value !== "string" || !BROWSER_IDS.has(value)) {
    throw new Error("Unsupported browser");
  }
  return value;
}
function env() {
  const home = node_os.homedir();
  return {
    local: process.env.LOCALAPPDATA ?? node_path.join(home, "AppData", "Local"),
    roaming: process.env.APPDATA ?? node_path.join(home, "AppData", "Roaming"),
    home
  };
}
async function exists(path) {
  return promises.access(path, promises.constants.F_OK).then(
    () => true,
    () => false
  );
}
async function mtime(path) {
  return promises.stat(path).then(
    (s) => s.mtimeMs,
    () => 0
  );
}
async function resolveChromium(root) {
  const preferred = node_path.join(root, "Default");
  if (await exists(preferred)) return { dir: preferred, spec: null, name: "Default" };
  return { dir: root, spec: null, name: null };
}
async function resolveFirefox(root) {
  const iniPath = node_path.join(node_path.dirname(root), "profiles.ini");
  const ini = await promises.readFile(iniPath, "utf8").catch(() => null);
  const candidates = [];
  if (ini) {
    for (const section of parseIni(ini)) {
      if (!/^Profile\d+$/i.test(section.name)) continue;
      const rel = section.values.Path;
      if (!rel) continue;
      const normalized = rel.replace(/\//g, "\\");
      const dir = section.values.IsRelative === "0" && node_path.isAbsolute(normalized) ? normalized : node_path.join(node_path.dirname(root), normalized);
      candidates.push({
        dir,
        name: section.values.Name ?? node_path.basename(dir),
        isDefault: section.values.Default === "1"
      });
    }
  }
  const usable = [];
  for (const c of candidates) {
    const db = node_path.join(c.dir, "cookies.sqlite");
    if (await exists(db)) usable.push({ ...c, touched: await mtime(db) });
  }
  const release = usable.filter((c) => !/dev-edition|aurora|nightly/i.test(c.dir + " " + c.name));
  const pool = release.length > 0 ? release : usable;
  if (pool.length === 0) return null;
  const chosen = pool.find((c) => /default-release/i.test(c.dir)) ?? pool.find((c) => c.isDefault) ?? pool.sort((a, b) => b.touched - a.touched)[0];
  const insideRoot = node_path.join(root, node_path.basename(chosen.dir)) === chosen.dir;
  return {
    dir: chosen.dir,
    spec: insideRoot ? node_path.basename(chosen.dir) : null,
    name: chosen.name
  };
}
function parseIni(text) {
  const sections = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      current = { name: header[1], values: {} };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq > 0) current.values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return sections;
}
async function detectBrowsers() {
  const e = env();
  return Promise.all(
    BROWSERS.map(async (spec) => {
      const profile = await resolveProfile(spec, e);
      return {
        id: spec.id,
        label: spec.label,
        installed: profile !== null,
        profileDir: profile?.dir ?? null,
        profileName: profile?.name ?? null
      };
    })
  );
}
async function resolveProfile(spec, e) {
  for (const root of spec.roots(e)) {
    if (!await exists(root)) continue;
    const profile = await spec.resolve(root);
    if (profile) return profile;
  }
  return null;
}
const STUB_INFO = JSON.stringify({
  id: "cookie-export",
  title: "cookie-export",
  ext: "mp4",
  // A bare `url` makes the entry its own single format. Declaring an empty
  // `formats` list instead reads as a real extraction that turned up nothing,
  // and yt-dlp aborts with "No video formats found" before reaching the
  // cookies at all.
  url: "https://localhost/none",
  webpage_url: "https://localhost/none",
  extractor: "generic",
  extractor_key: "Generic"
});
async function captureCookies(browser) {
  const paths = getPaths();
  const spec = BROWSERS.find((b) => b.id === browser);
  if (!spec) throw new Error("Unsupported browser");
  const profile = await resolveProfile(spec, env());
  if (!profile) {
    throw new Error(spec.label + " is not installed, or has no profile on this account.");
  }
  const stubFile = node_path.join(paths.cache, "cookie-export.info.json");
  const stagingFile = paths.cookiesFile + ".new";
  await promises.writeFile(stubFile, STUB_INFO, "utf8");
  await promises.rm(stagingFile, { force: true });
  const args = [
    "--ignore-config",
    "--no-color",
    "--encoding",
    "utf-8",
    "--cookies-from-browser",
    profile.spec ? browser + ":" + profile.spec : browser,
    "--cookies",
    stagingFile,
    "--load-info-json",
    stubFile,
    "--skip-download",
    "--simulate"
  ];
  let failure = null;
  try {
    await runCapture(paths.ytdlpExe, args, 6e4);
  } catch (err) {
    failure = err;
  }
  const jar = await exists(stagingFile) ? await promises.readFile(stagingFile, "utf8") : null;
  const status = jar ? summarize(jar, browser, profile) : null;
  if (jar === null || status === null || status.cookieCount === 0) {
    await promises.rm(stagingFile, { force: true });
    throw new Error(
      failure ? explainFailure(failure, browser) : "No cookies found in " + spec.label + ". Sign in to the site there first."
    );
  }
  await promises.writeFile(paths.cookiesFile, jar, "utf8");
  await promises.rm(stagingFile, { force: true });
  await promises.rm(stubFile, { force: true });
  return status;
}
async function clearCookies() {
  await promises.rm(getPaths().cookiesFile, { force: true });
}
const YOUTUBE_AUTH_COOKIES = ["SID", "__Secure-3PSID", "__Secure-1PSID", "SAPISID"];
function summarize(jar, browser, profile) {
  let cookieCount = 0;
  let youtubeCount = 0;
  let signedIn = false;
  for (const line of jar.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") && !trimmed.startsWith("#HttpOnly_")) continue;
    const fields = trimmed.split("	");
    if (fields.length < 7) continue;
    cookieCount++;
    const domain = fields[0].replace("#HttpOnly_", "");
    if (!domain.includes("youtube.com") && !domain.includes("google.com")) continue;
    youtubeCount++;
    if (YOUTUBE_AUTH_COOKIES.includes(fields[5])) signedIn = true;
  }
  return {
    browser,
    cookieCount,
    youtubeCount,
    signedIn,
    profileDir: profile.dir,
    profileName: profile.name,
    capturedAt: Date.now()
  };
}
function labelOf(browser) {
  return BROWSERS.find((b) => b.id === browser)?.label ?? browser;
}
function processOf(browser) {
  return BROWSERS.find((b) => b.id === browser)?.process ?? browser;
}
function explainFailure(err, browser) {
  const raw = err instanceof Error ? err.message : String(err);
  const name = labelOf(browser);
  if (/could not copy .*cookie database/i.test(raw) || /database is locked/i.test(raw)) {
    return "Close " + name + " completely and try again — it locks its cookie database while running. Check Task Manager for leftover " + processOf(browser) + " processes.";
  }
  if (/dpapi/i.test(raw) || /failed to decrypt/i.test(raw)) {
    return name + " encrypts its cookies so only " + name + " can read them (App-Bound Encryption), and yt-dlp cannot unwrap that. Firefox is not affected — signing in there and exporting from it is the reliable route.";
  }
  if (/unsupported browser/i.test(raw)) {
    return "This build of yt-dlp cannot read " + name + ".";
  }
  if (/could not find .*cookies database|no such file|could not find/i.test(raw)) {
    return name + " has no cookie database yet. Open it, sign in, then try again.";
  }
  const firstLine = raw.split("\n")[0].replace(/^ERROR:\s*/, "").trim();
  return firstLine || "Could not read cookies from " + name + ".";
}
function buildContext() {
  const paths = getPaths();
  const settings2 = getSettings();
  return {
    ytdlpExe: paths.ytdlpExe,
    ffmpegDir: paths.bin,
    cacheDir: paths.ytdlpCache,
    outputDir: settings2.downloadDir,
    outputTemplate: settings2.outputTemplate,
    // Checked on disk rather than trusted from settings: someone who deletes
    // cookies.txt by hand should get signed-out behaviour, not a broken flag.
    cookiesFile: settings2.cookies && node_fs.existsSync(paths.cookiesFile) ? paths.cookiesFile : null
  };
}
function asString(value, field) {
  if (typeof value !== "string") throw new Error("Invalid " + field);
  return value;
}
function sanitizeRequests(raw) {
  if (!Array.isArray(raw)) throw new Error("Invalid download request");
  return raw.map((entry) => {
    const req = entry;
    const url = validateUrl(asString(req.url, "url"));
    const selection = req.selection;
    if (!selection || typeof selection !== "object") throw new Error("Missing format selection");
    switch (selection.mode) {
      case "best":
        break;
      case "quality":
        if (!Number.isFinite(selection.height)) throw new Error("Invalid quality");
        break;
      case "format":
        if (!/^[\w.+-]{1,64}$/.test(String(selection.formatId))) {
          throw new Error("Invalid format id");
        }
        break;
      case "audio":
        if (!["mp3", "m4a", "flac", "wav", "opus"].includes(selection.codec)) {
          throw new Error("Invalid audio codec");
        }
        break;
      default:
        throw new Error("Invalid format selection");
    }
    return {
      url,
      title: typeof req.title === "string" ? req.title.slice(0, 300) : url,
      uploader: typeof req.uploader === "string" ? req.uploader.slice(0, 200) : null,
      thumbnail: typeof req.thumbnail === "string" ? req.thumbnail : null,
      duration: typeof req.duration === "number" ? req.duration : null,
      selection,
      // An id that does not match a real category becomes null rather than
      // being trusted into a path segment.
      categoryId: findCategory(req.categoryId)?.id ?? null,
      outputDir: typeof req.outputDir === "string" ? node_path.resolve(req.outputDir) : void 0,
      subtitleLangs: Array.isArray(req.subtitleLangs) ? req.subtitleLangs.filter((l) => typeof l === "string").slice(0, 20) : void 0,
      embedSubs: req.embedSubs === true,
      embedThumbnail: req.embedThumbnail === true,
      embedMetadata: req.embedMetadata === true,
      sponsorblock: req.sponsorblock === true
    };
  });
}
function registerIpc(deps) {
  electron.ipcMain.on("window:minimize", (event) => {
    electron.BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  electron.ipcMain.on("window:toggle-maximize", (event) => {
    const window = electron.BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  electron.ipcMain.on("window:close", (event) => {
    electron.BrowserWindow.fromWebContents(event.sender)?.close();
  });
  electron.ipcMain.on("bootstrap:retry", () => deps.onBootstrapRetry());
  electron.ipcMain.on("bootstrap:continue", () => deps.onBootstrapContinue());
  electron.ipcMain.handle("media:probe", async (_event, url) => {
    return probe(asString(url, "url"), buildContext());
  });
  electron.ipcMain.handle("media:probe-entry", async (_event, url) => {
    return probeEntry(asString(url, "url"), buildContext());
  });
  electron.ipcMain.handle(
    "queue:add",
    async (_event, requests) => deps.queue.add(sanitizeRequests(requests))
  );
  electron.ipcMain.handle("queue:pause", async (_event, id) => deps.queue.pause(asString(id, "id")));
  electron.ipcMain.handle(
    "queue:resume",
    async (_event, id) => deps.queue.resume(asString(id, "id"))
  );
  electron.ipcMain.handle(
    "queue:cancel",
    async (_event, id) => deps.queue.cancel(asString(id, "id"))
  );
  electron.ipcMain.handle("queue:retry", async (_event, id) => deps.queue.retry(asString(id, "id")));
  electron.ipcMain.handle(
    "queue:remove",
    async (_event, id) => deps.queue.remove(asString(id, "id"))
  );
  electron.ipcMain.handle("queue:clear-finished", async () => deps.queue.clearFinished());
  electron.ipcMain.handle("queue:list", async () => deps.queue.list());
  electron.ipcMain.handle("queue:log", async (_event, id) => deps.queue.getLog(asString(id, "id")));
  electron.ipcMain.handle("settings:get", async () => getSettings());
  electron.ipcMain.handle("settings:set", async (_event, patch) => {
    const incoming = patch ?? {};
    const next = await updateSettings(incoming);
    const affectsProbe = ["downloadDir", "outputTemplate", "cookies"];
    if (affectsProbe.some((key) => key in incoming)) clearProbeCache();
    return next;
  });
  electron.ipcMain.handle("settings:pick-dir", async (event) => {
    const window = electron.BrowserWindow.fromWebContents(event.sender);
    const result = window ? await electron.dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: getSettings().downloadDir
    }) : await electron.dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  electron.ipcMain.handle("settings:versions", async () => ({ ...binaryVersions }));
  electron.ipcMain.handle("settings:update-ytdlp", async () => checkForYtdlpUpdate(true));
  electron.ipcMain.handle("inbox:list", async () => deps.inbox.list());
  electron.ipcMain.handle("inbox:remove", async (_e, id) => deps.inbox.remove(asString(id, "id")));
  electron.ipcMain.handle("inbox:clear", async () => deps.inbox.clear());
  electron.ipcMain.handle("inbox:retry", async (_e, id) => deps.inbox.retry(asString(id, "id")));
  electron.ipcMain.handle("history:list", async () => getHistory());
  electron.ipcMain.handle("history:remove", async (_e, id) => {
    const next = await removeHistoryEntry(asString(id, "id"));
    deps.onHistoryChanged(next);
  });
  electron.ipcMain.handle("history:clear", async () => {
    const next = await clearHistory();
    deps.onHistoryChanged(next);
  });
  electron.ipcMain.handle("history:file-exists", async (_e, path) => {
    if (typeof path !== "string" || !path) return false;
    return promises.access(node_path.resolve(path), promises.constants.F_OK).then(
      () => true,
      () => false
    );
  });
  electron.ipcMain.handle(
    "categories:create",
    async (_e, name) => createCategory(asString(name, "name"))
  );
  electron.ipcMain.handle(
    "categories:remove",
    async (_e, id) => removeCategory(asString(id, "id"))
  );
  electron.ipcMain.handle("cookies:browsers", async () => detectBrowsers());
  electron.ipcMain.handle("cookies:capture", async (_e, browser) => {
    const status = await captureCookies(asCookieBrowser(browser));
    clearProbeCache();
    return updateSettings({ cookies: status });
  });
  electron.ipcMain.handle("cookies:clear", async () => {
    await clearCookies();
    clearProbeCache();
    return updateSettings({ cookies: null });
  });
  electron.ipcMain.handle("system:disk-space", async () => {
    try {
      const stats = await promises.statfs(getSettings().downloadDir);
      const total = stats.blocks * stats.bsize;
      const free = stats.bavail * stats.bsize;
      return Number.isFinite(total) && total > 0 ? { free, total } : null;
    } catch {
      return null;
    }
  });
  electron.ipcMain.handle("system:clipboard", async () => electron.clipboard.readText());
  electron.ipcMain.handle("system:write-clipboard", async (_e, text) => {
    electron.clipboard.writeText(asString(text, "text").slice(0, 4096));
  });
  electron.ipcMain.handle("system:open-path", async (_event, path) => {
    await electron.shell.openPath(node_path.resolve(asString(path, "path")));
  });
  electron.ipcMain.handle("system:show-in-folder", async (_event, path) => {
    electron.shell.showItemInFolder(node_path.resolve(asString(path, "path")));
  });
  electron.ipcMain.handle("system:open-external", async (_event, url) => {
    await electron.shell.openExternal(validateUrl(asString(url, "url")));
  });
}
const PROGRESS_EMIT_INTERVAL_MS = 100;
const MAX_LOG_LINES = 500;
const MAX_ATTEMPTS = 3;
const PERSIST_DEBOUNCE_MS = 1e3;
function describeSelection(selection) {
  switch (selection.mode) {
    case "best":
      return "Best";
    case "quality":
      return selection.height + "p";
    case "format":
      return "Format " + selection.formatId;
    case "audio":
      return selection.codec.toUpperCase();
  }
}
class QueueManager {
  constructor(getContext, getConcurrency, getDefaults, callbacks, getCategory, onCompleted) {
    this.getContext = getContext;
    this.getConcurrency = getConcurrency;
    this.getDefaults = getDefaults;
    this.callbacks = callbacks;
    this.getCategory = getCategory;
    this.onCompleted = onCompleted;
  }
  getContext;
  getConcurrency;
  getDefaults;
  callbacks;
  getCategory;
  onCompleted;
  items = /* @__PURE__ */ new Map();
  handles = /* @__PURE__ */ new Map();
  intents = /* @__PURE__ */ new Map();
  logs = /* @__PURE__ */ new Map();
  lastProgressEmit = /* @__PURE__ */ new Map();
  retryTimers = /* @__PURE__ */ new Map();
  /** Ids whose path came from after_move, which weaker signals must not clobber. */
  confirmedPaths = /* @__PURE__ */ new Set();
  persistTimer = null;
  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */
  list() {
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
  getLog(id) {
    return this.logs.get(id) ?? [];
  }
  /** Restores a queue persisted from a previous run. */
  hydrate(items) {
    for (const item of items) this.items.set(item.id, item);
    this.emitItems();
  }
  emitItems() {
    this.callbacks.onItems(this.list());
    this.schedulePersist();
  }
  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      saveQueue(this.list()).catch(() => {
      });
    }, PERSIST_DEBOUNCE_MS);
  }
  log(id, line) {
    let lines = this.logs.get(id);
    if (!lines) {
      lines = [];
      this.logs.set(id, lines);
    }
    lines.push(line);
    if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
  }
  patch(id, patch, options = {}) {
    const item = this.items.get(id);
    if (!item) return;
    Object.assign(item, patch);
    if (options.throttle) {
      const last = this.lastProgressEmit.get(id) ?? 0;
      const now = Date.now();
      if (now - last < PROGRESS_EMIT_INTERVAL_MS) return;
      this.lastProgressEmit.set(id, now);
      this.callbacks.onProgress({ ...item });
      return;
    }
    this.emitItems();
  }
  /* ---------------------------------------------------------------- */
  /* Mutations                                                         */
  /* ---------------------------------------------------------------- */
  add(requests) {
    const ids = [];
    for (const req of requests) {
      const url = validateUrl(req.url);
      const id = node_crypto.randomUUID();
      this.items.set(id, {
        id,
        url,
        title: req.title || url,
        uploader: req.uploader ?? null,
        thumbnail: req.thumbnail ?? null,
        duration: req.duration ?? null,
        selection: req.selection,
        categoryId: req.categoryId ?? null,
        status: "queued",
        percent: null,
        downloadedBytes: null,
        totalBytes: null,
        speed: null,
        eta: null,
        outputPath: null,
        error: null,
        attempts: 0,
        createdAt: Date.now(),
        completedAt: null
      });
      this.requestOptions.set(id, req);
      ids.push(id);
    }
    this.emitItems();
    this.pump();
    return ids;
  }
  requestOptions = /* @__PURE__ */ new Map();
  pause(id) {
    const item = this.items.get(id);
    if (!item) return;
    this.clearRetryTimer(id);
    if (item.status === "queued") {
      this.patch(id, { status: "paused" });
      return;
    }
    if (item.status !== "downloading" && item.status !== "merging") return;
    const handle = this.handles.get(id);
    if (!handle) {
      this.patch(id, { status: "paused", speed: null, eta: null });
      return;
    }
    this.intents.set(id, "pause");
    handle.kill();
  }
  resume(id) {
    const item = this.items.get(id);
    if (!item || item.status !== "paused" && item.status !== "failed") return;
    this.patch(id, { status: "queued", error: null, speed: null, eta: null });
    this.pump();
  }
  cancel(id) {
    const item = this.items.get(id);
    if (!item) return;
    this.clearRetryTimer(id);
    if (item.status === "downloading" || item.status === "merging") {
      this.intents.set(id, "cancel");
      this.handles.get(id)?.kill();
      return;
    }
    this.patch(id, { status: "canceled", speed: null, eta: null });
  }
  retry(id) {
    const item = this.items.get(id);
    if (!item) return;
    this.clearRetryTimer(id);
    this.patch(id, {
      status: "queued",
      error: null,
      attempts: 0,
      percent: null,
      speed: null,
      eta: null
    });
    this.pump();
  }
  remove(id) {
    const item = this.items.get(id);
    if (!item) return;
    this.clearRetryTimer(id);
    if (item.status === "downloading" || item.status === "merging") {
      this.intents.set(id, "cancel");
      this.handles.get(id)?.kill();
    }
    this.items.delete(id);
    this.logs.delete(id);
    this.requestOptions.delete(id);
    this.lastProgressEmit.delete(id);
    this.confirmedPaths.delete(id);
    this.emitItems();
    this.pump();
  }
  /** Pauses everything in flight or waiting — used by the tray menu. */
  pauseAll() {
    for (const item of this.list()) {
      if (item.status === "downloading" || item.status === "merging" || item.status === "queued") {
        this.pause(item.id);
      }
    }
  }
  /** Resumes everything the user (or a restart) left paused. */
  resumeAll() {
    for (const item of this.list()) {
      if (item.status === "paused") this.resume(item.id);
    }
  }
  clearFinished() {
    for (const item of this.list()) {
      if (item.status === "completed" || item.status === "canceled" || item.status === "failed") {
        this.clearRetryTimer(item.id);
        this.items.delete(item.id);
        this.logs.delete(item.id);
        this.requestOptions.delete(item.id);
        this.lastProgressEmit.delete(item.id);
        this.confirmedPaths.delete(item.id);
        this.intents.delete(item.id);
      }
    }
    this.emitItems();
  }
  /** Kills every running process — used on app quit so nothing is orphaned. */
  shutdown() {
    for (const [id, handle] of this.handles) {
      this.intents.set(id, "pause");
      handle.kill();
    }
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }
  clearRetryTimer(id) {
    const timer = this.retryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(id);
    }
  }
  /* ---------------------------------------------------------------- */
  /* Scheduling                                                        */
  /* ---------------------------------------------------------------- */
  get activeCount() {
    return this.handles.size;
  }
  /** Starts queued items until the concurrency limit is reached. */
  pump() {
    const limit = Math.max(1, this.getConcurrency());
    for (const item of this.list()) {
      if (this.activeCount >= limit) break;
      if (item.status !== "queued") continue;
      if (this.retryTimers.has(item.id)) continue;
      this.start(item.id);
    }
  }
  start(id) {
    const item = this.items.get(id);
    if (!item || this.handles.has(id)) return;
    const defaults = this.getDefaults();
    const stored = this.requestOptions.get(id);
    const ctx = { ...this.getContext(), categoryFolder: this.resolveCategoryFolder(item.categoryId) };
    const request = {
      url: item.url,
      title: item.title,
      uploader: item.uploader,
      thumbnail: item.thumbnail,
      duration: item.duration,
      selection: item.selection,
      categoryId: item.categoryId,
      subtitleLangs: stored?.subtitleLangs ?? defaults.subtitleLangs,
      embedSubs: stored?.embedSubs ?? defaults.embedSubs,
      embedThumbnail: stored?.embedThumbnail ?? defaults.embedThumbnail,
      embedMetadata: stored?.embedMetadata ?? defaults.embedMetadata,
      sponsorblock: stored?.sponsorblock ?? defaults.sponsorblock,
      outputDir: stored?.outputDir
    };
    const args = buildDownloadArgs(request, ctx);
    this.log(id, "$ yt-dlp " + args.join(" "));
    this.intents.delete(id);
    this.patch(id, {
      status: "downloading",
      error: null,
      attempts: item.attempts + 1,
      percent: item.percent ?? null
    });
    const handle = run(ctx.ytdlpExe, args, {
      onStdoutLine: (line) => this.handleLine(id, line),
      onStderrLine: (line) => this.handleLine(id, line, true)
    });
    this.handles.set(id, handle);
    handle.done.then(
      (code) => this.finish(id, code, handle.killed),
      (err) => {
        this.log(id, "Failed to start yt-dlp: " + err.message);
        this.finish(id, -1, false);
      }
    );
  }
  resolveCategoryFolder(categoryId) {
    return this.getCategory(categoryId)?.folder ?? null;
  }
  /**
   * Writes the finished download into history. History deliberately outlives
   * the file, so this records the metadata rather than pointing only at a path
   * that may later be moved or deleted.
   */
  async recordHistory(id) {
    const item = this.items.get(id);
    if (!item) return;
    const category = this.getCategory(item.categoryId);
    let filesize = item.totalBytes;
    if (item.outputPath) {
      filesize = await promises.stat(item.outputPath).then((s) => s.size).catch(() => item.totalBytes);
    }
    await this.onCompleted({
      id: node_crypto.randomUUID(),
      url: item.url,
      title: item.title,
      uploader: item.uploader,
      thumbnail: item.thumbnail,
      duration: item.duration,
      categoryId: item.categoryId,
      categoryName: category?.name ?? null,
      outputPath: item.outputPath,
      filesize,
      selectionLabel: describeSelection(item.selection),
      completedAt: Date.now()
    }).catch(() => {
    });
    this.items.delete(id);
    this.logs.delete(id);
    this.requestOptions.delete(id);
    this.confirmedPaths.delete(id);
    this.emitItems();
  }
  handleLine(id, line, isStderr = false) {
    const progress = parseProgressLine(line);
    if (progress) {
      const item = this.items.get(id);
      if (item && item.status === "merging") return;
      this.patch(
        id,
        {
          status: "downloading",
          percent: progress.percent,
          downloadedBytes: progress.downloadedBytes,
          totalBytes: progress.totalBytes,
          speed: progress.speed,
          eta: progress.eta
        },
        { throttle: true }
      );
      return;
    }
    const filepath = parseFilepathLine(line);
    if (filepath) {
      this.patch(id, { outputPath: filepath });
      this.confirmedPaths.add(id);
      return;
    }
    this.log(id, line);
    if (!this.confirmedPaths.has(id)) {
      const fallback = parseDestinationLine(line);
      if (fallback) this.patch(id, { outputPath: fallback });
    }
    if (isPostProcessLine(line)) {
      this.patch(id, { status: "merging", percent: 100, speed: null, eta: null });
      return;
    }
    if (isStderr && line.includes("ERROR:")) {
      this.patch(id, {}, { throttle: true });
    }
  }
  finish(id, code, wasKilled) {
    this.handles.delete(id);
    this.lastProgressEmit.delete(id);
    const item = this.items.get(id);
    if (!item) {
      this.pump();
      return;
    }
    if (wasKilled) {
      const intent = this.intents.get(id) ?? "cancel";
      this.intents.delete(id);
      this.patch(id, {
        status: intent === "pause" ? "paused" : "canceled",
        speed: null,
        eta: null
      });
      this.pump();
      return;
    }
    if (code === 0) {
      this.patch(id, {
        status: "completed",
        percent: 100,
        speed: null,
        eta: null,
        error: null,
        completedAt: Date.now()
      });
      void this.recordHistory(id);
      this.pump();
      return;
    }
    const message = summarizeError(this.logs.get(id) ?? []);
    if (item.attempts < MAX_ATTEMPTS && isRetryableError(message)) {
      const delayMs = 2e3 * Math.pow(2, item.attempts - 1);
      this.patch(id, {
        status: "queued",
        error: message + " — retrying…",
        speed: null,
        eta: null
      });
      this.retryTimers.set(
        id,
        setTimeout(() => {
          this.retryTimers.delete(id);
          this.pump();
        }, delayMs)
      );
      this.pump();
      return;
    }
    this.patch(id, { status: "failed", error: message, speed: null, eta: null });
    this.pump();
  }
}
function resourcePath(name) {
  return electron.app.isPackaged ? node_path.join(process.resourcesPath, name) : node_path.join(electron.app.getAppPath(), "resources", name);
}
class TrayController {
  constructor(getWindow, actions) {
    this.getWindow = getWindow;
    this.actions = actions;
  }
  getWindow;
  actions;
  tray = null;
  lastTooltip = "";
  /** -1 until the first build, so the initial menu is always created. */
  lastMenuActiveCount = -1;
  create() {
    if (this.tray) return;
    try {
      const iconPath = resourcePath("icon.ico");
      this.tray = node_fs.existsSync(iconPath) ? new electron.Tray(iconPath) : new electron.Tray(electron.nativeImage.createEmpty());
      if (!node_fs.existsSync(iconPath)) log.warn("tray icon missing at", iconPath);
    } catch (err) {
      log.warn("could not create tray icon", err);
      return;
    }
    this.tray.setToolTip("Vega");
    this.tray.on("click", () => this.actions.showWindow());
    this.tray.on("double-click", () => this.actions.showWindow());
    this.rebuildMenu(0);
  }
  destroy() {
    this.tray?.destroy();
    this.tray = null;
  }
  /**
   * Recomputes tray tooltip, context menu and taskbar progress from the queue.
   *
   * Windows shows the taskbar bar only for a value in [0,1]; -1 clears it, so
   * an idle queue must reset it rather than leaving a stale bar behind.
   */
  update(items) {
    const active = items.filter((i) => i.status === "downloading" || i.status === "merging");
    const queued = items.filter((i) => i.status === "queued").length;
    const measurable = active.filter((i) => i.percent !== null);
    const overall = measurable.length > 0 ? measurable.reduce((sum, i) => sum + (i.percent ?? 0), 0) / measurable.length / 100 : null;
    const window = this.getWindow();
    if (window && !window.isDestroyed()) {
      if (active.length === 0) {
        window.setProgressBar(-1);
      } else if (overall === null) {
        window.setProgressBar(2, { mode: "indeterminate" });
      } else {
        window.setProgressBar(overall);
      }
    }
    if (!this.tray) return;
    const tooltip = active.length === 0 ? queued > 0 ? "Vega — " + queued + " queued" : "Vega" : "Vega — " + active.length + " downloading" + (overall !== null ? " · " + Math.round(overall * 100) + "%" : "") + (queued > 0 ? " · " + queued + " queued" : "");
    if (tooltip !== this.lastTooltip) {
      this.tray.setToolTip(tooltip);
      this.lastTooltip = tooltip;
    }
    this.rebuildMenu(active.length);
  }
  rebuildMenu(activeCount) {
    if (!this.tray) return;
    const enabled = activeCount > 0;
    if (this.lastMenuActiveCount !== -1 && enabled === this.lastMenuActiveCount > 0) return;
    this.lastMenuActiveCount = activeCount;
    this.tray.setContextMenu(
      electron.Menu.buildFromTemplate([
        { label: "Show Vega", click: () => this.actions.showWindow() },
        { type: "separator" },
        {
          label: "Pause all downloads",
          enabled,
          click: () => this.actions.pauseAll()
        },
        { label: "Resume all", click: () => this.actions.resumeAll() },
        { type: "separator" },
        { label: "Quit", click: () => electron.app.quit() }
      ])
    );
  }
}
const MEDIA_HOSTS = [
  // Video platforms
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "vimeo.com",
  "dailymotion.com",
  "dai.ly",
  "rumble.com",
  "odysee.com",
  "bitchute.com",
  "streamable.com",
  "coub.com",
  "veoh.com",
  "archive.org",
  "ted.com",
  "newgrounds.com",
  // Live streaming
  "twitch.tv",
  "kick.com",
  // Social
  "tiktok.com",
  "instagram.com",
  "facebook.com",
  "fb.watch",
  "twitter.com",
  "x.com",
  "reddit.com",
  "redd.it",
  "snapchat.com",
  "pinterest.com",
  "tumblr.com",
  "linkedin.com",
  // Audio
  "soundcloud.com",
  "bandcamp.com",
  "mixcloud.com",
  "audiomack.com",
  // Regional
  "bilibili.com",
  "b23.tv",
  "nicovideo.jp",
  "vk.com",
  "ok.ru",
  "rutube.ru",
  "youku.com",
  "iqiyi.com",
  "douyin.com",
  "weibo.com",
  "naver.com",
  "afreecatv.com",
  // News and broadcast
  "bbc.co.uk",
  "bbc.com",
  "cnn.com",
  "nbcnews.com",
  "cbsnews.com",
  "abcnews.go.com",
  "aljazeera.com",
  "reuters.com",
  "espn.com",
  "trtizle.com",
  "tabii.com",
  "puhutv.com"
];
const MEDIA_EXTENSIONS = [
  ".mp4",
  ".webm",
  ".mkv",
  ".mov",
  ".avi",
  ".flv",
  ".m4v",
  ".mp3",
  ".m4a",
  ".opus",
  ".flac",
  ".wav",
  ".ogg",
  ".m3u8",
  ".mpd"
];
const HOSTS = new Set(MEDIA_HOSTS);
function isMediaUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (HOSTS.has(host)) return true;
  for (const known of HOSTS) {
    if (host.endsWith("." + known)) return true;
  }
  const path = url.pathname.toLowerCase();
  return MEDIA_EXTENSIONS.some((ext) => path.endsWith(ext));
}
const POLL_INTERVAL_MS = 1200;
class ClipboardWatcher {
  constructor(onLink) {
    this.onLink = onLink;
  }
  onLink;
  timer = null;
  lastSeen = null;
  start() {
    if (this.timer) return;
    this.lastSeen = safeRead();
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    this.timer.unref?.();
  }
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
  /** Marks a URL as already handled, so acting on it does not re-offer it. */
  acknowledge(url) {
    this.lastSeen = url;
  }
  tick() {
    if (!getSettings().watchClipboard) return;
    const text = safeRead();
    if (text === null || text === this.lastSeen) return;
    this.lastSeen = text;
    const url = asHttpUrl(text);
    if (url && isMediaUrl(url)) this.onLink(url);
  }
}
function safeRead() {
  try {
    return electron.clipboard.readText();
  } catch {
    return null;
  }
}
function asHttpUrl(text) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 2048 || /\s/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
const MAX_CONCURRENT_PROBES = 1;
function videoKey(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") {
      return "yt:" + url.pathname.slice(1).split("/")[0];
    }
    if (host.endsWith("youtube.com")) {
      const v = url.searchParams.get("v");
      if (v) return "yt:" + v;
      const shorts = url.pathname.match(/^\/shorts\/([^/]+)/);
      if (shorts) return "yt:" + shorts[1];
    }
    return host + url.pathname.replace(/\/+$/, "");
  } catch {
    return raw.trim();
  }
}
function sameVideo(a, b) {
  return videoKey(a) === videoKey(b);
}
class ClipboardInbox {
  constructor(getContext, onChange, isKnown = () => false) {
    this.getContext = getContext;
    this.onChange = onChange;
    this.isKnown = isKnown;
  }
  getContext;
  onChange;
  isKnown;
  entries = [];
  queue = [];
  active = 0;
  async load() {
    const stored = await loadClipboardEntries();
    this.entries = stored.filter((e) => isMediaUrl(e.url)).map((e) => ({ ...e, isPlaylist: e.isPlaylist === true }));
    const dropped = stored.length - this.entries.length;
    if (dropped > 0) log.info("dropped " + dropped + " clipboard entries that are not media links");
    this.emit();
  }
  list() {
    return this.entries;
  }
  emit() {
    this.onChange(this.entries);
    void saveClipboardEntries(this.entries);
  }
  /** Called by the clipboard watcher for every new link it sees. */
  add(url) {
    if (!isMediaUrl(url)) {
      log.info("ignoring non-media clipboard link:", url);
      return;
    }
    if (this.entries.some((e) => sameVideo(e.url, url))) return;
    if (this.isKnown(url)) {
      log.info("clipboard link already known, not adding to inbox:", url);
      return;
    }
    const entry = {
      id: node_crypto.randomUUID(),
      url,
      addedAt: Date.now(),
      status: "pending",
      title: null,
      uploader: null,
      thumbnail: null,
      duration: null,
      qualities: [],
      bestSize: null,
      error: null,
      isPlaylist: false,
      info: null
    };
    this.entries = [entry, ...this.entries];
    this.emit();
    this.queue.push(entry.id);
    this.pump();
  }
  retry(id) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.status === "pending") return;
    this.patch(id, { status: "pending", error: null });
    this.queue.push(id);
    this.pump();
  }
  remove(id) {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.queue = this.queue.filter((q) => q !== id);
    this.emit();
  }
  clear() {
    this.entries = [];
    this.queue = [];
    this.emit();
  }
  patch(id, patch) {
    this.entries = this.entries.map((e) => e.id === id ? { ...e, ...patch } : e);
    this.emit();
  }
  pump() {
    while (this.active < MAX_CONCURRENT_PROBES && this.queue.length > 0) {
      const id = this.queue.shift();
      if (id) void this.probeEntry(id);
    }
  }
  async probeEntry(id) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    this.active++;
    try {
      const result = await probe(entry.url, this.getContext(), { expandLists: false });
      if (result.kind === "playlist") {
        this.patch(id, {
          status: "ready",
          title: result.playlist.title,
          uploader: result.playlist.uploader,
          thumbnail: result.playlist.entries[0]?.thumbnail ?? null,
          duration: null,
          qualities: [],
          bestSize: null,
          // Downloads pass --no-playlist, so a one-click grab from here would
          // silently fetch only the first video. The row offers "Open" instead.
          isPlaylist: true,
          error: null,
          info: null
        });
        return;
      }
      const info = result.video;
      this.patch(id, {
        status: "ready",
        title: info.title,
        uploader: info.uploader,
        thumbnail: info.thumbnail,
        duration: info.duration,
        qualities: info.qualities,
        bestSize: estimateBestSize(info),
        isPlaylist: false,
        info,
        error: null
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("clipboard probe failed for", entry.url, message);
      this.patch(id, { status: "error", error: message.slice(0, 200) });
    } finally {
      this.active--;
      this.pump();
    }
  }
}
process.on("unhandledRejection", (reason) => log.error("unhandledRejection", reason));
process.on("uncaughtException", (err) => log.error("uncaughtException", err));
electron.app.setName("VideoDownloader");
const MIN_SPLASH_MS = 700;
let splashWindow = null;
let mainWindow = null;
let bootstrapper = null;
let queue = null;
let startedAt = 0;
let handedOff = false;
let updateTimer = null;
let tray = null;
let clipboardWatcher = null;
let inbox = null;
let quitting = false;
function sendToSplash(state) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send("bootstrap:progress", state);
  }
}
function sendQueueItems(items) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("queue:items", items);
  }
  tray?.update(items);
}
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
function sendQueueProgress(item) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("queue:progress", item);
  }
}
async function handOffToMainWindow() {
  if (handedOff) return;
  handedOff = true;
  const elapsed = Date.now() - startedAt;
  if (elapsed < MIN_SPLASH_MS) {
    await new Promise((r) => setTimeout(r, MIN_SPLASH_MS - elapsed));
  }
  const stored = await loadQueue().catch(() => []);
  log.info("bootstrap complete, opening main window; restored", stored.length, "queue items");
  mainWindow = createMainWindow();
  mainWindow.once("ready-to-show", () => {
    log.info("main window ready");
    mainWindow?.show();
    mainWindow?.focus();
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.destroy();
      splashWindow = null;
    }
  });
  mainWindow.on("close", (event) => {
    if (!quitting && getSettings().closeToTray) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.once("did-finish-load", () => {
    if (stored.length > 0) queue?.hydrate(stored);
  });
  if (!tray) {
    tray = new TrayController(() => mainWindow, {
      pauseAll: () => queue?.pauseAll(),
      resumeAll: () => queue?.resumeAll(),
      showWindow: showMainWindow
    });
    tray.create();
  }
  clipboardWatcher ??= new ClipboardWatcher((url) => {
    log.info("clipboard link detected:", url);
    inbox?.add(url);
  });
  clipboardWatcher.start();
  updateTimer = scheduleYtdlpUpdateCheck();
}
async function runBootstrap() {
  if (!bootstrapper) return;
  log.info("bootstrap starting");
  const state = await bootstrapper.run();
  log.info(
    "bootstrap finished; done=" + state.done,
    state.error ? "error at " + state.error.step + ": " + state.error.message : ""
  );
  if (state.done) void handOffToMainWindow();
}
function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}
function createQueue() {
  return new QueueManager(
    () => buildContext(),
    () => getSettings().concurrency,
    () => {
      const s = getSettings();
      return {
        subtitleLangs: s.subtitleLangs,
        embedSubs: s.embedSubs,
        embedThumbnail: s.embedThumbnail,
        embedMetadata: s.embedMetadata,
        sponsorblock: s.sponsorblock
      };
    },
    { onItems: sendQueueItems, onProgress: sendQueueProgress },
    (id) => findCategory(id),
    async (entry) => {
      const entries = await addHistoryEntry(entry);
      sendToWindow("history:items", entries);
    }
  );
}
const gotLock = electron.app.requestSingleInstanceLock();
if (!gotLock) {
  electron.app.quit();
} else {
  electron.app.on("second-instance", () => {
    const target2 = mainWindow ?? splashWindow;
    if (target2 && !target2.isDestroyed()) {
      if (target2.isMinimized()) target2.restore();
      target2.focus();
    }
  });
  electron.app.whenReady().then(async () => {
    startedAt = Date.now();
    queue = createQueue();
    inbox = new ClipboardInbox(
      () => buildContext(),
      (entries) => sendToWindow("inbox:items", entries),
      // A link already queued, downloading, or downloaded is not new.
      (url) => (queue?.list() ?? []).some((item) => sameVideo(item.url, url)) || getHistory().some((entry) => sameVideo(entry.url, url))
    );
    await inbox.load().catch(() => {
    });
    await loadHistory().catch(() => {
    });
    registerIpc({
      queue,
      inbox,
      onHistoryChanged: (entries) => sendToWindow("history:items", entries),
      getMainWindow: () => mainWindow,
      onBootstrapRetry: () => {
        handedOff = false;
        void runBootstrap();
      },
      onBootstrapContinue: () => {
        bootstrapper?.forceComplete();
        void handOffToMainWindow();
      }
    });
    splashWindow = createSplashWindow();
    bootstrapper = new Bootstrapper(sendToSplash);
    splashWindow.webContents.once("did-finish-load", () => {
      void runBootstrap();
    });
    electron.app.on("activate", () => {
      if (electron.BrowserWindow.getAllWindows().length === 0 && handedOff) {
        void handOffToMainWindow();
      }
    });
  });
  electron.app.on("window-all-closed", () => {
    if (getSettings().closeToTray && !quitting) return;
    if (process.platform !== "darwin") electron.app.quit();
  });
  electron.app.on("before-quit", () => {
    quitting = true;
  });
  electron.app.on("before-quit", () => {
    bootstrapper?.cancel();
    if (updateTimer) clearTimeout(updateTimer);
    clipboardWatcher?.stop();
    tray?.destroy();
    if (queue) {
      const items = queue.list();
      queue.shutdown();
      saveQueue(items).catch(() => {
      });
    }
  });
}
