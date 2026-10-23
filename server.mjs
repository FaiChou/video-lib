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
import { isCompatibleVideo, normalizeVideo } from "./media-converter.mjs";

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOST = "0.0.0.0";
const MAX_LIMIT = 2 * 1024 * 1024 * 1024;
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

async function readJson(req) {
  if (
    !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")
  ) {
    throw new HttpError(415, "请使用 application/json 提交。");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw new HttpError(413, "请求内容过大。");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "JSON 格式无效。");
  }
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
  const convertVideo = options.normalizeVideo ?? normalizeVideo;
  const inspectVideo = options.isCompatibleVideo ?? isCompatibleVideo;
  const downloadJobs = new Map();
  const downloadChecks = new Map();
  const cacheDir = path.join(videoDir, ".transcoded");
  const cacheLifetime = 7 * 24 * 60 * 60 * 1000;
  let conversionTail = Promise.resolve();
  let pendingConversions = 0;

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

  async function createDownload(req) {
    const body = await readJson(req);
    const user = safeSegment(body?.user, "用户名");
    const name = safeSegment(body?.name);
    const { handle, info } = await openVideo(user, name);
    const id = createHash("sha256").update(JSON.stringify([
      "h264-aac-v1", user, name, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs,
    ])).digest("hex");
    let transferred = false;
    try {
      // Coalesce concurrent checks before probing or submitting a conversion.
      // Each request still closes its own file handle unless the queue owns it.
      if (downloadChecks.has(id))
        return { job: jobData(await downloadChecks.get(id)) };
      const check = (async () => {
        const existing = downloadJobs.get(id);
        if (existing && ["queued", "processing"].includes(existing.status)) return existing;

        const target = path.join(cacheDir, `${id}.mp4`);
        const job = {
          id, status: "ready", progress: 1, name: `${path.parse(name).name}.mp4`,
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
          if (compatible) {
            job.filePath = path.join(videoDir, user, name);
            job.sourceInfo = info;
          }
        }
        const sourceUnchanged = async () => {
          const after = await handle.stat();
          return ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) => after[key] === info[key]);
        };
        if (!await sourceUnchanged())
          throw new HttpError(409, "源文件发生变化，请重新下载。");

        // Keep a bounded status history. Cached files remain reusable after eviction.
        if (downloadJobs.size >= 200) {
          for (const [key, previous] of downloadJobs) {
            if (["ready", "failed"].includes(previous.status)) downloadJobs.delete(key);
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
            const { converted } = await convertVideo({
              handle,
              outputPath: tempPath,
              onProgress: (progress) => { job.progress = progress; },
            });
            if (!await sourceUnchanged())
              throw new Error("转码期间源文件发生变化，请重新下载。");
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
            await unlink(tempPath).catch(() => {});
          }
        });
        transferred = true;
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
      if (!transferred) await handle.close();
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

  async function setProcessed(req) {
    const body = await readJson(req);
    const user = safeSegment(body?.user, "用户名");
    const name = safeSegment(body?.name);
    if (typeof body?.processed !== "boolean")
      throw new HttpError(400, "处理状态必须是布尔值。");
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

    // Serialize read/modify/write operations so concurrent clicks cannot lose
    // another video's status. Publish memory only after the atomic file replace.
    const write = processedWrite.then(async () => {
      const next = { ...processedVideos, [`${user}/${name}`]: body.processed };
      const tempPath = path.join(videoDir, `.processed-${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(tempPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify(next, null, 2) + "\n");
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(tempPath, processedPath);
        processedVideos = next;
      } finally {
        if (handle) await handle.close().catch(() => {});
        await unlink(tempPath).catch((error) => {
          if (error.code !== "ENOENT")
            console.error("处理状态临时文件清理失败:", error.message);
        });
      }
      return { video: videoMetadata(user, name, info) };
    });
    processedWrite = write.catch(() => {});
    return write;
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
    let handle;
    let size = 0;
    let savedName;
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
          callback(
            size > maxUploadBytes
              ? new HttpError(413, "视频超过上传大小限制。")
              : null,
            chunk,
          );
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
      const ext = path.extname(name);
      const stem = name.slice(0, -ext.length);
      for (let attempt = 1; attempt <= 10000; attempt += 1) {
        savedName = attempt === 1 ? name : `${stem}_${attempt}${ext}`;
        safeSegment(savedName);
        try {
          await link(publishPath, path.join(folder, savedName));
          break;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          if (attempt === 10000)
            throw new HttpError(409, "同名文件过多，请更换文件名。");
        }
      }
      const info = await lstat(path.join(folder, savedName));
      return { video: videoMetadata(user, savedName, info) };
    } finally {
      res.off("close", onClosed);
      if (handle) await handle.close().catch(() => {});
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
      if (!["GET", "HEAD", "POST"].includes(req.method))
        throw new HttpError(405, "请求方法不支持。");
      if (req.method === "POST") {
        const origin = req.headers.origin;
        const fetchSite = req.headers["sec-fetch-site"];
        if (
          (origin && origin !== authority.origin) ||
          (fetchSite && !["same-origin", "none"].includes(fetchSite))
        ) {
          throw new HttpError(403, "不允许跨站写入。请从本网站上传。");
        }
      }
      if (url.pathname === "/api/library" && req.method === "GET") {
        json(res, 200, await library());
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
        let asset = ["/", "/upload", "/upload/"].includes(url.pathname)
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
  const host = process.env.HOST || DEFAULT_HOST;
  const port = Number(process.env.PORT || 8876);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("PORT 必须是 1 到 65535 之间的整数。");
    process.exitCode = 1;
  } else {
    try {
      const server = await createVideoServer({ host });
      server.on("error", (error) => {
        console.error(`启动失败：${error.message}`);
        process.exitCode = 1;
      });
      server.listen(port, host, () => {
        const displayHost = host.includes(":") ? `[${host}]` : host;
        console.log(`视频库已启动：http://${displayHost}:${port}`);
        console.log(
          `视频目录：${path.resolve(process.env.VIDEO_DIR || path.join(PROJECT_DIR, "videos"))}`,
        );
        console.log("按 Ctrl+C 停止。");
      });
    } catch (error) {
      console.error(`启动失败：${error.message}`);
      process.exitCode = 1;
    }
  }
}
