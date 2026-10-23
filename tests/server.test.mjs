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
import { normalizeVideo } from "../media-converter.mjs";
import { BufferSource, Input, MP4 } from "mediabunny";

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
    // These transport tests use arbitrary bytes; codec integration is tested below.
    normalizeVideo: async () => ({ converted: false }),
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

async function setProcessed(base, video, processed, extraHeaders = {}) {
  return fetch(`${base}/api/processed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({ user: video.user, name: video.name, processed }),
  });
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
    `${today.replaceAll("-", "")}_clip.mp4`,
  );
  const invalidDate = await upload(base, "小明", "20260230_clip.webm");
  assert.equal(
    (await invalidDate.json()).video.name,
    `${today.replaceAll("-", "")}_clip_2.mp4`,
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

test("default LAN access allows nuc8.local and interface IPs while checking ports and origins", async (t) => {
  const { base, server } = await fixture(t);
  const port = server.address().port;
  async function request(authority, method = "GET", origin) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${base}${method === "POST" ? "/api/users" : "/api/library"}`,
        {
          method,
          headers: {
            Host: authority,
            ...(origin ? { Origin: origin } : {}),
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end(method === "POST" ? JSON.stringify({ name: "lan-user" }) : undefined);
    });
  }
  assert.equal(await request(`nuc8.local:${port}`), 200);
  assert.equal(await request(`NUC8.LOCAL:${port}`), 200);
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const { address, family } of interfaces || []) {
      if (family === "IPv4")
        assert.equal(await request(`${address}:${port}`), 200, address);
    }
  }
  assert.equal(
    await request(`nuc8.local:${port}`, "POST", `http://nuc8.local:${port}`),
    201,
  );
  assert.equal(
    await request(`nuc8.local:${port}`, "POST", `http://foreign.local:${port}`),
    403,
  );
  for (const hostname of ["foreign.local", "sub.nuc8.local", "nuc8.local.example"]) {
    assert.equal(await request(`${hostname}:${port}`), 403, hostname);
  }
  assert.equal(await request(`nuc8.local:${port === 8876 ? 8877 : 8876}`), 403);
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

test("processing status is shared by the library, persisted across restart, and reversible", async (t) => {
  const { base, videoDir, publicDir, server } = await fixture(t);
  const name = "20261020_旅行.mp4";
  for (const user of ["小明", "selena", "processed.json"]) {
    await createUser(base, user);
    const uploaded = (await (await upload(base, user, name)).json()).video;
    assert.equal(uploaded.processed, false);
  }
  const video = { user: "小明", name };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await setProcessed(base, video, true);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).video.processed, true);
  }
  const savedPath = path.join(videoDir, ".processed.json");
  assert.deepEqual(JSON.parse(await readFile(savedPath, "utf8")), {
    [`小明/${name}`]: true,
  });

  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const restarted = await createVideoServer({ videoDir, publicDir });
  restarted.listen(0, "127.0.0.1");
  await once(restarted, "listening");
  t.after(async () => {
    restarted.closeAllConnections();
    await new Promise((resolve) => restarted.close(resolve));
  });
  const restartedBase = `http://127.0.0.1:${restarted.address().port}`;
  const library = await (await fetch(`${restartedBase}/api/library`)).json();
  assert.equal(library.videos.find((item) => item.user === "小明").processed, true);
  assert.equal(
    library.videos.find((item) => item.user === "selena").processed,
    false,
  );
  assert.equal((await setProcessed(restartedBase, video, false)).status, 200);
  const refreshed = await (await fetch(`${restartedBase}/api/library`)).json();
  assert.ok(refreshed.videos.every((item) => item.processed === false));
  assert.deepEqual(JSON.parse(await readFile(savedPath, "utf8")), {
    [`小明/${name}`]: false,
  });
  assert.equal((await fetch(`${restartedBase}/processed.json`)).status, 404);
});

test("concurrent processing saves keep every video's latest status and leave no temporary files", async (t) => {
  const { base, videoDir } = await fixture(t);
  await createUser(base, "selena");
  const videos = await Promise.all(
    Array.from(
      { length: 8 },
      async (_, index) =>
        (await (await upload(base, "selena", `20261020_${index}.mp4`)).json()).video,
    ),
  );
  const marked = await Promise.all(
    videos.map((video) => setProcessed(base, video, true)),
  );
  assert.ok(marked.every((response) => response.status === 200));
  const unmarked = await Promise.all(
    videos
      .filter((_, index) => index % 2 === 0)
      .map((video) => setProcessed(base, video, false)),
  );
  assert.ok(unmarked.every((response) => response.status === 200));
  const expected = Object.fromEntries(
    videos.map((video, index) => [`${video.user}/${video.name}`, index % 2 !== 0]),
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(videoDir, ".processed.json"), "utf8")),
    expected,
  );
  const library = await (await fetch(`${base}/api/library`)).json();
  for (const video of library.videos)
    assert.equal(video.processed, expected[`${video.user}/${video.name}`]);
  assert.deepEqual((await readdir(videoDir)).sort(), [".processed.json", "selena"]);
});

test("processing updates reject invalid values, missing videos, paths, symlinks and foreign writes", async (t) => {
  const { base, videoDir, root } = await fixture(t);
  await createUser(base, "selena");
  const video = (await (await upload(base, "selena", "20261020_clip.mp4")).json())
    .video;
  for (const value of [undefined, null, 0, 1, "true", {}, []])
    assert.equal((await setProcessed(base, video, value)).status, 400);
  for (const body of ["null", "[]", "{"]) {
    assert.equal(
      (await fetch(`${base}/api/processed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      })).status,
      400,
    );
  }
  for (const [user, name, status] of [
    ["selena", "missing.mp4", 404],
    ["missing", video.name, 404],
    ["../outside", video.name, 400],
    ["selena", "../secret.mp4", 400],
    ["selena", "notes.txt", 404],
  ]) {
    assert.equal((await setProcessed(base, { user, name }, true)).status, status);
  }
  await writeFile(path.join(root, "secret.mp4"), "secret");
  await symlink(
    path.join(root, "secret.mp4"),
    path.join(videoDir, "selena", "link.mp4"),
  );
  assert.equal(
    (await setProcessed(base, { user: "selena", name: "link.mp4" }, true)).status,
    404,
  );
  assert.equal(
    (await setProcessed(base, video, true, { Origin: "https://foreign.example" }))
      .status,
    403,
  );
  await assert.rejects(readFile(path.join(videoDir, ".processed.json")), {
    code: "ENOENT",
  });
});

test("a failed processing write preserves memory and the next save can recover", async (t) => {
  const { base, videoDir } = await fixture(t);
  await createUser(base, "selena");
  const video = (await (await upload(base, "selena", "20261020_clip.mp4")).json())
    .video;
  const savedPath = path.join(videoDir, ".processed.json");
  await mkdir(savedPath); // Force the final rename to fail on any platform.
  const errors = t.mock.method(console, "error", () => {});
  assert.equal((await setProcessed(base, video, true)).status, 500);
  assert.equal(errors.mock.callCount(), 1);
  const library = await (await fetch(`${base}/api/library`)).json();
  assert.equal(library.videos[0].processed, false);
  assert.deepEqual((await readdir(videoDir)).sort(), [".processed.json", "selena"]);
  await rm(savedPath, { recursive: true });
  assert.equal((await setProcessed(base, video, true)).status, 200);
  assert.equal(
    JSON.parse(await readFile(savedPath, "utf8"))[`selena/${video.name}`],
    true,
  );
});

test("invalid saved processing data fails startup without overwriting the file", async (t) => {
  const { videoDir, publicDir } = await fixture(t);
  const savedPath = path.join(videoDir, ".processed.json");
  for (const content of ["{broken", "null", "[]", '{"selena/clip.mp4":"true"}']) {
    await writeFile(savedPath, content);
    await assert.rejects(
      createVideoServer({ videoDir, publicDir }),
      /无法读取处理状态/,
    );
    assert.equal(await readFile(savedPath, "utf8"), content);
  }
});

async function startDownload(base, user, name, headers = {}) {
  return fetch(`${base}/api/downloads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ user, name }),
  });
}

async function waitForDownload(base, job) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (["ready", "failed"].includes(job.status)) return job;
    await delay(20);
    job = (await (await fetch(`${base}/api/downloads/${job.id}`)).json()).job;
  }
  throw new Error("Download conversion did not finish");
}

async function assertCompatibleMp4(bytes) {
  const input = new Input({ source: new BufferSource(bytes), formats: [MP4] });
  try {
    assert.equal(await input.getFormat(), MP4);
    const videos = await input.getVideoTracks();
    assert.ok(videos.length);
    for (const video of videos) assert.equal(await video.getCodec(), "avc");
    for (const audio of await input.getAudioTracks()) assert.equal(await audio.getCodec(), "aac");
  } finally {
    input.dispose();
  }
}

const sample = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

test("real uploads normalize VP9 to MP4, keep H264 bytes, resolve converted-name collisions and reject broken media", async (t) => {
  const { base, videoDir } = await fixture(t, { normalizeVideo });
  await createUser(base, "编解码");
  const source = await sample("vp9-opus.webm");
  const converted = await upload(base, "编解码", "20261020_sample.webm", source);
  assert.equal(converted.status, 201);
  const video = (await converted.json()).video;
  assert.equal(video.name, "20261020_sample.mp4");
  await assertCompatibleMp4(await readFile(path.join(videoDir, "编解码", video.name)));
  const compatible = await sample("h264-aac.mp4");
  const copied = await upload(base, "编解码", "20261020_sample.mp4", compatible);
  assert.equal(copied.status, 201);
  const copy = (await copied.json()).video;
  assert.equal(copy.name, "20261020_sample_2.mp4");
  assert.deepEqual(await readFile(path.join(videoDir, "编解码", copy.name)), compatible);
  assert.equal((await upload(base, "编解码", "bad.mp4", "not a video")).status, 422);
  assert.deepEqual((await readdir(path.join(videoDir, "编解码"))).sort(), [video.name, copy.name].sort());
});

test("legacy VP9 downloads convert once, retain the original, reuse cache across restart and invalidate changed sources", async (t) => {
  let calls = 0;
  const countingConverter = async (options) => { calls++; return normalizeVideo(options); };
  const { base, videoDir, publicDir, server } = await fixture(t, { normalizeVideo: countingConverter });
  await mkdir(path.join(videoDir, "legacy"));
  const source = await sample("vp9-opus.webm");
  const sourcePath = path.join(videoDir, "legacy", "old.webm");
  await writeFile(sourcePath, source);
  const responses = await Promise.all(Array.from({ length: 3 }, () => startDownload(base, "legacy", "old.webm")));
  assert.ok(responses.every((response) => response.status === 202));
  const jobs = await Promise.all(responses.map(async (response) => (await response.json()).job));
  assert.equal(new Set(jobs.map((job) => job.id)).size, 1);
  const ready = await waitForDownload(base, jobs[0]);
  assert.equal(ready.status, "ready");
  assert.equal(calls, 1);
  const download = await fetch(`${base}${ready.downloadUrl}`);
  assert.equal(download.headers.get("content-type"), "video/mp4");
  assert.match(download.headers.get("content-disposition"), /old\.mp4/);
  const result = Buffer.from(await download.arrayBuffer());
  await assertCompatibleMp4(result);
  assert.deepEqual(await readFile(sourcePath), source);
  const range = await fetch(`${base}${ready.downloadUrl}`, { headers: { Range: "bytes=0-15" } });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), result.subarray(0, 16));
  assert.equal((await (await fetch(`${base}/api/library`)).json()).videos.length, 1);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const restarted = await createVideoServer({ videoDir, publicDir, normalizeVideo: countingConverter });
  restarted.listen(0, "127.0.0.1");
  await once(restarted, "listening");
  t.after(async () => {
    restarted.closeAllConnections();
    await new Promise((resolve) => restarted.close(resolve));
  });
  const secondBase = `http://127.0.0.1:${restarted.address().port}`;
  const cached = await waitForDownload(secondBase, (await (await startDownload(secondBase, "legacy", "old.webm")).json()).job);
  assert.equal(cached.status, "ready");
  assert.equal(calls, 1);
  await writeFile(sourcePath, await sample("vp9-silent-odd.webm"));
  const changed = await waitForDownload(secondBase, (await (await startDownload(secondBase, "legacy", "old.webm")).json()).job);
  assert.equal(changed.status, "ready");
  assert.notEqual(changed.id, ready.id);
  assert.equal(calls, 2);
});

test("compatible downloads bypass encoding and reject changed source files", async (t) => {
  const { base, videoDir } = await fixture(t, { normalizeVideo });
  await mkdir(path.join(videoDir, "user"));
  const bytes = await sample("h264-aac.mp4");
  const sourcePath = path.join(videoDir, "user", "clip.mp4");
  await writeFile(sourcePath, bytes);
  const job = await waitForDownload(base, (await (await startDownload(base, "user", "clip.mp4")).json()).job);
  assert.equal(job.status, "ready");
  assert.deepEqual(Buffer.from(await (await fetch(`${base}${job.downloadUrl}`)).arrayBuffer()), bytes);
  assert.deepEqual(await readdir(path.join(videoDir, ".transcoded")), []);
  await writeFile(sourcePath, "changed");
  assert.equal((await fetch(`${base}${job.downloadUrl}`)).status, 409);
});

test("download jobs reject foreign writes and symlinks, expose conversion errors and permit retry", async (t) => {
  let fail = true;
  const { base, videoDir, root } = await fixture(t, {
    normalizeVideo: async ({ outputPath }) => {
      await writeFile(outputPath, "partial output");
      if (fail) throw new Error("codec unavailable");
      return { converted: true };
    },
  });
  await mkdir(path.join(videoDir, "user"));
  await writeFile(path.join(videoDir, "user", "clip.webm"), "source");
  await writeFile(path.join(root, "secret.mp4"), "secret");
  await symlink(path.join(root, "secret.mp4"), path.join(videoDir, "user", "link.mp4"));
  assert.equal((await startDownload(base, "user", "clip.webm", { Origin: "https://foreign.example" })).status, 403);
  assert.equal((await startDownload(base, "user", "link.mp4")).status, 404);
  assert.equal((await startDownload(base, "user", "../secret.mp4")).status, 400);
  assert.equal((await startDownload(base, "user", "missing.mp4")).status, 404);
  const job = await waitForDownload(base, (await (await startDownload(base, "user", "clip.webm")).json()).job);
  assert.equal(job.status, "failed");
  assert.ok(job.error);
  assert.equal((await fetch(`${base}/api/downloads/${job.id}/file`)).status, 409);
  // Failure is visible only after cleanup completes in the queue.
  await delay(20);
  assert.deepEqual(await readdir(path.join(videoDir, ".transcoded")), []);
  fail = false;
  const retried = await waitForDownload(base, (await (await startDownload(base, "user", "clip.webm")).json()).job);
  assert.equal(retried.status, "ready");
});

test("uploads and downloads share a serial conversion queue and never publish a failed upload", async (t) => {
  let active = 0;
  let peak = 0;
  const { base, videoDir } = await fixture(t, {
    normalizeVideo: async ({ handle }) => {
      active++;
      peak = Math.max(peak, active);
      await delay(30);
      active--;
      if ((await handle.readFile("utf8")) === "bad") throw new Error("bad input");
      return { converted: false };
    },
  });
  await createUser(base, "user");
  await writeFile(path.join(videoDir, "user", "old.mp4"), "good");
  const [a, b, download] = await Promise.all([
    upload(base, "user", "good.mp4", "good"),
    upload(base, "user", "bad.mp4", "bad"),
    startDownload(base, "user", "old.mp4"),
  ]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 422);
  assert.equal((await waitForDownload(base, (await download.json()).job)).status, "ready");
  assert.equal(peak, 1);
  assert.equal((await readdir(path.join(videoDir, "user"))).length, 2);
});

test("disconnecting during upload conversion removes source and output without publishing", async (t) => {
  const started = Promise.withResolvers();
  const { base, videoDir } = await fixture(t, {
    normalizeVideo: async ({ outputPath, signal }) => {
      await writeFile(outputPath, "partial");
      started.resolve();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      });
      return { converted: true };
    },
  });
  await createUser(base, "user");
  const request = http.request(`${base}/api/upload?user=user&name=cancel.webm`, { method: "POST" });
  request.on("error", () => {});
  request.end("video");
  await started.promise;
  request.destroy();
  let files;
  for (let attempt = 0; attempt < 100; attempt++) {
    files = await readdir(path.join(videoDir, "user"));
    if (!files.length) break;
    await delay(10);
  }
  assert.deepEqual(files, []);
  assert.equal((await (await fetch(`${base}/api/library`)).json()).videos.length, 0);
});

test("expired download cache is cleaned and ready jobs regenerate missing files", async (t) => {
  let calls = 0;
  const { base, videoDir } = await fixture(t, {
    normalizeVideo: async ({ outputPath }) => {
      calls++;
      await writeFile(outputPath, "converted");
      return { converted: true };
    },
  });
  await createUser(base, "user");
  await writeFile(path.join(videoDir, "user", "one.webm"), "one");
  await writeFile(path.join(videoDir, "user", "two.webm"), "two");
  const first = await waitForDownload(base, (await (await startDownload(base, "user", "one.webm")).json()).job);
  const cachedPath = path.join(videoDir, ".transcoded", `${first.id}.mp4`);
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(cachedPath, old, old);
  await waitForDownload(base, (await (await startDownload(base, "user", "two.webm")).json()).job);
  assert.equal((await fetch(`${base}${first.downloadUrl}`)).status, 404);
  const regenerated = await waitForDownload(base, (await (await startDownload(base, "user", "one.webm")).json()).job);
  assert.equal(regenerated.status, "ready");
  assert.equal(calls, 3);
  assert.equal((await fetch(`${base}${regenerated.downloadUrl}`)).status, 200);
});
