import { Agent } from "node:https";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { HttpsProxyAgent } from "https-proxy-agent";
import cron from "node-cron";
import { createR2Sync } from "./r2-sync.mjs";

function boolean(env, key, fallback) {
  const value = env[key]?.trim();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${key} 必须为 true 或 false。`);
}

function required(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`启用 R2 同步必须填写 ${key}。`);
  return value;
}

export function readR2Config(env = process.env, { force = false } = {}) {
  const enabled = boolean(env, "R2_SYNC_ENABLED", false);
  if (!enabled && !force) return { enabled: false };
  const endpoint = required(env, "R2_ENDPOINT");
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
  } catch {
    throw new Error("R2_ENDPOINT 必须是 HTTPS 服务地址，不能含认证信息、路径或查询参数。");
  }
  const bucket = required(env, "R2_BUCKET");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("R2_BUCKET 不是有效的桶名称。");
  const accessKeyId = required(env, "R2_ACCESS_KEY_ID");
  const secretAccessKey = required(env, "R2_SECRET_ACCESS_KEY");
  if (accessKeyId.startsWith("cfat_") || secretAccessKey.startsWith("cfat_")) {
    throw new Error("R2 同步需要 S3 Access Key ID 与 Secret Access Key，不能使用 Cloudflare API token。");
  }
  const times = [...new Set((env.R2_SYNC_TIMES || "07:30,12:00").split(",").map((time) => time.trim()))];
  if (!times.length || times.some((time) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) {
    throw new Error("R2_SYNC_TIMES 必须为 HH:mm 格式，多个时间用逗号分隔。");
  }
  const timezone = env.R2_SYNC_TIMEZONE?.trim() || "Asia/Shanghai";
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); }
  catch { throw new Error("R2_SYNC_TIMEZONE 必须是有效的 IANA 时区。"); }
  const proxyUrl = env.R2_PROXY_URL?.trim() || "";
  if (proxyUrl) {
    try {
      const url = new URL(proxyUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash || url.pathname !== "/") throw new Error();
    } catch {
      throw new Error("R2_PROXY_URL 必须是 HTTP 或 HTTPS 代理地址。");
    }
  }
  const manifestKey = env.R2_MANIFEST_KEY?.trim() || "manifest.json";
  if (manifestKey.length > 1024 || manifestKey.split("/").some((part) => !part || part === "." || part === "..") || /[\x00-\x1f\x7f\\]/.test(manifestKey)) {
    throw new Error("R2_MANIFEST_KEY 不是有效的对象键。");
  }
  return {
    enabled, endpoint, bucket, accessKeyId, secretAccessKey, times, timezone, proxyUrl, manifestKey,
    region: env.R2_REGION?.trim() || "auto",
    onStart: boolean(env, "R2_SYNC_ON_START", true),
  };
}

export function createR2Client(config) {
  // Use our own agent even for direct connections: ambient proxy variables must
  // not silently change the route when R2_PROXY_URL is empty.
  const httpsAgent = config.proxyUrl
    ? new HttpsProxyAgent(config.proxyUrl, { keepAlive: true })
    : new Agent({ keepAlive: true, maxSockets: 4 });
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 3,
    requestHandler: new NodeHttpHandler({
      httpsAgent,
      connectionTimeout: 10_000,
      socketTimeout: 120_000,
    }),
  });
}

// The same runner is used by the HTTP service and the one-shot CLI.
export function createR2Runner({ videoDir, config, logger = console, client = createR2Client(config), makeSync = createR2Sync }) {
  const controller = new AbortController();
  const sync = makeSync({
    videoDir,
    manifestKey: config.manifestKey,
    logger,
    getObject: (key, { signal } = {}) => client.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: key }), { abortSignal: signal },
    ),
  });
  let active;
  let stopped = false;
  return {
    run() {
      if (stopped) return Promise.resolve({ status: "skipped" });
      if (active) return active;
      active = Promise.resolve().then(() => sync.run({ signal: controller.signal })).catch(() => {
        // SDK errors can contain request metadata or a proxy URL with credentials.
        logger.error("[R2] 同步未完成，请检查网络、桶权限及同步状态文件。");
        return { status: "failed" };
      }).finally(() => { active = null; });
      return active;
    },
    async stop() {
      stopped = true;
      controller.abort();
      client.destroy();
      await active;
    },
  };
}

export function startR2Sync({ videoDir, config = readR2Config(), logger = console, makeRunner = createR2Runner, schedule = cron.schedule }) {
  if (!config.enabled) return { stop: async () => {} };
  const runner = makeRunner({ videoDir, config, logger });
  const tasks = [];
  try {
    for (const time of config.times) {
      const [hour, minute] = time.split(":").map(Number);
      tasks.push(schedule(`${minute} ${hour} * * *`, () => runner.run(), {
        timezone: config.timezone, noOverlap: true,
      }));
    }
  } catch (error) {
    for (const task of tasks) task.destroy();
    void runner.stop();
    throw error;
  }
  logger.log(`[R2] 每日 ${config.times.join("、")}（${config.timezone}）同步，${config.proxyUrl ? "使用已配置代理" : "直连"}。`);
  if (config.onStart) void runner.run();
  return {
    run: () => runner.run(),
    async stop() {
      for (const task of tasks) task.destroy();
      await runner.stop();
    },
  };
}
