import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));

// Node preserves values already supplied by the service manager or shell.
export function loadProjectEnv(file = path.join(PROJECT_DIR, ".env")) {
  try {
    process.loadEnvFile(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("无法读取项目 .env 文件，请检查文件权限与格式。");
  }
}
