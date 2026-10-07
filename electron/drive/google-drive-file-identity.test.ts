// @vitest-environment node
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleDriveService } from "./google-drive-service";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), stat: vi.fn(actual.stat) };
});

describe("Drive upload exact source identity", () => {
  let root: string;
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementation(actual.open);
    vi.mocked(stat).mockImplementation(actual.stat);
    root = await mkdtemp(join(tmpdir(), "mv-drive-identity-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  it.each(["ino", "dev"] as const)(
    "rejects a replacement whose %s collides as a JavaScript number",
    async (field) => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const filePath = join(root, "movie.mp4");
      await writeFile(filePath, Buffer.alloc(262144, 7));
      const modifiedAt = (await actual.stat(filePath)).mtimeMs;
      const original = 9007199254740992n;
      const replacement = original + 1n;
      expect(Number(original)).toBe(Number(replacement));
      let streamed = false;
      vi.mocked(open).mockImplementation(async (...args) => {
        const handle = await actual.open(...args);
        const handleStat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation((async (options) => {
          const info = await handleStat(options);
          Object.assign(info, { [field]: options?.bigint ? original : Number(original) });
          return info;
        }) as typeof handle.stat);
        return handle;
      });
      vi.mocked(stat).mockImplementation((async (path, options) => {
        const info = await actual.stat(path, options);
        const value = streamed ? replacement : original;
        Object.assign(info, { [field]: options?.bigint ? value : Number(value) });
        return info;
      }) as typeof stat);
      const drive = new GoogleDriveService({
        auth: {
          getAccount: () => ({
            configured: true,
            connecting: false,
            connected: true,
            providerAccountId: "account-id",
          }),
          getAccessToken: async () => "test-access",
        },
        transport: {
          request: async (request) => {
            let bytes = 0;
            for await (const chunk of request.body as Readable) bytes += (chunk as Buffer).length;
            expect(bytes).toBe(262144);
            streamed = true;
            return { status: 308, headers: {}, body: Buffer.from("{}") };
          },
        },
      });
      await expect(
        drive.uploadChunk({
          sessionURL:
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=fixture",
          filePath,
          fileSize: 262144,
          modifiedAt,
          offset: 0,
        }),
      ).rejects.toThrow(/^fileChanged$/);
      expect(streamed).toBe(true);
    },
  );
});
