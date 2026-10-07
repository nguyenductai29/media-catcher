import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ErrorCode } from "../../shared/models";

/** Diagnostic metadata only: never arguments, URLs, cookies, headers or stderr. */
export class LocalLogger {
  private work: Promise<void> = Promise.resolve();
  constructor(private readonly userDataDirectory: string) {}
  error(
    component: "download" | "ipc" | "startup" | "shutdown",
    code: ErrorCode,
    jobId?: string,
  ): void {
    const entry = JSON.stringify({
      time: new Date().toISOString(),
      component,
      code,
      ...(jobId && /^[a-z0-9-]{1,100}$/i.test(jobId) ? { jobId } : {}),
    });
    this.work = this.work
      .then(async () => {
        const directory = join(this.userDataDirectory, "logs"),
          path = join(directory, "mediavault.log");
        await mkdir(directory, { recursive: true });
        const info = await stat(path).catch(() => undefined);
        if (info && info.size > 1024 * 1024) {
          await unlink(`${path}.1`).catch(() => {});
          await rename(path, `${path}.1`);
        }
        await appendFile(path, `${entry}\n`, { encoding: "utf8", mode: 0o600 });
      })
      .catch(() => {});
  }
  flush(): Promise<void> {
    return this.work;
  }
}
