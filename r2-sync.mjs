import path from "node:path";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, realpath, lstat, readdir, open, link, rename, unlink } from "node:fs/promises";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import lockfile from "proper-lockfile";

const MAX_VIDEO_BYTES = 2 * 1024 ** 3;
const MAX_COVER_BYTES = 20 * 1024 ** 2;
const MAX_MANIFEST_BYTES = 10 * 1024 ** 2;
const EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v"]);

class SyncError extends Error {}

function segment(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim() &&
    !value.startsWith(".") && !value.endsWith(".") && Buffer.byteLength(value) <= 240 &&
    !/[\x00-\x1f\x7f<>:"/\\|?*]/u.test(value);
}

function dateString(value) {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Validate the whole manifest before writing anything. Keys are exact paths,
// never URLs or local paths supplied by the remote manifest.
export function validateManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.videos) ||
      !Number.isSafeInteger(manifest.count) || manifest.count !== manifest.videos.length ||
      !dateString(manifest.updated)) throw new SyncError("manifest 的日期、条数或 videos 无效");
  const seen = new Set();
  for (const item of manifest.videos) {
    if (!item || !segment(item.account) || Buffer.byteLength(item.account) > 120 ||
        !segment(item.file) || !EXTENSIONS.has(path.extname(item.file).toLowerCase()) ||
        !dateString(item.date) || !item.file.startsWith(`${item.date.replaceAll("-", "")}_`) ||
        !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > MAX_VIDEO_BYTES ||
        item.video_key !== `${item.account}/v/${item.file}` ||
        (item.cover_key != null && item.cover_key !== `${item.account}/p/${path.parse(item.file).name}.jpg`)) {
      throw new SyncError("manifest 含无效的视频路径、日期或大小");
    }
    if (seen.has(item.video_key)) throw new SyncError("manifest 含重复的视频");
    seen.add(item.video_key);
  }
  return manifest;
}

async function statOrNull(target) {
  return lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function directory(parent, name) {
  const target = path.join(parent, name);
  await mkdir(target).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(target) !== target)
    throw new SyncError("同步目录必须是真实目录，不能是符号链接");
  return target;
}

async function regularFile(target) {
  const info = await statOrNull(target);
  if (info && (!info.isFile() || info.isSymbolicLink()))
    throw new SyncError("目标不是普通文件，已跳过");
  return info;
}

function safeError(error) {
  if (error instanceof SyncError) return error.message;
  if (["AbortError", "TimeoutError"].includes(error?.name)) return "同步已取消或请求超时，下次重试";
  const status = error?.$metadata?.httpStatusCode;
  if (Number.isInteger(status)) return `R2 请求失败（HTTP ${status}）`;
  const codes = {
    ENOSPC: "本地磁盘空间不足", EACCES: "本地目录没有读写权限", EPERM: "本地文件操作被拒绝",
    ECONNREFUSED: "连接被拒绝，请检查网络或代理", ECONNRESET: "网络连接中断", ENOTFOUND: "无法解析 R2 或代理地址",
    ETIMEDOUT: "网络连接超时", ELOCKED: "另一个同步任务正在运行",
  };
  // Never log raw SDK/agent errors: they can contain signed URLs or proxy auth.
  return codes[error?.code] || "同步失败，请检查网络、R2 权限和本地目录";
}

function limitedStream(max, onBytes) {
  let total = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      total += chunk.length;
      if (total > max) return callback(new SyncError("下载大小超过预期，文件未入库"));
      onBytes(total);
      callback(null, chunk);
    },
  });
}

export function createR2Sync({
  videoDir, getObject, manifestKey = "manifest.json", logger = console,
  objectTimeoutMs = 15 * 60 * 1000,
}) {
  let running;

  async function execute({ signal } = {}) {
    const startedAt = new Date().toISOString();
    const summary = {
      status: "success", startedAt, finishedAt: null,
      downloaded: 0, skipped: 0, repaired: 0, coversDownloaded: 0, failed: 0, errors: [],
    };
    const controller = new AbortController();
    const runSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let root;
    let release;
    const cleanedFolders = new Set();
    const fail = (key, error) => {
      summary.failed++;
      if (summary.errors.length < 100) summary.errors.push({ key, message: safeError(error) });
    };
    const requestSignal = () => AbortSignal.any([runSignal, AbortSignal.timeout(objectTimeoutMs)]);

    async function cleanInterruptedFiles(folder) {
      if (cleanedFolders.has(folder)) return;
      // A crash may leave a partial file. Only the exclusive lock holder can
      // remove our own temporary names, never web uploads or codec output.
      for (const name of await readdir(folder)) {
        if (!/^\.r2-(?:download|status)-[a-f0-9-]{36}\.part$/.test(name)) continue;
        const target = path.join(folder, name);
        if ((await statOrNull(target))?.isFile()) await unlink(target);
      }
      cleanedFolders.add(folder);
    }

    async function readManifest() {
      const signal = requestSignal();
      const response = await getObject(manifestKey, { signal });
      try {
        if (response.ContentLength > MAX_MANIFEST_BYTES) throw new SyncError("manifest 超过 10 MiB 限制");
        if (!response.Body) throw new SyncError("R2 返回空 manifest");
        const chunks = [];
        await pipeline(response.Body, limitedStream(MAX_MANIFEST_BYTES, () => {}), new Writable({
          write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
        }), { signal });
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw new SyncError("manifest 不是有效 JSON"); }
        return validateManifest(parsed);
      } finally { response.Body?.destroy(); }
    }

    async function download(key, folder, filename, expectedSize, maxBytes) {
      await cleanInterruptedFiles(folder);
      const target = path.join(folder, filename);
      const previous = await regularFile(target);
      // Covers have no size in the manifest. A cover only becomes visible after
      // a complete download checked against S3 Content-Length.
      if (previous && (expectedSize === undefined ? previous.size > 0 : previous.size === expectedSize)) return "skipped";
      const temp = path.join(folder, `.r2-download-${randomUUID()}.part`);
      const signal = requestSignal();
      let handle;
      let response;
      try {
        response = await getObject(key, { signal });
        const length = response.ContentLength;
        if (!Number.isSafeInteger(length) || length <= 0 || length > maxBytes ||
            (expectedSize !== undefined && length !== expectedSize))
          throw new SyncError("R2 对象大小与预期不符，文件未入库");
        if (!response.Body) throw new SyncError("R2 返回空文件");
        handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o640);
        let bytes = 0;
        await pipeline(response.Body, limitedStream(length, (total) => { bytes = total; }),
          handle.createWriteStream(), { signal });
        handle = null;
        if (bytes !== length) throw new SyncError("下载不完整，文件未入库");
        handle = await open(temp, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        await handle.sync();
        await handle.close();
        handle = null;
        runSignal.throwIfAborted();
        if (await realpath(folder) !== folder) throw new SyncError("同步目录已变化，文件未入库");
        if (previous) {
          const current = await regularFile(target);
          if (!current || ["dev", "ino", "size", "mtimeMs", "ctimeMs"].some((key) => current[key] !== previous[key]))
            throw new SyncError("下载期间本地文件已变化，保留本地文件，本次不覆盖");
          await rename(temp, target);
        } else {
          // The web uploader also uses link(): whichever publishes first wins.
          // rename() here would overwrite a successful concurrent web upload.
          try { await link(temp, target); }
          catch (error) {
            if (error.code === "EEXIST") throw new SyncError("下载期间出现同名本地文件，保留本地文件，本次不覆盖");
            throw error;
          }
        }
        return previous ? "repaired" : "downloaded";
      } finally {
        response?.Body?.destroy();
        await handle?.close().catch(() => {});
        await unlink(temp).catch((error) => { if (error.code !== "ENOENT") throw error; });
      }
    }

    try {
      runSignal.throwIfAborted();
      await mkdir(path.resolve(videoDir), { recursive: true });
      root = await realpath(path.resolve(videoDir));
      const lockPath = path.join(root, ".r2-sync.lock");
      if ((await statOrNull(lockPath))?.isSymbolicLink()) throw new SyncError("同步锁不能是符号链接");
      try {
        release = await lockfile.lock(root, {
          lockfilePath: lockPath, stale: 60_000, update: 10_000, retries: 0,
          onCompromised: () => controller.abort(new SyncError("同步锁已失效，本次同步停止")),
        });
      } catch (error) {
        if (error.code !== "ELOCKED") throw error;
        summary.status = "skipped";
        summary.finishedAt = new Date().toISOString();
        logger.info("[R2] 已有同步任务运行，本次跳过");
        return summary;
      }
      await cleanInterruptedFiles(root);
      const manifest = await readManifest();
      summary.manifestUpdated = manifest.updated;
      summary.total = manifest.videos.length;
      for (const item of manifest.videos) {
        runSignal.throwIfAborted();
        try {
          const folder = await directory(root, item.account);
          const result = await download(item.video_key, folder, item.file, item.size, MAX_VIDEO_BYTES);
          summary[result]++;
        } catch (error) { fail(item.video_key, error); }
        if (item.cover_key && !runSignal.aborted) {
          try {
            const covers = await directory(root, ".r2-covers");
            const folder = await directory(covers, item.account);
            const result = await download(item.cover_key, folder, `${path.parse(item.file).name}.jpg`, undefined, MAX_COVER_BYTES);
            if (result !== "skipped") summary.coversDownloaded++;
          } catch (error) { fail(item.cover_key, error); }
        }
      }
      if (summary.failed) summary.status = "partial";
    } catch (error) {
      summary.status = "failed";
      fail("sync", error);
    } finally {
      summary.finishedAt = new Date().toISOString();
      // Only the lock holder writes status. Temp + rename avoids torn JSON and
      // does not follow an existing status-file symlink.
      if (release) {
        const temp = path.join(root, `.r2-status-${randomUUID()}.part`);
        try {
          const handle = await open(temp, "wx", 0o600);
          try { await handle.writeFile(`${JSON.stringify(summary, null, 2)}\n`); }
          finally { await handle.close(); }
          await rename(temp, path.join(root, ".r2-sync-status.json"));
        } catch (error) {
          summary.status = "failed";
          fail("status", error);
        } finally {
          await unlink(temp).catch(() => {});
          await release().catch(() => {});
        }
      }
      if (summary.status !== "skipped") logger.info(`[R2] ${JSON.stringify(summary)}`);
    }
    return summary;
  }

  return {
    // Coalesce startup, scheduled runs and callers within this process.
    run(options) {
      running ??= execute(options).finally(() => { running = undefined; });
      return running;
    },
  };
}
