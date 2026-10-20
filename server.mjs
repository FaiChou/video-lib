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
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
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
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const additionalHosts = parseAllowedHosts(
    options.allowedHosts ?? process.env.ALLOWED_HOSTS ?? "",
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

  async function upload(req, url) {
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
    const name = safeSegment(`${date.replaceAll("-", "")}_${suffix}`);
    const folder = await userFolder(user);
    const declaredLength = req.headers["content-length"];
    if (
      declaredLength !== undefined &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxUploadBytes)
    ) {
      throw new HttpError(413, "视频超过上传大小限制。");
    }
    const tempPath = path.join(folder, `.upload-${randomUUID()}.part`);
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
      await userFolder(user); // Re-check the destination before publishing.
      const ext = path.extname(name);
      const stem = name.slice(0, -ext.length);
      for (let attempt = 1; attempt <= 10000; attempt += 1) {
        savedName = attempt === 1 ? name : `${stem}_${attempt}${ext}`;
        safeSegment(savedName);
        try {
          await link(tempPath, path.join(folder, savedName));
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
      if (handle) await handle.close().catch(() => {});
      await unlink(tempPath).catch((error) => {
        if (error.code !== "ENOENT")
          console.error("临时文件清理失败:", error.message);
      });
    }
  }

  async function streamFile(req, res, filePath, contentType, downloadName) {
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
        json(res, 201, await upload(req, url));
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
  const host = process.env.HOST || "127.0.0.1";
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
