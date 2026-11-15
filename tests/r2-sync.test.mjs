import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { createR2Sync, validateManifest } from "../r2-sync.mjs";

const entry = (account = "selena", extra = {}) => ({
  account, file: "20261114_clip.mp4", date: "2026-11-14", size: 5,
  video_key: `${account}/v/20261114_clip.mp4`,
  cover_key: `${account}/p/20261114_clip.jpg`, ...extra,
});
const manifest = (videos) => ({ updated: "2026-11-15", count: videos.length, videos });
const object = (bytes, length = Buffer.byteLength(bytes)) => ({ Body: Readable.from([bytes]), ContentLength: length });

async function fixture(t, videos = [entry()], options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "r2-sync-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoDir = path.join(root, "videos");
  await mkdir(videoDir);
  const calls = [];
  const objects = new Map([["manifest.json", JSON.stringify(manifest(videos))]]);
  for (const video of videos) {
    objects.set(video.video_key, "video");
    if (video.cover_key) objects.set(video.cover_key, "jpeg");
  }
  const logs = [];
  const getObject = async (key, context) => {
    calls.push(key);
    if (options.getObject) return options.getObject(key, context, objects);
    if (!objects.has(key)) throw Object.assign(new Error("private credential detail"), { $metadata: { httpStatusCode: 404 } });
    const value = objects.get(key);
    return typeof value === "function" ? value(context) : object(value);
  };
  const args = { videoDir, getObject, logger: { info: (message) => logs.push(message) }, ...options.engine };
  return { root, videoDir, objects, calls, logs, args, sync: createR2Sync(args) };
}

test("syncs three users, raw bytes and covers, is idempotent and retains historical files", async (t) => {
  const f = await fixture(t, [entry("selena"), entry("granada"), entry("lili")]);
  await mkdir(path.join(f.videoDir, "selena"));
  await writeFile(path.join(f.videoDir, "selena", "old.mp4"), "historical");
  const first = await f.sync.run();
  assert.equal(first.status, "success");
  assert.equal(first.downloaded, 3);
  assert.equal(first.coversDownloaded, 3);
  for (const account of ["selena", "granada", "lili"]) {
    assert.equal(await readFile(path.join(f.videoDir, account, "20261114_clip.mp4"), "utf8"), "video");
    assert.equal(await readFile(path.join(f.videoDir, ".r2-covers", account, "20261114_clip.jpg"), "utf8"), "jpeg");
  }
  assert.equal(await readFile(path.join(f.videoDir, "selena", "old.mp4"), "utf8"), "historical");
  f.calls.length = 0;
  const second = await f.sync.run();
  assert.equal(second.skipped, 3);
  assert.equal(second.downloaded, 0);
  assert.deepEqual(f.calls, ["manifest.json"]);
  const status = JSON.parse(await readFile(path.join(f.videoDir, ".r2-sync-status.json"), "utf8"));
  assert.equal(status.finishedAt, second.finishedAt);
  assert.equal(status.status, "success");
  assert.equal((await readdir(f.videoDir)).includes(".r2-sync.lock"), false);
});

test("rejects short, long and header-mismatched bodies, preserves old file then repairs on retry", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.videoDir, "selena", "20261114_clip.mp4");
  await mkdir(path.dirname(target));
  await writeFile(target, "old");
  for (const response of [() => object("bad", 5), () => object("toolong", 5), () => object("video", 6)]) {
    f.objects.set(entry().video_key, response);
    const result = await f.sync.run();
    assert.equal(result.status, "partial");
    assert.equal(result.failed, 1);
    assert.equal(result.repaired, 0);
    assert.equal(await readFile(target, "utf8"), "old");
    assert.deepEqual(await readdir(path.dirname(target)), ["20261114_clip.mp4"]);
  }
  f.objects.set(entry().video_key, "video");
  const result = await f.sync.run();
  assert.equal(result.repaired, 1);
  assert.equal(await readFile(target, "utf8"), "video");
});

test("one failed object does not stop other users and raw SDK errors are never logged", async (t) => {
  const f = await fixture(t, [entry("selena"), entry("lili")]);
  f.objects.delete(entry().video_key);
  const result = await f.sync.run();
  assert.equal(result.status, "partial");
  assert.equal(result.downloaded, 1);
  assert.match(result.errors[0].message, /HTTP 404/);
  assert.doesNotMatch(f.logs.join(""), /private credential detail/);
  f.objects.set(entry().video_key, "video");
  const retry = await f.sync.run();
  assert.equal(retry.status, "success");
  assert.equal(retry.downloaded, 1);
  assert.equal(retry.skipped, 1);
});

test("cover failure is retried without re-downloading a completed video", async (t) => {
  const f = await fixture(t);
  f.objects.set(entry().cover_key, () => object("jp", 4));
  const first = await f.sync.run();
  assert.equal(first.downloaded, 1);
  assert.equal(first.status, "partial");
  assert.deepEqual(await readdir(path.join(f.videoDir, ".r2-covers", "selena")), []);
  f.objects.set(entry().cover_key, "jpeg");
  f.calls.length = 0;
  const retry = await f.sync.run();
  assert.equal(retry.status, "success");
  assert.equal(retry.coversDownloaded, 1);
  assert.deepEqual(f.calls, ["manifest.json", entry().cover_key]);
});

test("does not overwrite a same-name web upload or a changed repair target during download", async (t) => {
  for (const hasPrevious of [false, true]) {
    const f = await fixture(t);
    const user = path.join(f.videoDir, "selena");
    await mkdir(user);
    const target = path.join(user, entry().file);
    if (hasPrevious) await writeFile(target, "old");
    f.objects.set(entry().video_key, async () => {
      await writeFile(target, "new successful manual upload");
      return object("video");
    });
    const result = await f.sync.run();
    assert.equal(result.status, "partial");
    assert.equal(result.downloaded + result.repaired, 0);
    assert.match(result.errors[0].message, /保留本地文件/);
    assert.equal(await readFile(target, "utf8"), "new successful manual upload");
    assert.deepEqual(await readdir(user), [entry().file]);
  }
});

test("validates entire manifest before any video request or directory creation", async (t) => {
  const f = await fixture(t);
  const invalid = [
    entry("../outside"), entry("selena", { file: "../clip.mp4" }),
    entry("selena", { video_key: "lili/v/20261114_clip.mp4" }),
    entry("selena", { cover_key: "https://elsewhere/cover.jpg" }),
    entry("selena", { size: -1 }), entry("selena", { size: 2 ** 31 + 1 }),
    entry("selena", { date: "2026-02-30" }),
  ];
  for (const item of invalid) {
    f.objects.set("manifest.json", JSON.stringify(manifest([entry("granada"), item])));
    f.calls.length = 0;
    assert.equal((await f.sync.run()).status, "failed");
    assert.deepEqual(f.calls, ["manifest.json"]);
    assert.deepEqual(await readdir(f.videoDir), [".r2-sync-status.json"]);
  }
  assert.throws(() => validateManifest(manifest([entry(), entry()])));
  assert.throws(() => validateManifest({ ...manifest([]), count: 1 }));
});

test("rejects symlink user folders, destination files and cover roots", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret"), "secret");
  const user = path.join(f.videoDir, "selena");
  await symlink(outside, user);
  await symlink(outside, path.join(f.videoDir, ".r2-covers"));
  const first = await f.sync.run();
  assert.equal(first.failed, 2);
  assert.deepEqual(await readdir(outside), ["secret"]);
  await rm(user);
  await mkdir(user);
  await symlink(path.join(outside, "secret"), path.join(user, entry().file));
  assert.equal((await f.sync.run()).failed, 2);
  assert.equal(await readFile(path.join(outside, "secret"), "utf8"), "secret");
});

test("coalesces same-instance runs and excludes another instance until lock release", async (t) => {
  const f = await fixture(t);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.objects.set(entry().video_key, async () => {
    started.resolve();
    await release.promise;
    return object("video");
  });
  const first = f.sync.run();
  assert.equal(f.sync.run(), first);
  await started.promise;
  const second = createR2Sync(f.args);
  try {
    assert.equal((await second.run()).status, "skipped");
    assert.equal(f.calls.filter((key) => key === "manifest.json").length, 1);
  } finally { release.resolve(); }
  assert.equal((await first).status, "success");
  assert.equal((await second.run()).status, "success");
});

test("aborting a stalled body cleans temporary files and permits the next run", async (t) => {
  const f = await fixture(t);
  const started = Promise.withResolvers();
  f.objects.set(entry().video_key, () => {
    const Body = new Readable({ read() {} });
    Body.push("vi");
    started.resolve();
    return { Body, ContentLength: 5 };
  });
  const controller = new AbortController();
  const run = f.sync.run({ signal: controller.signal });
  await started.promise;
  controller.abort();
  const result = await run;
  assert.notEqual(result.status, "success");
  assert.deepEqual(await readdir(path.join(f.videoDir, "selena")), []);
  f.objects.set(entry().video_key, "video");
  assert.equal((await f.sync.run()).status, "success");
});

test("request deadline covers body streaming as well as response headers", async (t) => {
  const f = await fixture(t, [entry()], { engine: { objectTimeoutMs: 30 } });
  f.objects.set(entry().video_key, () => ({ Body: new Readable({ read() {} }), ContentLength: 5 }));
  // AbortSignal.timeout is unref'ed; keep the test alive while the mock stream waits.
  const timer = setTimeout(() => {}, 1000);
  try {
    const result = await f.sync.run();
    assert.equal(result.status, "partial");
    assert.match(result.errors[0].message, /超时/);
    assert.deepEqual(await readdir(path.join(f.videoDir, "selena")), []);
  } finally { clearTimeout(timer); }
});

test("cleans crash leftovers under the lock without touching web uploads or codec temp files", async (t) => {
  const f = await fixture(t);
  const user = path.join(f.videoDir, "selena");
  await mkdir(user);
  const id = "12345678-1234-1234-1234-123456789012";
  await writeFile(path.join(user, `.r2-download-${id}.part`), "partial");
  await writeFile(path.join(user, `.upload-${id}.part`), "upload in progress");
  await writeFile(path.join(user, `.convert-${id}.part`), "conversion in progress");
  await writeFile(path.join(f.videoDir, `.r2-status-${id}.part`), "partial");
  assert.equal((await f.sync.run()).status, "success");
  assert.deepEqual((await readdir(user)).sort(), [`.convert-${id}.part`, `.upload-${id}.part`, entry().file].sort());
  assert.equal((await readdir(f.videoDir)).some((name) => name.endsWith(".part")), false);
});

test("synced VP9 is discoverable and served locally, and existing download conversion preserves it", async (t) => {
  const { createVideoServer } = await import("../server.mjs");
  const { once } = await import("node:events");
  const raw = await readFile(new URL("fixtures/vp9-opus.webm", import.meta.url));
  const video = entry("granada", { size: raw.length });
  const f = await fixture(t, [video]);
  f.objects.set(video.video_key, raw);
  assert.equal((await f.sync.run()).status, "success");
  const server = await createVideoServer({ videoDir: f.videoDir });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const library = await (await fetch(`${base}/api/library`)).json();
  assert.equal(library.videos.length, 1);
  assert.equal(library.videos[0].user, "granada");
  const response = await fetch(`${base}/media/granada/${video.file}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), raw);
  const prepared = await fetch(`${base}/api/downloads`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: "granada", name: video.file }),
  });
  let { job } = await prepared.json();
  for (let i = 0; i < 100 && job.status !== "ready" && job.status !== "failed"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    ({ job } = await (await fetch(`${base}/api/downloads/${job.id}`)).json());
  }
  assert.equal(job.status, "ready");
  assert.equal((await fetch(`${base}${job.downloadUrl}`)).status, 200);
  assert.deepEqual(await readFile(path.join(f.videoDir, "granada", video.file)), raw);
});
