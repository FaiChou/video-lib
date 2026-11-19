import http from "node:http";
import path from "node:path";
import { constants } from "node:fs";
import {
  mkdir,
  readdir,
  lstat,
  realpath,
  open,
  link,
  unlink,
  readFile,
  rename,
  utimes,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isCompatibleVideo, isValidMp3, normalizeVideo, validateOverlayPng } from "./media-converter.mjs";
import { loadProjectEnv } from "./env.mjs";

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOST = "0.0.0.0";
const MAX_LIMIT = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_MUSIC_BYTES = 50 * 1024 * 1024;
const MAX_SETTINGS_BODY_BYTES = 3 * 1024 * 1024;
const DEFAULT_EXPORT_SETTINGS = Object.freeze({
  watermark: Object.freeze({
    enabled: false,
    text: "",
    color: "#ffffff",
    bold: false,
    backgroundColor: "#000000",
    backgroundOpacity: 0.55,
    borderRadius: 8,
    fontSize: 28,
    paddingX: 16,
    paddingY: 8,
    opacity: 1,
    x: 0.92,
    y: 0.92,
  }),
  music: Object.freeze({
    enabled: false,
    file: "",
    volume: 0.35,
    loop: true,
    keepOriginalAudio: true,
  }),
});
const VIDEO_TYPES = new Map([
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".mov", "video/quicktime"],
  [".m4v", "video/mp4"],
]);
const ASSET_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function safeSegment(value, kind = "文件名") {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.startsWith(".") ||
    /[\x00-\x1f\x7f<>:"/\\|?*]/u.test(value) ||
    value.endsWith(".") ||
    Buffer.byteLength(value) > (kind === "用户名" ? 120 : 240)
  ) {
    throw new HttpError(
      400,
      `${kind}无效；请勿使用路径、隐藏文件名或特殊字符。`,
    );
  }
  return value;
}

function validDate(value) {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function filenameDate(name) {
  const match = /^(\d{4})(\d{2})(\d{2})_/.exec(name);
  const date = match && `${match[1]}-${match[2]}-${match[3]}`;
  return validDate(date) ? date : null;
}

function json(res, status, data, extraHeaders = {}) {
  if (res.destroyed || res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

async function readJson(req, maxBytes = 16 * 1024) {
  if (
    !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")
  ) {
    throw new HttpError(415, "请使用 application/json 提交。");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "请求内容过大。");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "JSON 格式无效。");
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneDefaultExportSettings() {
  return {
    watermark: { ...DEFAULT_EXPORT_SETTINGS.watermark },
    music: { ...DEFAULT_EXPORT_SETTINGS.music },
  };
}

function validateNumberField(value, fallback, min, max, label, fail) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(`${label} 必须是 ${min} 到 ${max} 之间的数字。`);
  }
  return value;
}

function validateHexColor(value, fallback, label, fail) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
    fail(`${label} 必须是 #RRGGBB 格式的颜色值。`);
  }
  return value.toLowerCase();
}

function validateExportSettings(raw, { requireAssets = false } = {}) {
  const fail = (message) => {
    throw new HttpError(400, message);
  };
  if (!isPlainObject(raw)) fail("设置内容必须是 JSON 对象。");
  if (!isPlainObject(raw.watermark)) fail("缺少有效的文字水印设置。");
  if (!isPlainObject(raw.music)) fail("缺少有效的背景音乐设置。");

  const wmRaw = raw.watermark;
  const muRaw = raw.music;
  const wmDef = DEFAULT_EXPORT_SETTINGS.watermark;
  const muDef = DEFAULT_EXPORT_SETTINGS.music;

  const wmEnabled = wmRaw.enabled === undefined ? wmDef.enabled : wmRaw.enabled;
  if (typeof wmEnabled !== "boolean") fail("水印开关必须是布尔值。");

  const rawText = wmRaw.text === undefined ? wmDef.text : wmRaw.text;
  if (typeof rawText !== "string") fail("水印文字必须是字符串。");
  const text = rawText.replace(/\r\n?/g, "\n");
  if (text.length > 200 || /[\x00-\x09\x0b-\x1f\x7f]/u.test(text)) {
    fail("水印文字不能超过 200 个字符，且不能包含控制字符。");
  }

  const bold = wmRaw.bold === undefined ? wmDef.bold : wmRaw.bold;
  if (typeof bold !== "boolean") fail("水印加粗选项必须是布尔值。");

  let fallbackX = wmDef.x;
  let fallbackY = wmDef.y;
  if (typeof wmRaw.position === "string") {
    fallbackX = wmRaw.position.endsWith("-left")
      ? 0.06
      : wmRaw.position.endsWith("-right")
        ? 0.94
        : 0.5;
    fallbackY = wmRaw.position.startsWith("top-")
      ? 0.06
      : wmRaw.position.startsWith("bottom-")
        ? 0.94
        : 0.5;
  }
  const x = Math.round(validateNumberField(wmRaw.x, fallbackX, 0, 1, "水印水平位置", fail) * 10000) / 10000;
  const y = Math.round(validateNumberField(wmRaw.y, fallbackY, 0, 1, "水印垂直位置", fail) * 10000) / 10000;

  const watermark = {
    enabled: wmEnabled,
    text,
    color: validateHexColor(wmRaw.color, wmDef.color, "水印文字颜色", fail),
    bold,
    backgroundColor: validateHexColor(wmRaw.backgroundColor, wmDef.backgroundColor, "水印背景颜色", fail),
    backgroundOpacity: validateNumberField(wmRaw.backgroundOpacity, wmDef.backgroundOpacity, 0, 1, "水印背景透明度", fail),
    borderRadius: Math.round(validateNumberField(wmRaw.borderRadius, wmDef.borderRadius, 0, 64, "水印背景圆角", fail)),
    fontSize: Math.round(validateNumberField(wmRaw.fontSize, wmDef.fontSize, 12, 120, "水印字体大小", fail)),
    paddingX: Math.round(validateNumberField(wmRaw.paddingX, wmDef.paddingX, 0, 80, "水印水平内边距", fail)),
    paddingY: Math.round(validateNumberField(wmRaw.paddingY, wmDef.paddingY, 0, 60, "水印垂直内边距", fail)),
    opacity: validateNumberField(wmRaw.opacity, wmDef.opacity, 0.1, 1, "水印整体透明度", fail),
    x,
    y,
  };

  const muEnabled = muRaw.enabled === undefined ? muDef.enabled : muRaw.enabled;
  if (typeof muEnabled !== "boolean") fail("背景音乐开关必须是布尔值。");

  const file = muRaw.file === undefined ? muDef.file : muRaw.file;
  if (typeof file !== "string") fail("背景音乐文件名必须是字符串。");
  if (file !== "") {
    safeSegment(file, "音频文件名");
    if (path.extname(file).toLowerCase() !== ".mp3") {
      fail("背景音乐仅支持 .mp3 文件。");
    }
  }

  const loop = muRaw.loop === undefined ? muDef.loop : muRaw.loop;
  if (typeof loop !== "boolean") fail("背景音乐循环开关必须是布尔值。");

  const keepOriginalAudio =
    muRaw.keepOriginalAudio === undefined
      ? muDef.keepOriginalAudio
      : muRaw.keepOriginalAudio;
  if (typeof keepOriginalAudio !== "boolean") {
    fail("保留原声选项必须是布尔值。");
  }

  const music = {
    enabled: muEnabled,
    file,
    volume: validateNumberField(muRaw.volume, muDef.volume, 0, 1, "背景音乐音量", fail),
    loop,
    keepOriginalAudio,
  };

  if (requireAssets) {
    if (watermark.enabled && !watermark.text.trim()) {
      fail("开启文字水印时，请填写水印内容。");
    }
    if (music.enabled && !music.file) {
      fail("开启背景音乐前，请先上传并选择一首 MP3。");
    }
  }

  return { watermark, music };
}

function watermarkConfigHash(watermark) {
  return createHash("sha256")
    .update(JSON.stringify({
      text: watermark.text,
      color: watermark.color,
      bold: watermark.bold,
      backgroundColor: watermark.backgroundColor,
      backgroundOpacity: watermark.backgroundOpacity,
      borderRadius: watermark.borderRadius,
      fontSize: watermark.fontSize,
      paddingX: watermark.paddingX,
      paddingY: watermark.paddingY,
      opacity: watermark.opacity,
    }))
    .digest("hex");
}

function attachmentName(name) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function parseAllowedHosts(value) {
  const invalid = () => {
    throw new Error(
      "ALLOWED_HOSTS 必须是逗号分隔的域名或 IP 地址，不得包含协议、端口、路径、通配符或空项；IPv6 不加方括号。",
    );
  };
  if (typeof value !== "string") invalid();
  if (!value.trim()) return [];
  return value.split(",").map((entry) => {
    const hostname = entry.trim().toLowerCase();
    const family = isIP(hostname);
    if (family && !hostname.includes("%")) {
      return family === 6
        ? new URL(`http://[${hostname}]`).hostname.slice(1, -1)
        : hostname;
    }
    if (
      hostname.length > 253 ||
      /^[\d.]+$/.test(hostname) ||
      !hostname
        .split(".")
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
      invalid();
    try {
      if (new URL(`http://${hostname}`).hostname !== hostname) invalid();
    } catch {
      invalid();
    }
    return hostname;
  });
}

/** Creates an HTTP server without listening; usable directly from tests. */
export async function createVideoServer(options = {}) {
  const host = options.host ?? process.env.HOST ?? DEFAULT_HOST;
  const additionalHosts = parseAllowedHosts(
    options.allowedHosts ?? process.env.ALLOWED_HOSTS ?? "nuc8.local",
  );
  const timeZone = options.timeZone ?? process.env.TZ ?? "Asia/Shanghai";
  const maxUploadBytes = Number(
    options.maxUploadBytes ?? process.env.MAX_UPLOAD_BYTES ?? MAX_LIMIT,
  );
  if (
    !Number.isSafeInteger(maxUploadBytes) ||
    maxUploadBytes < 1 ||
    maxUploadBytes > MAX_LIMIT
  ) {
    throw new Error("MAX_UPLOAD_BYTES 必须是 1 到 2147483648 之间的整数。");
  }
  const maxMusicBytes = Number(
    options.maxMusicBytes ?? process.env.MAX_MUSIC_BYTES ?? DEFAULT_MAX_MUSIC_BYTES,
  );
  if (
    !Number.isSafeInteger(maxMusicBytes) ||
    maxMusicBytes < 1 ||
    maxMusicBytes > MAX_LIMIT
  ) {
    throw new Error("MAX_MUSIC_BYTES 必须是 1 到 2147483648 之间的整数。");
  }
  const dateFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const localDate = (value = new Date()) => {
    const parts = Object.fromEntries(
      dateFormatter.formatToParts(value).map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const requestedVideoDir = path.resolve(
    options.videoDir ??
      process.env.VIDEO_DIR ??
      path.join(PROJECT_DIR, "videos"),
  );
  const publicDir = await realpath(
    path.resolve(options.publicDir ?? path.join(PROJECT_DIR, "public")),
  );
  await mkdir(requestedVideoDir, { recursive: true });
  const videoDir = await realpath(requestedVideoDir);
  const processedPath = path.join(videoDir, ".processed.json");
  let processedVideos = {};
  try {
    const saved = JSON.parse(await readFile(processedPath, "utf8"));
    if (
      !saved ||
      typeof saved !== "object" ||
      Array.isArray(saved) ||
      Object.values(saved).some((value) => typeof value !== "boolean")
    ) {
      throw new Error("内容必须是以视频路径为键、布尔值为状态的 JSON 对象。");
    }
    processedVideos = saved;
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error(`无法读取处理状态 ${processedPath}：${error.message}`);
  }
  let processedWrite = Promise.resolve();
  const settingsPath = path.join(videoDir, ".export-settings.json");
  const overlayPngPath = path.join(videoDir, ".watermark-overlay.png");
  const overlayMetaPath = path.join(videoDir, ".watermark-overlay.meta.json");
  const requestedMusicDir = path.resolve(
    options.musicDir ?? path.join(videoDir, ".music"),
  );
  let exportSettings = cloneDefaultExportSettings();
  try {
    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    exportSettings = validateExportSettings(saved);
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error(`无法读取导出设置 ${settingsPath}：${error.message}`);
  }
  let overlayMeta = null;
  try {
    const meta = JSON.parse(await readFile(overlayMetaPath, "utf8"));
    if (
      isPlainObject(meta) &&
      typeof meta.hash === "string" &&
      /^[a-f0-9]{64}$/.test(meta.hash) &&
      typeof meta.scale === "number" &&
      Number.isFinite(meta.scale) &&
      meta.scale > 0
    ) {
      overlayMeta = { hash: meta.hash, scale: meta.scale };
    }
  } catch {
    overlayMeta = null;
  }
  let settingsWrite = Promise.resolve();

  const convertVideo = options.normalizeVideo ?? normalizeVideo;
  const inspectVideo = options.isCompatibleVideo ?? isCompatibleVideo;
  const inspectMusic = options.inspectMusic ?? isValidMp3;
  const validateOverlay = options.validateOverlayPng ?? validateOverlayPng;
  const downloadJobs = new Map();
  const downloadChecks = new Map();
  const downloadReaders = new Map();
  const deletingVideos = new Set();
  const musicReaders = new Map();
  const deletingMusic = new Set();
  const musicDurationCache = new Map();
  const cacheDir = path.join(videoDir, ".transcoded");
  const cacheLifetime = 7 * 24 * 60 * 60 * 1000;
  let conversionTail = Promise.resolve();
  let pendingConversions = 0;

  async function atomicWriteFile(targetPath, data, tempPrefix) {
    const tempPath = path.join(
      path.dirname(targetPath),
      `.${tempPrefix}-${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(tempPath, targetPath);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(tempPath).catch((error) => {
        if (error.code !== "ENOENT")
          console.error("临时文件清理失败:", error.message);
      });
    }
  }

  function updateSettings(run) {
    const write = settingsWrite.then(run);
    settingsWrite = write.catch(() => {});
    return write;
  }

  async function musicFolder(create = false) {
    if (create) {
      await mkdir(requestedMusicDir, { recursive: true });
    }
    let info;
    try {
      info = await lstat(requestedMusicDir);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    const parentReal = await realpath(path.dirname(requestedMusicDir));
    const expectedReal = path.join(parentReal, path.basename(requestedMusicDir));
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(requestedMusicDir)) !== expectedReal
    ) {
      throw new HttpError(400, "背景音乐目录必须是真实文件夹。");
    }
    return expectedReal;
  }

  async function openMusic(name) {
    safeSegment(name, "音频文件名");
    if (path.extname(name).toLowerCase() !== ".mp3")
      throw new HttpError(404, "背景音乐不存在。");
    const folder = await musicFolder(false);
    if (!folder) throw new HttpError(404, "背景音乐不存在。");
    const filePath = path.join(folder, name);
    let handle;
    try {
      handle = await open(
        filePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
      );
      const info = await handle.stat();
      if (!info.isFile()) throw new HttpError(404, "背景音乐不存在。");
      return { handle, info, filePath };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code))
        throw new HttpError(404, "背景音乐不存在。");
      throw error;
    }
  }

  async function listMusic() {
    const folder = await musicFolder(false);
    if (!folder) return [];
    const tracks = [];
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        path.extname(entry.name).toLowerCase() !== ".mp3"
      )
        continue;
      try {
        safeSegment(entry.name, "音频文件名");
      } catch {
        continue;
      }
      const filePath = path.join(folder, entry.name);
      let info;
      try {
        info = await lstat(filePath);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const cacheKey = `${entry.name}:${info.size}:${info.mtimeMs}:${info.ino}`;
      let duration = musicDurationCache.get(cacheKey);
      if (duration === undefined) {
        let handle;
        try {
          handle = await open(
            filePath,
            constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
          );
          const meta = await inspectMusic({ handle });
          duration = meta?.duration ?? null;
        } catch {
          duration = null;
        } finally {
          await handle?.close().catch(() => {});
        }
        if (musicDurationCache.size >= 500) musicDurationCache.clear();
        musicDurationCache.set(cacheKey, duration);
      }
      tracks.push({
        name: entry.name,
        size: info.size,
        duration,
        url: `/music/${encodeURIComponent(entry.name)}`,
      });
    }
    tracks.sort((a, b) =>
      a.name.localeCompare(b.name, "zh-CN", { numeric: true }),
    );
    return tracks;
  }

  function releaseMusicReader(name) {
    const count = (musicReaders.get(name) || 0) - 1;
    if (count > 0) musicReaders.set(name, count);
    else musicReaders.delete(name);
  }

  // Share one queue between uploads and downloads to bound CPU and codec memory.
  function scheduleConversion(run) {
    if (pendingConversions >= 20)
      throw new HttpError(429, "转码任务较多，请稍后重试。");
    pendingConversions++;
    const task = conversionTail.then(run);
    conversionTail = task.catch(() => {}).finally(() => pendingConversions--);
    return task;
  }

  async function cacheExists() {
    const info = await lstat(cacheDir).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(cacheDir) !== cacheDir)
      throw new HttpError(500, "转码缓存目录无效。");
    return true;
  }

  async function prepareCache() {
    await mkdir(cacheDir, { recursive: true });
    await cacheExists();
    const cutoff = Date.now() - cacheLifetime;
    for (const name of await readdir(cacheDir)) {
      if (!/^([a-f0-9]{64}\.mp4|\.convert-[a-f0-9-]+\.part)$/.test(name)) continue;
      const filePath = path.join(cacheDir, name);
      const cached = await lstat(filePath).catch(() => null);
      if (cached?.isFile() && cached.mtimeMs < cutoff)
        await unlink(filePath).catch(() => {});
    }
  }

  function jobData(job) {
    return {
      id: job.id,
      status: job.status,
      progress: job.progress,
      name: job.name,
      effects: job.effects ?? { watermark: false, music: false },
      ...(job.status === "ready" ? { downloadUrl: job.downloadUrl } : {}),
      ...(job.status === "failed" ? { error: job.error } : {}),
    };
  }

  async function userFolder(user, create = false) {
    safeSegment(user, "用户名");
    const folder = path.join(videoDir, user);
    if (create)
      await mkdir(folder).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
    let info;
    try {
      info = await lstat(folder);
    } catch (error) {
      if (error.code === "ENOENT")
        throw new HttpError(404, "用户文件夹不存在。");
      throw error;
    }
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(folder)) !== folder
    ) {
      throw new HttpError(400, "用户目录必须是视频文件夹中的真实文件夹。");
    }
    return folder;
  }

  async function openVideo(user, name) {
    safeSegment(name);
    if (!VIDEO_TYPES.has(path.extname(name).toLowerCase()))
      throw new HttpError(404, "视频不存在。");
    const folder = await userFolder(user);
    let handle;
    try {
      handle = await open(path.join(folder, name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const info = await handle.stat();
      if (!info.isFile()) throw new HttpError(404, "视频不存在。");
      return { handle, info };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code))
        throw new HttpError(404, "视频不存在。");
      throw error;
    }
  }

  function videoCacheTag(user, name, info) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          "video-v1",
          user,
          name,
          info.dev,
          info.ino,
          info.size,
          info.mtimeMs,
          info.ctimeMs,
        ]),
      )
      .digest("hex")
      .slice(0, 16);
  }

  function downloadId(user, name, info, effectsKey = null) {
    const tag = videoCacheTag(user, name, info);
    const rest = createHash("sha256")
      .update(
        JSON.stringify([
          "h264-aac-v2",
          user,
          name,
          info.dev,
          info.ino,
          info.size,
          info.mtimeMs,
          info.ctimeMs,
          effectsKey,
        ]),
      )
      .digest("hex")
      .slice(0, 48);
    return `${tag}${rest}`;
  }

  async function createDownload(req) {
    const body = await readJson(req);
    const user = safeSegment(body?.user, "用户名");
    const name = safeSegment(body?.name);
    const key = `${user}/${name}`;
    if (deletingVideos.has(key)) throw new HttpError(409, "视频正在删除，请稍后刷新列表。");
    downloadReaders.set(key, (downloadReaders.get(key) || 0) + 1);
    try {
      return await prepareDownload(user, name, key);
    } finally {
      const readers = downloadReaders.get(key) - 1;
      if (readers) downloadReaders.set(key, readers);
      else downloadReaders.delete(key);
    }
  }

  async function prepareDownload(user, name, key) {
    const settingsSnapshot = exportSettings;
    const overlaySnapshot = overlayMeta;
    const activeWatermark =
      settingsSnapshot.watermark.enabled && settingsSnapshot.watermark.text.trim()
        ? { ...settingsSnapshot.watermark }
        : null;
    const activeMusic =
      settingsSnapshot.music.enabled && settingsSnapshot.music.file
        ? { ...settingsSnapshot.music }
        : null;

    let musicHandle = null;
    let musicInfo = null;
    let musicTransferred = false;
    let musicReaderHeld = false;

    if (activeMusic) {
      if (deletingMusic.has(activeMusic.file)) {
        throw new HttpError(409, "背景音乐正在删除，请稍后重试。");
      }
      musicReaders.set(
        activeMusic.file,
        (musicReaders.get(activeMusic.file) || 0) + 1,
      );
      musicReaderHeld = true;
    }

    const { handle, info } = await openVideo(user, name).catch((error) => {
      if (musicReaderHeld) releaseMusicReader(activeMusic.file);
      throw error;
    });
    let transferred = false;

    try {
      if (activeMusic) {
        try {
          const openedMusic = await openMusic(activeMusic.file);
          musicHandle = openedMusic.handle;
          musicInfo = openedMusic.info;
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) {
            throw new HttpError(409, "所选背景音乐文件不存在，请到管理页面重新选择。");
          }
          throw error;
        }
      }

      let overlayBuf = null;
      let overlayScale = 3;
      if (
        activeWatermark &&
        overlaySnapshot &&
        overlaySnapshot.hash === watermarkConfigHash(activeWatermark)
      ) {
        try {
          overlayBuf = await readFile(overlayPngPath);
          overlayScale = overlaySnapshot.scale;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          overlayBuf = null;
        }
      }

      const needsEffects = Boolean(activeWatermark || activeMusic);
      const effectsKey = needsEffects
        ? {
            wm: activeWatermark,
            ovHash: overlayBuf ? overlaySnapshot.hash : null,
            ovScale: overlayBuf ? overlayScale : null,
            mu: activeMusic
              ? {
                  file: activeMusic.file,
                  volume: activeMusic.volume,
                  loop: activeMusic.loop,
                  keepOriginalAudio: activeMusic.keepOriginalAudio !== false,
                  dev: musicInfo.dev,
                  ino: musicInfo.ino,
                  size: musicInfo.size,
                  mtimeMs: musicInfo.mtimeMs,
                  ctimeMs: musicInfo.ctimeMs,
                }
              : null,
          }
        : null;

      const id = downloadId(user, name, info, effectsKey);

      // Coalesce concurrent checks before probing or submitting a conversion.
      // Each request still closes its own file handle unless the queue owns it.
      if (downloadChecks.has(id))
        return { job: jobData(await downloadChecks.get(id)) };
      const check = (async () => {
        const existing = downloadJobs.get(id);
        if (existing && ["queued", "processing"].includes(existing.status)) return existing;

        const target = path.join(cacheDir, `${id}.mp4`);
        const job = {
          id,
          sourceKey: key,
          musicFile: activeMusic?.file || null,
          effects: {
            watermark: Boolean(activeWatermark),
            music: Boolean(activeMusic),
          },
          status: "ready",
          progress: 1,
          name: `${path.parse(name).name}.mp4`,
          downloadUrl: `/api/downloads/${id}/file`,
        };
        let cached;
        if (await cacheExists()) {
          cached = await lstat(target).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
        if (cached?.isFile() && !cached.isSymbolicLink() && cached.mtimeMs >= Date.now() - cacheLifetime) {
          await utimes(target, new Date(), new Date());
          job.filePath = target;
        } else {
          let compatible = !!existing?.sourceInfo;
          if (!compatible) {
            try {
              compatible = await inspectVideo({ handle });
            } catch (error) {
              console.error("下载编码检查失败:", error.message);
              throw new HttpError(422, "无法检查此视频的编码，请检查文件是否损坏或下载原文件。");
            }
          }
          if (!needsEffects && compatible) {
            job.filePath = path.join(videoDir, user, name);
            job.sourceInfo = info;
          }
        }
        const sourceUnchanged = async () => {
          const after = await handle.stat();
          return ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((prop) => after[prop] === info[prop]);
        };
        const musicUnchanged = async () => {
          if (!musicHandle || !musicInfo) return true;
          const after = await musicHandle.stat();
          return ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((prop) => after[prop] === musicInfo[prop]);
        };
        if (!(await sourceUnchanged()))
          throw new HttpError(409, "源文件发生变化，请重新下载。");
        if (!(await musicUnchanged()))
          throw new HttpError(409, "背景音乐文件发生变化，请重新下载。");

        // Keep a bounded status history. Cached files remain reusable after eviction.
        if (downloadJobs.size >= 200) {
          for (const [jobId, previous] of downloadJobs) {
            if (["ready", "failed"].includes(previous.status)) downloadJobs.delete(jobId);
            if (downloadJobs.size < 200) break;
          }
        }
        if (job.filePath) {
          downloadJobs.set(id, job);
          return job;
        }

        // Only actual conversions wait for the shared CPU queue. Compatible
        // originals and cache hits return ready in this very first response.
        job.status = "queued";
        job.progress = 0;
        const task = scheduleConversion(async () => {
          const tempPath = path.join(cacheDir, `.convert-${randomUUID()}.part`);
          try {
            job.status = "processing";
            await prepareCache();
            if (!(await sourceUnchanged()))
              throw new Error("转码期间源文件发生变化，请重新下载。");
            if (!(await musicUnchanged()))
              throw new Error("转码期间背景音乐发生变化，请重新下载。");
            const convertOptions = {
              handle,
              outputPath: tempPath,
              onProgress: (progress) => { job.progress = progress; },
            };
            if (needsEffects) {
              convertOptions.watermark = activeWatermark;
              convertOptions.watermarkOverlay = overlayBuf;
              convertOptions.watermarkOverlayScale = overlayScale;
              convertOptions.music = activeMusic
                ? {
                    handle: musicHandle,
                    volume: activeMusic.volume,
                    loop: activeMusic.loop,
                    keepOriginalAudio: activeMusic.keepOriginalAudio !== false,
                  }
                : null;
            }
            const { converted } = await convertVideo(convertOptions);
            if (!(await sourceUnchanged()))
              throw new Error("转码期间源文件发生变化，请重新下载。");
            if (!(await musicUnchanged()))
              throw new Error("转码期间背景音乐发生变化，请重新下载。");
            if (converted) {
              await rename(tempPath, target);
              job.filePath = target;
            } else {
              job.filePath = path.join(videoDir, user, name);
              job.sourceInfo = info;
            }
            job.progress = 1;
            job.status = "ready";
          } catch (error) {
            console.error("下载转码失败:", error.message);
            job.status = "failed";
            job.error = "无法转换此视频，请重试或下载原文件。";
          } finally {
            await handle.close().catch(() => {});
            if (musicHandle) await musicHandle.close().catch(() => {});
            if (musicReaderHeld) releaseMusicReader(activeMusic.file);
            await unlink(tempPath).catch(() => {});
          }
        });
        transferred = true;
        musicTransferred = musicReaderHeld;
        downloadJobs.set(id, job);
        task.catch((error) => console.error("下载任务失败:", error.message));
        return job;
      })();
      downloadChecks.set(id, check);
      try {
        return { job: jobData(await check) };
      } finally {
        downloadChecks.delete(id);
      }
    } finally {
      if (!transferred) await handle.close().catch(() => {});
      if (!musicTransferred) {
        if (musicHandle) await musicHandle.close().catch(() => {});
        if (musicReaderHeld) releaseMusicReader(activeMusic.file);
      }
    }
  }

  function videoMetadata(user, name, info) {
    const fromName = filenameDate(name);
    const url = `/media/${encodeURIComponent(user)}/${encodeURIComponent(name)}`;
    return {
      id: Buffer.from(`${user}/${name}`).toString("base64url"),
      user,
      name,
      date: fromName || localDate(info.mtime),
      dateSource: fromName ? "filename" : "modified",
      size: info.size,
      processed: processedVideos[`${user}/${name}`] === true,
      url,
      downloadUrl: `${url}?download=1`,
    };
  }

  async function library() {
    const users = [];
    const videos = [];
    for (const entry of await readdir(videoDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      let folder;
      try {
        folder = await userFolder(entry.name);
      } catch (error) {
        if (error instanceof HttpError) continue;
        throw error;
      }
      let count = 0;
      for (const file of await readdir(folder, { withFileTypes: true })) {
        if (
          !file.isFile() ||
          file.isSymbolicLink() ||
          !VIDEO_TYPES.has(path.extname(file.name).toLowerCase())
        )
          continue;
        try {
          safeSegment(file.name);
        } catch {
          continue;
        }
        try {
          const info = await lstat(path.join(folder, file.name));
          if (!info.isFile() || info.isSymbolicLink()) continue;
          videos.push(videoMetadata(entry.name, file.name, info));
          count += 1;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      users.push({ name: entry.name, count });
    }
    users.sort((a, b) =>
      a.name.localeCompare(b.name, "zh-CN", { numeric: true }),
    );
    videos.sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        a.user.localeCompare(b.user) ||
        a.name.localeCompare(b.name, "zh-CN", { numeric: true }),
    );
    return { users, videos, today: localDate(), timeZone, maxUploadBytes };
  }

  async function videoInfo(user, name) {
    if (!VIDEO_TYPES.has(path.extname(name).toLowerCase()))
      throw new HttpError(404, "视频不存在。");
    const folder = await userFolder(user);
    let info;
    try {
      info = await lstat(path.join(folder, name));
    } catch (error) {
      if (error.code === "ENOENT") throw new HttpError(404, "视频不存在。");
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink())
      throw new HttpError(404, "视频不存在。");
    return { folder, info };
  }

  async function saveProcessed(next) {
    await atomicWriteFile(
      processedPath,
      JSON.stringify(next, null, 2) + "\n",
      "processed",
    );
    processedVideos = next;
  }

  // Include existence checks in this queue so a late status save cannot recreate
  // the record for a deleted video, or overwrite another video's latest status.
  function updateProcessed(run) {
    const write = processedWrite.then(run);
    processedWrite = write.catch(() => {});
    return write;
  }

  async function setProcessed(req) {
    const body = await readJson(req);
    const user = safeSegment(body?.user, "用户名");
    const name = safeSegment(body?.name);
    if (typeof body?.processed !== "boolean")
      throw new HttpError(400, "处理状态必须是布尔值。");
    return updateProcessed(async () => {
      const key = `${user}/${name}`;
      if (deletingVideos.has(key)) throw new HttpError(409, "视频正在删除，请稍后刷新列表。");
      const { info } = await videoInfo(user, name);
      await saveProcessed({ ...processedVideos, [key]: body.processed });
      return { video: videoMetadata(user, name, info) };
    });
  }

  async function deleteVideo(req) {
    const body = await readJson(req);
    const user = safeSegment(body?.user, "用户名");
    const name = safeSegment(body?.name);
    const key = `${user}/${name}`;
    if (deletingVideos.has(key)) throw new HttpError(409, "视频正在删除，请稍后刷新列表。");
    if (downloadReaders.has(key) || [...downloadJobs.values()].some((job) =>
      job.sourceKey === key && ["queued", "processing"].includes(job.status)))
      throw new HttpError(409, "视频正在准备下载，请等待完成后再删除。");
    deletingVideos.add(key);
    try {
      return await updateProcessed(async () => {
        const { folder, info } = await videoInfo(user, name);
        const tag = videoCacheTag(user, name, info);
        const ids = new Set([downloadId(user, name, info)]);
        for (const job of downloadJobs.values()) {
          if (job.sourceKey === key) ids.add(job.id);
        }
        if (await cacheExists()) {
          const variantPattern = new RegExp(`^${tag}[a-f0-9]{48}\\.mp4$`);
          for (const entry of await readdir(cacheDir)) {
            if (variantPattern.test(entry)) ids.add(entry.slice(0, 64));
          }
          for (const id of ids) {
            await unlink(path.join(cacheDir, `${id}.mp4`)).catch((error) => {
              if (error.code !== "ENOENT") throw error;
            });
          }
        }
        const previous = processedVideos;
        const hasStatus = Object.hasOwn(previous, key);
        if (hasStatus) {
          const next = { ...previous };
          delete next[key];
          // Persist first: a failed status write must not delete the source.
          await saveProcessed(next);
        }
        try {
          await unlink(path.join(folder, name));
        } catch (error) {
          if (hasStatus) await saveProcessed(previous);
          throw error;
        }
        for (const id of ids) downloadJobs.delete(id);
        return { deleted: { user, name } };
      });
    } finally {
      deletingVideos.delete(key);
    }
  }

  async function streamRequestToFile(req, tempPath, maxBytes, limitMessage) {
    let handle;
    let size = 0;
    try {
      handle = await open(
        tempPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW || 0),
        0o600,
      );
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          callback(size > maxBytes ? new HttpError(413, limitMessage) : null, chunk);
        },
      });
      // Do not put req in pipeline: destroying IncomingMessage would also destroy
      // its socket and prevent a useful JSON error when a streamed upload is too big.
      req.pipe(limiter);
      const onAborted = () =>
        limiter.destroy(new HttpError(400, "上传已取消。"));
      const onError = (error) => limiter.destroy(error);
      req.once("aborted", onAborted);
      req.once("error", onError);
      try {
        await pipeline(limiter, handle.createWriteStream());
      } finally {
        req.unpipe(limiter);
        req.off("aborted", onAborted);
        req.off("error", onError);
      }
      await handle.close();
      handle = null;
      if (!size) throw new HttpError(400, "不能上传空文件。");
      return size;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function publishUniqueFile(sourcePath, folder, name, kind = "文件名") {
    const ext = path.extname(name);
    const stem = name.slice(0, -ext.length);
    for (let attempt = 1; attempt <= 10000; attempt += 1) {
      const savedName = attempt === 1 ? name : `${stem}_${attempt}${ext}`;
      safeSegment(savedName, kind);
      try {
        await link(sourcePath, path.join(folder, savedName));
        return savedName;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (attempt === 10000)
          throw new HttpError(409, "同名文件过多，请更换文件名。");
      }
    }
  }

  async function saveExportSettings(req) {
    const body = await readJson(req, MAX_SETTINGS_BODY_BYTES);
    const rawSettings =
      isPlainObject(body) && "settings" in body ? body.settings : body;
    const next = validateExportSettings(rawSettings, { requireAssets: true });

    let pngBuf = null;
    let overlayScale = 3;
    if (
      isPlainObject(body) &&
      body.overlayPng !== undefined &&
      body.overlayPng !== null
    ) {
      if (typeof body.overlayPng !== "string" || !body.overlayPng.trim()) {
        throw new HttpError(400, "水印预览图像无效，请重试。");
      }
      let encoded = body.overlayPng.trim();
      if (encoded.startsWith("data:")) {
        if (!encoded.startsWith("data:image/png;base64,")) {
          throw new HttpError(400, "水印预览图像必须是 PNG 格式。");
        }
        encoded = encoded.slice("data:image/png;base64,".length);
      }
      pngBuf = Buffer.from(encoded, "base64");
      try {
        await validateOverlay(pngBuf);
      } catch {
        throw new HttpError(400, "水印预览图像无效，请重试。");
      }
      overlayScale =
        typeof body.overlayScale === "number" &&
        Number.isFinite(body.overlayScale) &&
        body.overlayScale >= 0.1 &&
        body.overlayScale <= 4
          ? body.overlayScale
          : 3;
    }

    return updateSettings(async () => {
      if (next.music.file) {
        try {
          const opened = await openMusic(next.music.file);
          await opened.handle.close().catch(() => {});
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) {
            throw new HttpError(400, "所选背景音乐文件不存在，请重新选择。");
          }
          throw error;
        }
      }

      const wmHash = watermarkConfigHash(next.watermark);
      await atomicWriteFile(
        settingsPath,
        JSON.stringify(next, null, 2) + "\n",
        "export-settings",
      );
      exportSettings = next;

      if (next.watermark.enabled && next.watermark.text.trim() && pngBuf) {
        const meta = { hash: wmHash, scale: overlayScale };
        await atomicWriteFile(overlayPngPath, pngBuf, "watermark-overlay");
        await atomicWriteFile(
          overlayMetaPath,
          JSON.stringify(meta, null, 2) + "\n",
          "watermark-meta",
        );
        overlayMeta = meta;
      } else if (
        !next.watermark.enabled ||
        !overlayMeta ||
        overlayMeta.hash !== wmHash
      ) {
        await unlink(overlayPngPath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        await unlink(overlayMetaPath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        overlayMeta = null;
      }

      return { settings: exportSettings };
    });
  }

  async function uploadMusic(req, url, res) {
    const originalName = safeSegment(url.searchParams.get("name"), "音频文件名");
    const extension = path.extname(originalName).toLowerCase();
    if (extension !== ".mp3") {
      throw new HttpError(415, "仅支持上传 MP3 背景音乐。");
    }
    const declaredLength = req.headers["content-length"];
    if (
      declaredLength !== undefined &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxMusicBytes)
    ) {
      throw new HttpError(413, "背景音乐超过大小限制。");
    }
    const folder = await musicFolder(true);
    const tempPath = path.join(folder, `.upload-${randomUUID()}.part`);
    const controller = new AbortController();
    const onClosed = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", onClosed);
    try {
      await streamRequestToFile(
        req,
        tempPath,
        maxMusicBytes,
        "背景音乐超过大小限制。",
      );
      let meta;
      try {
        controller.signal.throwIfAborted();
        const source = await open(
          tempPath,
          constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
        );
        try {
          meta = await inspectMusic({
            handle: source,
            signal: controller.signal,
          });
        } finally {
          await source.close();
        }
        controller.signal.throwIfAborted();
      } catch (error) {
        if (error instanceof HttpError) throw error;
        console.error("MP3 检查失败:", error.message);
        throw new HttpError(422, "无法读取 MP3 文件，请检查文件是否损坏或使用标准 MP3 格式。");
      }
      await musicFolder(false);
      const baseName = safeSegment(`${path.parse(originalName).name}.mp3`, "音频文件名");
      const savedName = await publishUniqueFile(tempPath, folder, baseName, "音频文件名");
      const info = await lstat(path.join(folder, savedName));
      const cacheKey = `${savedName}:${info.size}:${info.mtimeMs}:${info.ino}`;
      musicDurationCache.set(cacheKey, meta?.duration ?? null);
      return {
        track: {
          name: savedName,
          size: info.size,
          duration: meta?.duration ?? null,
          url: `/music/${encodeURIComponent(savedName)}`,
        },
      };
    } finally {
      res.off("close", onClosed);
      await unlink(tempPath).catch((error) => {
        if (error.code !== "ENOENT")
          console.error("临时音频清理失败:", error.message);
      });
    }
  }

  async function deleteMusicTrack(req) {
    const body = await readJson(req);
    const name = safeSegment(body?.name, "音频文件名");
    if (path.extname(name).toLowerCase() !== ".mp3") {
      throw new HttpError(404, "背景音乐不存在。");
    }
    if (deletingMusic.has(name)) {
      throw new HttpError(409, "背景音乐正在删除，请稍后重试。");
    }
    if (
      musicReaders.has(name) ||
      [...downloadJobs.values()].some(
        (job) =>
          job.musicFile === name && ["queued", "processing"].includes(job.status),
      )
    ) {
      throw new HttpError(409, "背景音乐正在用于处理下载，请等待完成后再删除。");
    }
    deletingMusic.add(name);
    try {
      return await updateSettings(async () => {
        const opened = await openMusic(name);
        await opened.handle.close().catch(() => {});
        const previousSettings = exportSettings;
        const clearsSelected = previousSettings.music.file === name;
        if (clearsSelected) {
          const next = {
            ...previousSettings,
            music: { ...previousSettings.music, file: "", enabled: false },
          };
          await atomicWriteFile(
            settingsPath,
            JSON.stringify(next, null, 2) + "\n",
            "export-settings",
          );
          exportSettings = next;
        }
        try {
          await unlink(opened.filePath);
        } catch (error) {
          if (clearsSelected) {
            await atomicWriteFile(
              settingsPath,
              JSON.stringify(previousSettings, null, 2) + "\n",
              "export-settings",
            ).catch(() => {});
            exportSettings = previousSettings;
          }
          throw error;
        }
        for (const [id, job] of downloadJobs) {
          if (job.musicFile === name) downloadJobs.delete(id);
        }
        return { deleted: { name }, settings: exportSettings };
      });
    } finally {
      deletingMusic.delete(name);
    }
  }

  async function upload(req, url, res) {
    const user = url.searchParams.get("user");
    const originalName = safeSegment(url.searchParams.get("name"));
    const extension = path.extname(originalName).toLowerCase();
    if (!VIDEO_TYPES.has(extension))
      throw new HttpError(415, "仅支持 MP4、WebM、MOV 和 M4V 视频。");
    const dateOverride = url.searchParams.get("date");
    if (dateOverride !== null && !validDate(dateOverride))
      throw new HttpError(400, "日期无效，请使用 YYYY-MM-DD。");
    const date = dateOverride || filenameDate(originalName) || localDate();
    const suffix = originalName.replace(/^\d{8}_/, "");
    let name = safeSegment(`${date.replaceAll("-", "")}_${suffix}`);
    const folder = await userFolder(user);
    const declaredLength = req.headers["content-length"];
    if (
      declaredLength !== undefined &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxUploadBytes)
    ) {
      throw new HttpError(413, "视频超过上传大小限制。");
    }
    const tempPath = path.join(folder, `.upload-${randomUUID()}.part`);
    const convertedPath = path.join(folder, `.convert-${randomUUID()}.part`);
    const controller = new AbortController();
    const onClosed = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", onClosed);
    let savedName;
    try {
      await streamRequestToFile(
        req,
        tempPath,
        maxUploadBytes,
        "视频超过上传大小限制。",
      );
      let publishPath = tempPath;
      try {
        const result = await scheduleConversion(async () => {
          controller.signal.throwIfAborted();
          const source = await open(tempPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
          try {
            return await convertVideo({ handle: source, outputPath: convertedPath, signal: controller.signal });
          } finally {
            await source.close();
          }
        });
        controller.signal.throwIfAborted();
        if (result.converted) {
          publishPath = convertedPath;
        }
        name = safeSegment(`${path.parse(name).name}.mp4`);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        console.error("上传转码失败:", error.message);
        throw new HttpError(422, "视频无法转为 H.264 MP4，请检查文件是否损坏或使用其他素材。");
      }
      await userFolder(user); // Re-check the destination before publishing.
      savedName = await publishUniqueFile(publishPath, folder, name);
      const info = await lstat(path.join(folder, savedName));
      return { video: videoMetadata(user, savedName, info) };
    } finally {
      res.off("close", onClosed);
      await unlink(convertedPath).catch(() => {});
      await unlink(tempPath).catch((error) => {
        if (error.code !== "ENOENT")
          console.error("临时文件清理失败:", error.message);
      });
    }
  }

  async function streamFile(req, res, filePath, contentType, downloadName, expectedInfo) {
    let handle;
    try {
      handle = await open(
        filePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
      );
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code))
        throw new HttpError(404, "文件不存在。");
      throw error;
    }
    const info = await handle.stat();
    if (expectedInfo && ["dev", "ino", "size", "mtimeMs", "ctimeMs"].some((key) => info[key] !== expectedInfo[key])) {
      await handle.close();
      throw new HttpError(409, "源文件发生变化，请重新准备下载。");
    }
    if (!info.isFile()) {
      await handle.close();
      throw new HttpError(404, "文件不存在。");
    }
    const headers = {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
      "Last-Modified": info.mtime.toUTCString(),
    };
    if (downloadName)
      headers["Content-Disposition"] = attachmentName(downloadName);
    let start = 0;
    let end = info.size - 1;
    let status = 200;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        if (match[1]) {
          start = Number(match[1]);
          end = match[2] ? Math.min(Number(match[2]), end) : end;
        } else {
          const suffix = Number(match[2]);
          start = Math.max(0, info.size - suffix);
        }
      }
      if (
        !match ||
        (!match[1] && !match[2]) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= info.size
      ) {
        await handle.close();
        res.writeHead(416, {
          ...headers,
          "Content-Range": `bytes */${info.size}`,
          "Content-Length": 0,
        });
        res.end();
        return;
      }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
    }
    headers["Content-Length"] = info.size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === "HEAD" || info.size === 0) {
      await handle.close();
      res.end();
      return;
    }
    try {
      await pipeline(
        handle.createReadStream({ start, end, autoClose: true }),
        res,
      );
    } catch (error) {
      if (error.code !== "ERR_STREAM_PREMATURE_CLOSE" && !res.destroyed)
        throw error;
    }
  }

  const allowedHosts = new Set([
    "localhost",
    "127.0.0.1",
    "::1",
    host.toLowerCase(),
    ...additionalHosts,
  ]);
  if (host === "0.0.0.0" || host === "::") {
    for (const interfaces of Object.values(networkInterfaces())) {
      for (const item of interfaces || [])
        allowedHosts.add(item.address.toLowerCase());
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    try {
      let authority;
      try {
        authority = new URL(`http://${req.headers.host || ""}`);
      } catch {
        throw new HttpError(400, "Host 无效。");
      }
      const hostname = authority.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      const serverPort = String(server.address()?.port || 80);
      if (
        !allowedHosts.has(hostname) ||
        (authority.port || "80") !== serverPort ||
        authority.username ||
        authority.password
      ) {
        throw new HttpError(403, "此 Host 不允许访问。");
      }
      const url = new URL(req.url, authority.origin);
      if (!["GET", "HEAD", "POST", "PUT", "DELETE"].includes(req.method))
        throw new HttpError(405, "请求方法不支持。");
      if (["POST", "PUT", "DELETE"].includes(req.method)) {
        const origin = req.headers.origin;
        const fetchSite = req.headers["sec-fetch-site"];
        if (
          (origin && origin !== authority.origin) ||
          (fetchSite && !["same-origin", "none"].includes(fetchSite))
        ) {
          throw new HttpError(403, "不允许跨站写入。请从本网站操作。");
        }
      }
      if (url.pathname === "/api/library" && req.method === "GET") {
        json(res, 200, await library());
        return;
      }
      if (url.pathname === "/api/export-settings" && req.method === "GET") {
        json(res, 200, {
          settings: exportSettings,
          music: await listMusic(),
          maxMusicBytes,
        });
        return;
      }
      if (url.pathname === "/api/export-settings" && req.method === "PUT") {
        json(res, 200, await saveExportSettings(req));
        return;
      }
      if (url.pathname === "/api/music" && req.method === "GET") {
        json(res, 200, { music: await listMusic(), maxMusicBytes });
        return;
      }
      if (url.pathname === "/api/music" && req.method === "POST") {
        json(res, 201, await uploadMusic(req, url, res));
        return;
      }
      if (url.pathname === "/api/music" && req.method === "DELETE") {
        json(res, 200, await deleteMusicTrack(req));
        return;
      }
      if (url.pathname === "/api/users" && req.method === "POST") {
        const body = await readJson(req);
        const name = safeSegment(body?.name, "用户名");
        await userFolder(name, true);
        json(res, 201, { user: { name } });
        return;
      }
      if (url.pathname === "/api/upload" && req.method === "POST") {
        json(res, 201, await upload(req, url, res));
        return;
      }
      if (url.pathname === "/api/downloads" && req.method === "POST") {
        const data = await createDownload(req);
        json(res, data.job.status === "ready" ? 200 : 202, data);
        return;
      }
      const downloadMatch = /^\/api\/downloads\/([a-f0-9]{64})(\/file)?$/.exec(url.pathname);
      if (downloadMatch && ["GET", "HEAD"].includes(req.method)) {
        const job = downloadJobs.get(downloadMatch[1]);
        if (!job) throw new HttpError(404, "下载任务已过期，请重新下载。");
        if (!downloadMatch[2]) {
          json(res, 200, { job: jobData(job) });
          return;
        }
        if (job.status !== "ready") throw new HttpError(409, "视频尚未准备完成。");
        if (await realpath(job.filePath).catch(() => null) !== job.filePath)
          throw new HttpError(404, "下载文件不存在，请重新准备下载。");
        if (!job.sourceInfo) await utimes(job.filePath, new Date(), new Date());
        await streamFile(req, res, job.filePath, "video/mp4", job.name, job.sourceInfo);
        return;
      }
      if (url.pathname === "/api/processed" && req.method === "POST") {
        json(res, 200, await setProcessed(req));
        return;
      }
      if (url.pathname === "/api/videos" && req.method === "DELETE") {
        json(res, 200, await deleteVideo(req));
        return;
      }
      if (
        url.pathname.startsWith("/music/") &&
        ["GET", "HEAD"].includes(req.method)
      ) {
        let segments;
        try {
          segments = url.pathname.slice(7).split("/").map(decodeURIComponent);
        } catch {
          throw new HttpError(400, "文件地址编码无效。");
        }
        if (segments.length !== 1) throw new HttpError(400, "文件地址无效。");
        const [name] = segments;
        safeSegment(name, "音频文件名");
        if (path.extname(name).toLowerCase() !== ".mp3") {
          throw new HttpError(404, "背景音乐不存在。");
        }
        const folder = await musicFolder(false);
        if (!folder) throw new HttpError(404, "背景音乐不存在。");
        await streamFile(req, res, path.join(folder, name), "audio/mpeg");
        return;
      }
      if (
        url.pathname.startsWith("/media/") &&
        ["GET", "HEAD"].includes(req.method)
      ) {
        let segments;
        try {
          segments = url.pathname.slice(7).split("/").map(decodeURIComponent);
        } catch {
          throw new HttpError(400, "文件地址编码无效。");
        }
        if (segments.length !== 2) throw new HttpError(400, "文件地址无效。");
        const [user, name] = segments;
        safeSegment(name);
        const contentType = VIDEO_TYPES.get(path.extname(name).toLowerCase());
        if (!contentType) throw new HttpError(404, "视频不存在。");
        const folder = await userFolder(user);
        await streamFile(
          req,
          res,
          path.join(folder, name),
          contentType,
          url.searchParams.get("download") === "1" ? name : null,
        );
        return;
      }
      if (
        ["GET", "HEAD"].includes(req.method) &&
        !url.pathname.startsWith("/api/")
      ) {
        let asset = [
          "/",
          "/upload",
          "/upload/",
          "/manage",
          "/manage/",
          "/manage/export",
          "/manage/export/",
        ].includes(url.pathname)
          ? "index.html"
          : url.pathname.slice(1);
        try {
          asset = decodeURIComponent(asset);
        } catch {
          throw new HttpError(400, "文件地址编码无效。");
        }
        const parts = asset.split("/");
        for (const part of parts) safeSegment(part);
        const contentType = ASSET_TYPES.get(path.extname(asset).toLowerCase());
        if (!contentType) throw new HttpError(404, "页面不存在。");
        const target = path.join(publicDir, ...parts);
        // Ensure intermediate directories cannot escape through a symlink.
        let resolved;
        try {
          resolved = await realpath(target);
        } catch (error) {
          if (error.code === "ENOENT") throw new HttpError(404, "页面不存在。");
          throw error;
        }
        if (resolved !== target) throw new HttpError(404, "页面不存在。");
        await streamFile(req, res, target, contentType);
        return;
      }
      throw new HttpError(404, "接口不存在。");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      json(res, status, {
        error:
          status === 500
            ? "服务器暂时无法处理请求，请查看终端日志。"
            : error.message,
      });
      if (!req.complete && !req.destroyed) req.resume();
    }
  });
  // Video files can be large; clients may take up to an hour to finish a request.
  server.requestTimeout = 60 * 60 * 1000;
  server.headersTimeout = 60 * 1000;
  return server;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    loadProjectEnv();
    const { readR2Config, startR2Sync } = await import("./r2-runtime.mjs");
    const config = readR2Config();
    const host = process.env.HOST || DEFAULT_HOST;
    const port = Number(process.env.PORT || 8876);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("PORT 必须是 1 到 65535 之间的整数。");
    }
    const videoDir = path.resolve(process.env.VIDEO_DIR || path.join(PROJECT_DIR, "videos"));
    const server = await createVideoServer({ host, videoDir });
    let sync;
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => server.closeAllConnections(), 25_000);
      deadline.unref();
      await Promise.all([
        sync?.stop(),
        new Promise((resolve) => server.close(resolve)),
      ]);
      clearTimeout(deadline);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    server.on("error", (error) => {
      console.error(`启动失败：${error.message}`);
      process.exitCode = 1;
      void stop();
    });
    server.listen(port, host, () => {
      const displayHost = host.includes(":") ? `[${host}]` : host;
      console.log(`视频库已启动：http://${displayHost}:${port}`);
      console.log(`视频目录：${videoDir}`);
      console.log("按 Ctrl+C 停止。");
      try {
        sync = startR2Sync({ videoDir, config });
      } catch {
        console.error("R2 定时同步启动失败，请检查配置和依赖。");
        process.exitCode = 1;
        void stop();
      }
    });
  } catch (error) {
    console.error(`启动失败：${error.message}`);
    process.exitCode = 1;
  }
}
