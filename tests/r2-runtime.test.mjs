import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Readable } from "node:stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { readR2Config, createR2Client, createR2Runner, startR2Sync } from "../r2-runtime.mjs";

const env = {
  R2_SYNC_ENABLED: "true",
  R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
  R2_BUCKET: "video-materials",
  R2_ACCESS_KEY_ID: "access-key-for-tests",
  R2_SECRET_ACCESS_KEY: "secret-for-tests",
};
const quiet = { log() {}, error() {} };

test("disabled R2 needs no credentials and starts no runner or schedules", () => {
  const config = readR2Config({ R2_SECRET_ACCESS_KEY: "unused" });
  assert.deepEqual(config, { enabled: false });
  startR2Sync({
    config,
    makeRunner() { assert.fail("disabled sync made a client"); },
    schedule() { assert.fail("disabled sync scheduled work"); },
  });
  assert.throws(() => readR2Config({}, { force: true }), /R2_ENDPOINT/);
  assert.equal(readR2Config({ ...env, R2_SYNC_ENABLED: "false" }, { force: true }).bucket, "video-materials");
});

test("configuration validates credentials, endpoint, times, timezone and proxy without disclosing values", () => {
  const config = readR2Config({ ...env, HTTPS_PROXY: "http://ambient:1234" });
  assert.equal(config.proxyUrl, "");
  assert.equal(config.region, "auto");
  assert.equal(config.onStart, true);
  assert.deepEqual(config.times, ["07:30", "12:00"]);
  assert.equal(config.timezone, "Asia/Shanghai");
  assert.deepEqual(readR2Config({ ...env, R2_SYNC_TIMES: "08:15, 18:45,08:15" }).times, ["08:15", "18:45"]);
  assert.equal(readR2Config({ ...env, R2_PROXY_URL: "http://user:password@127.0.0.1:7890" }).proxyUrl, "http://user:password@127.0.0.1:7890");
  for (const [key, value] of [
    ["R2_SYNC_ENABLED", "maybe"], ["R2_ENDPOINT", "http://example.com"],
    ["R2_ENDPOINT", "https://user:secret@host.test"], ["R2_ENDPOINT", "https://host.test/path"],
    ["R2_BUCKET", ""], ["R2_ACCESS_KEY_ID", ""], ["R2_SECRET_ACCESS_KEY", "cfat_private-token"],
    ["R2_SYNC_TIMES", "24:00"], ["R2_SYNC_TIMES", "07:30,"],
    ["R2_SYNC_TIMEZONE", "bad-zone"], ["R2_SYNC_ON_START", "sometimes"],
    ["R2_PROXY_URL", "socks5://user:secret@127.0.0.1:1080"],
    ["R2_MANIFEST_KEY", "../manifest.json"],
  ]) {
    assert.throws(() => readR2Config({ ...env, [key]: value }), (error) => {
      assert.doesNotMatch(error.message, /private-token|user:secret|secret-for-tests/);
      return true;
    }, key);
  }
});

test("runner uses read-only SDK commands, coalesces runs, and aborts ongoing work on stop", async () => {
  const sent = [];
  const started = Promise.withResolvers();
  let destroyed = false;
  let observedSignal;
  const runner = createR2Runner({
    videoDir: "/unused", config: readR2Config(env), logger: quiet,
    client: {
      async send(command, options) { sent.push({ command, options }); return { Body: "manifest" }; },
      destroy() { destroyed = true; },
    },
    makeSync({ getObject, manifestKey }) {
      return { async run({ signal }) {
        observedSignal = signal;
        await getObject(manifestKey, { signal });
        started.resolve();
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return { status: "failed" };
      } };
    },
  });
  const first = runner.run();
  assert.equal(runner.run(), first);
  await started.promise;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].command.constructor.name, "GetObjectCommand");
  assert.deepEqual(sent[0].command.input, { Bucket: "video-materials", Key: "manifest.json" });
  assert.equal(sent[0].options.abortSignal, observedSignal);
  await runner.stop();
  assert.equal(observedSignal.aborted, true);
  assert.equal(destroyed, true);
  assert.equal((await runner.run()).status, "skipped");
});

test("SDK exceptions never leak request credentials through runner logs", async () => {
  const logs = [];
  const runner = createR2Runner({
    config: readR2Config(env), logger: { error: (message) => logs.push(message) },
    client: { destroy() {} },
    makeSync: () => ({ run: async () => { throw new Error("http://user:supersecret@proxy/ Authorization=secret-for-tests"); } }),
  });
  assert.equal((await runner.run()).status, "failed");
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs.join(""), /supersecret|Authorization|secret-for-tests/);
  await runner.stop();
});

test("configured SDK signs GetObject requests and exposes a readable response stream", async (t) => {
  const client = createR2Client(readR2Config(env));
  const originalHandler = client.config.requestHandler;
  t.after(() => { originalHandler.destroy(); client.destroy(); });
  let request;
  client.config.requestHandler = {
    async handle(value) {
      request = value;
      return { response: { statusCode: 200, headers: { "content-length": "7" }, body: Readable.from([Buffer.from("content")]) } };
    },
    destroy() {},
  };
  const result = await client.send(new GetObjectCommand({ Bucket: "video-materials", Key: "manifest.json" }));
  assert.equal(request.method, "GET");
  assert.equal(request.protocol, "https:");
  assert.match(request.headers.authorization, /AWS4-HMAC-SHA256 Credential=access-key-for-tests\//);
  assert.match(request.path, /\/manifest\.json$/);
  assert.equal(result.ContentLength, 7);
  assert.equal(await result.Body.transformToString(), "content");
});

test("SDK agents honor only R2_PROXY_URL even with process-wide proxy settings enabled", async () => {
  const code = `
    import assert from 'node:assert/strict';
    import { Agent } from 'node:https';
    import { HttpsProxyAgent } from 'https-proxy-agent';
    import { createR2Client, readR2Config } from ${JSON.stringify(new URL("../r2-runtime.mjs", import.meta.url).href)};
    const env = ${JSON.stringify(env)};
    for (const proxy of ['', 'http://127.0.0.1:7890', 'https://proxy.example:8443']) {
      const client = createR2Client(readR2Config({...env, R2_PROXY_URL: proxy}));
      try {
        // An already-aborted request resolves handler configuration without
        // opening a socket, including when the ambient proxy is unreachable.
        await assert.rejects(client.config.requestHandler.handle({protocol:'https:'}, {
          abortSignal: AbortSignal.abort(),
        }), { name: 'AbortError' });
        const handler = client.config.requestHandler.httpHandlerConfigs();
        assert.equal(handler.connectionTimeout, 10000);
        assert.equal(handler.socketTimeout, 120000);
        const agent = handler.httpsAgent;
        if (proxy) {
          assert.ok(agent instanceof HttpsProxyAgent);
          assert.equal(agent.proxy.href, new URL(proxy).href);
        } else {
          assert.equal(agent.constructor, Agent);
          assert.equal(agent.proxy, undefined);
          assert.equal(agent.options.proxyEnv, undefined);
        }
      } finally { client.destroy(); }
    }
    process.stdout.write('ok');
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], {
    env: {
      ...process.env, NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://ambient.invalid:9999",
      HTTP_PROXY: "http://ambient.invalid:9999", ALL_PROXY: "http://ambient.invalid:9999", NO_PROXY: "*",
    },
  });
  assert.equal(stdout, "ok");
});

test("scheduler uses configured local times, timezone, startup policy and destroys all jobs", async () => {
  const scheduled = [];
  let runs = 0;
  let stopped = false;
  const runtime = startR2Sync({
    config: readR2Config({ ...env, R2_SYNC_TIMES: "07:30,12:00", R2_SYNC_ON_START: "false" }), logger: quiet,
    makeRunner: () => ({ run: async () => { runs++; }, stop: async () => { stopped = true; } }),
    schedule(expression, callback, options) {
      const record = { expression, callback, options, destroyed: false };
      scheduled.push(record);
      return { destroy() { record.destroyed = true; } };
    },
  });
  assert.equal(runs, 0);
  assert.deepEqual(scheduled.map((item) => item.expression), ["30 7 * * *", "0 12 * * *"]);
  for (const job of scheduled) {
    assert.deepEqual(job.options, { timezone: "Asia/Shanghai", noOverlap: true });
    await job.callback();
  }
  assert.equal(runs, 2);
  await runtime.stop();
  assert.equal(stopped, true);
  assert.ok(scheduled.every((item) => item.destroyed));
  const onStart = startR2Sync({
    config: readR2Config(env), logger: quiet,
    makeRunner: () => ({ run: async () => { runs++; }, stop: async () => {} }),
    schedule: () => ({ destroy() {} }),
  });
  assert.equal(runs, 3);
  await onStart.stop();
});

test(".env is optional and preserves values supplied by the process environment", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "video-library-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".env");
  await writeFile(file, "R2_TEST_EXISTING=from-file\nR2_TEST_NEW='hello world'\n");
  const code = `import { loadProjectEnv } from ${JSON.stringify(new URL("../env.mjs", import.meta.url).href)};
    loadProjectEnv(${JSON.stringify(path.join(dir, "missing"))});
    loadProjectEnv(${JSON.stringify(file)});
    process.stdout.write(JSON.stringify([process.env.R2_TEST_EXISTING,process.env.R2_TEST_NEW]));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, R2_TEST_EXISTING: "from-process", R2_TEST_NEW: undefined },
  });
  assert.deepEqual(JSON.parse(stdout), ["from-process", "hello world"]);
});
