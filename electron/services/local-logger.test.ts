// @vitest-environment node
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalLogger } from "./local-logger";

describe("bounded sanitized diagnostics logs", () => {
  let root: string, logger: LocalLogger;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mv-logs-"));
    logger = new LocalLogger(root);
  });
  afterEach(async () => {
    await logger.flush();
    await rm(root, { recursive: true, force: true });
  });
  const entry = (time = "2026-01-01T00:00:00.000Z") => ({
    time,
    component: "download",
    code: "downloadFailed",
  });
  async function seed(text: string, name = "mediavault.log") {
    await mkdir(join(root, "logs"), { recursive: true });
    await writeFile(join(root, "logs", name), text);
  }
  it("writes only whitelisted metadata and omits legacy job identifiers", async () => {
    logger.error("download", "downloadFailed", "private-job-id");
    logger.browserEvent("authAnalysisRetry");
    logger.error("update", "updateChecksumMismatch");
    logger.error("diagnostics", "diagnosticsFailed");
    await logger.flush();
    const raw = await readFile(join(root, "logs", "mediavault.log"), "utf8");
    expect(raw).not.toContain("private-job-id");
    const entries = await logger.read();
    expect(entries).toHaveLength(4);
    expect(entries.every((item) => /^[a-f0-9]{64}$/.test(item.id))).toBe(true);
    expect(entries.some((item) => item.event === "authAnalysisRetry")).toBe(true);
    expect(Object.keys(entries[0]!).sort()).toEqual(["code", "component", "event", "id", "time"]);
  });
  it("drops excess burst writes with a bounded queue and accepts new writes after draining", async () => {
    for (let index = 0; index < 600; index++) logger.error("download", "downloadFailed");
    await logger.flush();
    const lines = (await readFile(join(root, "logs", "mediavault.log"), "utf8")).trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(256);
    logger.browserEvent("authDownloadUsed");
    await logger.flush();
    expect(await logger.read({ kind: "event" })).toHaveLength(1);
  });
  it("reconstructs legacy entries and discards malformed, unknown and oversized lines without leaking extra fields", async () => {
    await seed(
      [
        JSON.stringify({
          ...entry(),
          jobId: "private",
          token: "secret",
          url: "https://signed.invalid/?secret",
          headers: { authorization: "secret" },
        }),
        JSON.stringify({ ...entry(), component: "https://private.invalid" }),
        JSON.stringify({ ...entry(), code: "Cookie: private" }),
        JSON.stringify({ ...entry(), time: "private-time" }),
        JSON.stringify({ ...entry(), event: "authAnalysisRetry" }),
        JSON.stringify({ ...entry(), padding: "x".repeat(4096) }),
        "not JSON",
        JSON.stringify([entry()]),
        JSON.stringify({
          time: "2026-01-02T00:00:00.000Z",
          component: "browser",
          event: "authDownloadUsed",
          cookie: "secret",
        }),
      ].join("\n") + "\n",
    );
    const entries = await logger.read();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.event).toBe("authDownloadUsed");
    expect(JSON.stringify(entries)).not.toMatch(/private|secret|signed|headers|padding/);
  });
  it("limits output to the newest200 matches and validates filters strictly", async () => {
    await seed(
      Array.from({ length: 300 }, (_, index) =>
        JSON.stringify(entry(new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString())),
      ).join("\n") + "\n",
    );
    const entries = await logger.read({ component: "download", kind: "error" });
    expect(entries).toHaveLength(200);
    expect(entries[0]!.time).toBe("2026-01-01T00:04:59.000Z");
    expect(await logger.read({ kind: "event" })).toEqual([]);
    for (const filter of [
      null,
      { component: "all" },
      { kind: "private" },
      { path: root },
      { limit: 1 },
      "download",
    ])
      await expect(logger.read(filter)).rejects.toThrow("invalidInput");
  });
  it("rotates before crossing1MiB and retains only five app-owned files", async () => {
    for (let index = 0; index < 7; index++) {
      await seed("x".repeat(1024 * 1024 - 1));
      logger.error("download", "downloadFailed");
      await logger.flush();
    }
    expect((await readdir(join(root, "logs"))).sort()).toEqual([
      "mediavault.log",
      "mediavault.log.1",
      "mediavault.log.2",
      "mediavault.log.3",
      "mediavault.log.4",
    ]);
    for (const name of await readdir(join(root, "logs")))
      expect((await stat(join(root, "logs", name))).size).toBeLessThanOrEqual(1024 * 1024);
    expect(await logger.read()).toHaveLength(1);
  });
  it("reads a bounded tail of oversized files while refusing oversized individual entries", async () => {
    await seed("x".repeat(6 * 1024 * 1024) + "\n" + JSON.stringify(entry()) + "\n");
    expect(await logger.read()).toHaveLength(1);
  });
  it("bounds legacy oversized files on the next write", async () => {
    await seed("x".repeat(2 * 1024 * 1024), "mediavault.log.3");
    await seed("x".repeat(2 * 1024 * 1024));
    logger.error("download", "downloadFailed");
    await logger.flush();
    for (const name of await readdir(join(root, "logs")))
      expect((await stat(join(root, "logs", name))).size).toBeLessThanOrEqual(1024 * 1024);
    expect(await logger.read()).toHaveLength(1);
  });
  it("refuses redirected log directories and never clears unrelated files", async () => {
    const external = join(root, "external");
    await mkdir(external);
    const target = join(external, "mediavault.log");
    await writeFile(target, JSON.stringify(entry()));
    await symlink(external, join(root, "logs"), "junction");
    await expect(logger.read()).rejects.toThrow("diagnosticsFailed");
    await expect(logger.clear()).rejects.toThrow("diagnosticsFailed");
    logger.error("download", "downloadFailed");
    await logger.flush();
    expect(await readFile(target, "utf8")).toBe(JSON.stringify(entry()));
  });
  it("refuses owned log names that are hard links to another file", async () => {
    const target = join(root, "private-document.txt");
    await writeFile(target, JSON.stringify(entry()));
    await mkdir(join(root, "logs"));
    await link(target, join(root, "logs", "mediavault.log"));
    await expect(logger.read()).rejects.toThrow("diagnosticsFailed");
    await expect(logger.clear()).rejects.toThrow("diagnosticsFailed");
    logger.error("startup", "databaseFailed");
    await logger.flush();
    expect(await readFile(target, "utf8")).toBe(JSON.stringify(entry()));
  });
  it("serializes clear with writes and removes only known regular log files", async () => {
    await seed("keep", "personal.log");
    logger.error("download", "downloadFailed");
    const cleared = logger.clear();
    logger.browserEvent("authDownloadUsed");
    await cleared;
    await logger.flush();
    expect(await readFile(join(root, "logs", "personal.log"), "utf8")).toBe("keep");
    const entries = await logger.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.event).toBe("authDownloadUsed");
  });
});
