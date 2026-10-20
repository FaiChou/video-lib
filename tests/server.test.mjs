import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
} from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createVideoServer } from "../server.mjs";

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-library-test-"));
  const videoDir = path.join(root, "videos");
  const publicDir = path.join(root, "public");
  await mkdir(videoDir);
  await mkdir(publicDir);
  await writeFile(path.join(publicDir, "index.html"), "<h1>video library</h1>");
  const server = await createVideoServer({
    videoDir,
    publicDir,
    timeZone: "Asia/Shanghai",
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, videoDir, publicDir, server, base };
}

async function createUser(base, name, extraHeaders = {}) {
  return fetch(`${base}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({ name }),
  });
}

async function upload(base, user, name, body = "video bytes", date) {
  const query = new URLSearchParams({
    user,
    name,
    ...(date === undefined ? {} : { date }),
  });
  return fetch(`${base}/api/upload?${query}`, { method: "POST", body });
}

test("library discovers only supported real videos, sorts by date and uses Shanghai mtime fallback", async (t) => {
  const { base, videoDir, root } = await fixture(t);
  await mkdir(path.join(videoDir, "selena"));
  await mkdir(path.join(videoDir, "granada"));
  for (const name of [
    "20260813_clip.mp4",
    "20261005_recent.MP4",
    "20260230_invalid.mp4",
    "plain.webm",
  ]) {
    await writeFile(path.join(videoDir, "selena", name), "1234567890");
  }
  await writeFile(path.join(videoDir, "selena", "readme.txt"), "ignore");
  const mtime = new Date("2026-09-01T17:00:00Z");
  for (const name of ["20260230_invalid.mp4", "plain.webm"])
    await utimes(path.join(videoDir, "selena", name), mtime, mtime);
  await writeFile(path.join(root, "secret.mp4"), "not exposed");
  await symlink(
    path.join(root, "secret.mp4"),
    path.join(videoDir, "selena", "20261020_link.mp4"),
  );
  await symlink(path.join(videoDir, "selena"), path.join(videoDir, "alias"));
  const response = await fetch(`${base}/api/library`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.users, [
    { name: "granada", count: 0 },
    { name: "selena", count: 4 },
  ]);
  assert.deepEqual(
    result.videos.map((video) => video.date),
    ["2026-10-05", "2026-09-02", "2026-09-02", "2026-08-13"],
  );
  assert.equal(result.videos[1].dateSource, "modified");
  assert.equal(result.videos[0].dateSource, "filename");
  assert.equal(result.videos[0].size, 10);
  assert.match(result.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(result.maxUploadBytes, 2147483648);
  assert.equal(result.timeZone, "Asia/Shanghai");
});

test("uploads preserve or replace valid dates, assign today, and never overwrite collisions", async (t) => {
  const { base, videoDir } = await fixture(t);
  assert.equal((await createUser(base, "小明")).status, 201);
  const first = await upload(base, "小明", "20260813_旅行.mp4", "first");
  assert.equal(first.status, 201);
  const firstVideo = (await first.json()).video;
  assert.equal(firstVideo.name, "20260813_旅行.mp4");
  const second = await upload(base, "小明", "20260813_旅行.mp4", "second");
  assert.equal(second.status, 201);
  assert.equal((await second.json()).video.name, "20260813_旅行_2.mp4");
  assert.equal(
    await readFile(path.join(videoDir, "小明", firstVideo.name), "utf8"),
    "first",
  );
  const overridden = await upload(
    base,
    "小明",
    "20260813_旅行.mp4",
    "override",
    "2026-10-20",
  );
  assert.equal((await overridden.json()).video.name, "20261020_旅行.mp4");
  const today = (await (await fetch(`${base}/api/library`)).json()).today;
  const noDate = await upload(base, "小明", "clip.mov");
  assert.equal(
    (await noDate.json()).video.name,
    `${today.replaceAll("-", "")}_clip.mov`,
  );
  const invalidDate = await upload(base, "小明", "20260230_clip.webm");
  assert.equal(
    (await invalidDate.json()).video.name,
    `${today.replaceAll("-", "")}_clip.webm`,
  );
  assert.equal(
    (await upload(base, "小明", "clip.mp4", "data", "2026-02-30")).status,
    400,
  );
  assert.equal((await upload(base, "小明", "clip.exe")).status, 415);
  assert.equal((await upload(base, "小明", "clip.mp4", "")).status, 400);
  assert.equal(
    (await readdir(path.join(videoDir, "小明"))).some((name) =>
      name.startsWith(".upload-"),
    ),
    false,
  );
});

test("media supports seeking, suffix ranges, HEAD and UTF-8 download filenames", async (t) => {
  const { base } = await fixture(t);
  await createUser(base, "selena");
  const video = (
    await (
      await upload(base, "selena", "20260813_旅行.mp4", "0123456789")
    ).json()
  ).video;
  const partial = await fetch(base + video.url, {
    headers: { Range: "bytes=2-5" },
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await partial.text(), "2345");
  const suffix = await fetch(base + video.url, {
    headers: { Range: "bytes=-3" },
  });
  assert.equal(await suffix.text(), "789");
  const head = await fetch(base + video.url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(await head.text(), "");
  for (const range of ["bytes=99-", "bytes=5-2", "bytes=-0", "bytes=0-1,4-5"]) {
    const invalid = await fetch(base + video.url, {
      headers: { Range: range },
    });
    assert.equal(invalid.status, 416, range);
    assert.equal(invalid.headers.get("content-range"), "bytes */10");
  }
  const download = await fetch(base + video.downloadUrl);
  assert.match(download.headers.get("content-disposition"), /^attachment;/);
  assert.match(
    download.headers.get("content-disposition"),
    /filename\*=UTF-8''/,
  );
  assert.equal(await download.text(), "0123456789");
});

test("rejects path escapes, symlinks, foreign mutations and unknown Host headers", async (t) => {
  const { base, root, videoDir, publicDir } = await fixture(t);
  for (const name of [
    "../outside",
    ".hidden",
    "foo/bar",
    "foo\\bar",
    "  name",
    "",
  ]) {
    assert.equal((await createUser(base, name)).status, 400, name);
  }
  assert.equal(
    (await createUser(base, "safe", { Origin: "https://attacker.example" }))
      .status,
    403,
  );
  assert.equal((await createUser(base, "safe", { Origin: base })).status, 201);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    http
      .get(
        `${base}/api/library`,
        { headers: { Host: "attacker.example" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      )
      .on("error", reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await upload(base, "safe", "../clip.mp4")).status, 400);
  assert.equal((await upload(base, "../safe", "clip.mp4")).status, 400);
  await writeFile(path.join(root, "secret.mp4"), "secret");
  await symlink(
    path.join(root, "secret.mp4"),
    path.join(videoDir, "safe", "link.mp4"),
  );
  await symlink(root, path.join(videoDir, "linked"));
  assert.equal((await fetch(`${base}/media/safe/link.mp4`)).status, 404);
  assert.equal((await fetch(`${base}/media/linked/secret.mp4`)).status, 400);
  assert.equal(
    (await fetch(`${base}/media/safe/%2E%2E%2Fsecret.mp4`)).status,
    400,
  );
  await symlink(root, path.join(publicDir, "outside"));
  assert.equal((await fetch(`${base}/outside/secret.mp4`)).status, 404);
  assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/upload`)).status, 200);
});

test("declared and streamed upload limits reject oversize files and clean partial files", async (t) => {
  const { base, videoDir } = await fixture(t, { maxUploadBytes: 5 });
  await createUser(base, "selena");
  assert.equal(
    (await upload(base, "selena", "large.mp4", "123456")).status,
    413,
  );
  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      `${base}/api/upload?user=selena&name=streamed.mp4`,
      { method: "POST" },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.write("123");
    req.end("456");
  });
  assert.equal(result.status, 413);
  assert.match(JSON.parse(result.body).error, /大小限制/);
  assert.deepEqual(await readdir(path.join(videoDir, "selena")), []);
});

test("configured public hosts allow matching origins without relaxing port or origin checks", async (t) => {
  const { base, server } = await fixture(t, {
    allowedHosts: " Videos.Example, 203.0.113.10, 2001:0db8:0:0:0:0:0:42 ",
  });
  const port = server.address().port;
  async function post(authority, origin = `http://${authority}`) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        `${base}/api/users`,
        {
          method: "POST",
          headers: {
            Host: authority,
            Origin: origin,
            "Content-Type": "application/json",
            "Sec-Fetch-Site": "same-origin",
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify({ name: "deployed-user" }));
    });
  }
  for (const hostname of ["videos.example", "203.0.113.10", "[2001:db8::42]"]) {
    assert.equal(await post(`${hostname}:${port}`), 201, hostname);
  }
  assert.equal(await post(`foreign.example:${port}`), 403);
  assert.equal(await post(`sub.videos.example:${port}`), 403);
  assert.equal(
    await post(`videos.example:${port}`, `http://foreign.example:${port}`),
    403,
  );
  assert.equal(
    await post(`videos.example:${port}`, `http://203.0.113.10:${port}`),
    403,
  );
  assert.equal(
    await post(`videos.example:${port === 8876 ? 8877 : 8876}`),
    403,
  );
});

test("invalid external host configuration fails at startup", async () => {
  for (const allowedHosts of [
    "https://videos.example",
    "videos.example:8876",
    "*.example",
    "videos.example/path",
    "videos.example,",
    "user@videos.example",
    "[2001:db8::1]",
    "bad..example",
    "203.0.113.999",
    42,
  ]) {
    await assert.rejects(
      createVideoServer({ allowedHosts }),
      /ALLOWED_HOSTS/,
      String(allowedHosts),
    );
  }
});

test("concurrent identical filenames get unique complete files", async (t) => {
  const { base, videoDir } = await fixture(t);
  await createUser(base, "selena");
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      upload(base, "selena", "20260813_clip.mp4", `content-${index}`),
    ),
  );
  const videos = await Promise.all(
    results.map(async (response) => {
      assert.equal(response.status, 201);
      return (await response.json()).video;
    }),
  );
  assert.equal(new Set(videos.map((video) => video.name)).size, 5);
  for (let index = 0; index < videos.length; index += 1) {
    assert.equal(
      await readFile(path.join(videoDir, "selena", videos[index].name), "utf8"),
      `content-${index}`,
    );
  }
});

test("an interrupted upload removes its partial file without publishing a video", async (t) => {
  const { base, videoDir } = await fixture(t);
  await createUser(base, "selena");
  const folder = path.join(videoDir, "selena");
  const request = http.request(
    `${base}/api/upload?user=selena&name=interrupted.mp4`,
    { method: "POST" },
  );
  request.on("error", () => {});
  request.write("first chunk of a video");
  for (
    let attempt = 0;
    attempt < 100 && !(await readdir(folder)).length;
    attempt += 1
  )
    await delay(10);
  assert.equal(
    (await readdir(folder)).length,
    1,
    "upload started writing a temporary file",
  );
  const closed = new Promise((resolve) => request.once("close", resolve));
  request.destroy();
  await closed;
  for (
    let attempt = 0;
    attempt < 100 && (await readdir(folder)).length;
    attempt += 1
  )
    await delay(10);
  assert.deepEqual(await readdir(folder), []);
  assert.deepEqual(
    (await (await fetch(`${base}/api/library`)).json()).videos,
    [],
  );
});
