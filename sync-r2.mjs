import path from "node:path";
import { loadProjectEnv, PROJECT_DIR } from "./env.mjs";
import { readR2Config, createR2Runner } from "./r2-runtime.mjs";

let runner;
const stop = () => { void runner?.stop(); };
try {
  loadProjectEnv();
  const config = readR2Config(process.env, { force: true });
  runner = createR2Runner({ videoDir: path.resolve(process.env.VIDEO_DIR || path.join(PROJECT_DIR, "videos")), config });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const result = await runner.run();
  process.exitCode = result.status === "success" ? 0 : 1;
} catch (error) {
  // Configuration errors are produced locally without interpolating values.
  console.error(`R2 同步启动失败：${error.message}`);
  process.exitCode = 1;
} finally {
  await runner?.stop();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
