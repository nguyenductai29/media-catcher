import { spawn } from "node:child_process";
import { createServer } from "vite";
import electron from "electron";
import "./build-electron.mjs";

const server = await createServer({ configFile: "vite.desktop.config.ts" });
await server.listen();
const env = { ...process.env, MEDIAVAULT_DEV_URL: "http://127.0.0.1:5174" };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["."], { env, stdio: "inherit", windowsHide: true });
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  child.kill();
  await server.close();
  process.exitCode = code;
}
child.on("exit", (code) => {
  void close(code ?? 1);
});
child.on("error", () => {
  console.error("Electron could not start.");
  void close(1);
});
process.on("SIGINT", () => {
  void close();
});
process.on("SIGTERM", () => {
  void close();
});
