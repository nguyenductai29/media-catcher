// @vitest-environment node
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DriveAccount, MediaItem } from "../../shared/models";
import { GoogleDriveService } from "./google-drive-service";
import {
  DriveRequestError,
  type DriveHttpRequest,
  type DriveHttpResponse,
} from "./drive-transport";
import { SecureStore } from "./secure-store";
import { UploadWorker } from "./upload-worker";
import type { StoredDriveUpload } from "./models";
import type { UploadCheckpoint } from "./upload-types";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const MiB = 1024 * 1024;
const session =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=private-capability";
const response = (
  data: unknown = {},
  status = 200,
  headers: Record<string, string> = {},
): DriveHttpResponse => ({ status, headers, body: Buffer.from(JSON.stringify(data)) });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "mv-drive-integration-"));
  roots.push(directory);
  const localPath = join(directory, "Movie.mp4");
  const fileSize = 2.5 * MiB;
  const file = await open(localPath, "wx");
  // Write a deterministic disk fixture incrementally; neither fixture nor upload
  // transport needs a buffer the size of the media file.
  try {
    for (let position = 0; position < fileSize; position += 65536)
      await file.write(Buffer.alloc(65536, (position / 65536) % 251));
  } finally {
    await file.close();
  }
  const modifiedAt = (await stat(localPath)).mtimeMs;
  const account: DriveAccount = {
    configured: true,
    connecting: false,
    connected: true,
    providerAccountId: "account",
    rootFolderId: "folder",
  };
  const item: MediaItem = {
    id: "media",
    title: "Movie",
    sourceType: "local",
    localPath,
    duration: 3,
    width: 640,
    height: 360,
    resolution: "360p",
    container: "mp4",
    fileSize,
    modifiedAt,
    createdAt: 1,
    updatedAt: 1,
  };
  const job: StoredDriveUpload = {
    id: "upload",
    mediaId: "media",
    providerAccountId: "account",
    fileName: "Movie.mp4",
    localPath,
    mimeType: "video/mp4",
    fileSize,
    modifiedAt,
    uploadedBytes: 0,
    progress: 0,
    status: "preparing",
    createdAt: 1,
    updatedAt: 1,
    attempts: 1,
  };
  const root = {
    id: "folder",
    name: "MediaVault",
    mimeType: "application/vnd.google-apps.folder",
    parents: ["root"],
    trashed: false,
    appProperties: { mediavault: "1", role: "root" },
  };
  const remote = {
    id: "reserved",
    name: "Movie (1).mp4",
    mimeType: "video/mp4",
    size: String(fileSize),
    parents: ["folder"],
    trashed: false,
    appProperties: { mediavault: "1", mediaId: "media", uploadId: "upload" },
  };
  const key = randomBytes(32);
  const store = new SecureStore(directory, {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8");
    },
  });
  let cloudComplete = false;
  let serverOffset = 0;
  let starts = 0;
  let largestBuffer = 0;
  const offsets: number[] = [];
  const queries: number[] = [];
  const checkpoints: UploadCheckpoint[] = [];
  const order: string[] = [];
  const request = vi.fn(async (input: DriveHttpRequest): Promise<DriveHttpResponse> => {
    const url = new URL(input.url);
    if (input.method === "GET") {
      if (url.pathname.endsWith("/folder")) return response(root);
      if (url.pathname.endsWith("/reserved")) {
        order.push("verify");
        return cloudComplete ? response(remote) : response({}, 404);
      }
      if (url.pathname.endsWith("/generateIds")) return response({ ids: ["reserved"] });
      expect(url.searchParams.get("q")).toContain("'folder' in parents");
      return response({ files: [{ name: "Movie.mp4" }] });
    }
    if (input.method === "POST") {
      starts++;
      order.push("start");
      expect(
        checkpoints.some(
          (patch) => patch.plannedFileId === "reserved" && patch.fileName === "Movie (1).mp4",
        ),
      ).toBe(true);
      expect(JSON.parse(String(input.body))).toEqual({
        id: "reserved",
        name: "Movie (1).mp4",
        mimeType: "video/mp4",
        parents: ["folder"],
        appProperties: remote.appProperties,
      });
      return response({}, 200, { location: session });
    }
    const contentRange = input.headers?.["Content-Range"];
    if (contentRange === `bytes */${fileSize}`) {
      order.push("query");
      queries.push(serverOffset);
      return cloudComplete
        ? response(remote, 200)
        : response({}, 308, { range: `bytes=0-${serverOffset - 1}` });
    }
    expect(input.body).toBeInstanceOf(Readable);
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? "");
    expect(match).not.toBeNull();
    const start = Number(match![1]);
    const end = Number(match![2]);
    expect(start).toBe(serverOffset);
    expect(Number(match![3])).toBe(fileSize);
    offsets.push(start);
    order.push(`chunk:${start}`);
    let bytes = 0;
    for await (const raw of input.body as Readable) {
      const chunk = raw as Buffer;
      largestBuffer = Math.max(largestBuffer, chunk.length);
      expect(chunk.length).toBeLessThanOrEqual(65536);
      expect(chunk.equals(Buffer.alloc(chunk.length, ((start + bytes) / 65536) % 251))).toBe(true);
      bytes += chunk.length;
      input.onUploadProgress?.(bytes);
    }
    expect(bytes).toBe(end - start + 1);
    if (offsets.length === 1) {
      serverOffset = MiB / 2;
      throw new DriveRequestError("driveUnavailable", true);
    }
    serverOffset = end + 1;
    if (serverOffset === fileSize) {
      cloudComplete = true;
      throw new DriveRequestError("driveUnavailable", true);
    }
    return response({}, 308, { range: `bytes=0-${serverOffset - 1}` });
  });
  const drive = new GoogleDriveService({
    auth: { getAccount: () => account, getAccessToken: async () => "mock-access-token" },
    transport: { request },
  });
  const worker = new UploadWorker({
    drive,
    store,
    library: { get: () => item, validateKnownFile: async () => localPath },
    settings: {
      get: () => ({ autoUpload: false, deleteLocal: "never", concurrency: 1, chunkSizeMiB: 1 }),
    },
    account: () => account,
    sleep: async () => {},
  });
  const checkpoint = (patch: UploadCheckpoint) => {
    checkpoints.push(patch);
    if (patch.plannedFileId) order.push("persist-id");
    if (patch.sessionEncrypted) order.push("persist-session");
  };
  return {
    worker,
    job,
    store,
    checkpoints,
    checkpoint,
    offsets,
    queries,
    order,
    request,
    remote,
    stats: () => ({ starts, largestBuffer }),
  };
}
describe("Drive worker and Google API integration without credentials", () => {
  it("streams bounded chunks, queries after lost responses, and verifies the preallocated file before success", async () => {
    const f = await fixture();
    const result = await f.worker.execute(
      f.job,
      f.checkpoint,
      vi.fn(),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ id: "reserved", name: "Movie (1).mp4", size: 2.5 * MiB });
    expect(f.offsets).toEqual([0, MiB / 2, 1.5 * MiB]);
    expect(f.queries).toEqual([MiB / 2, 2.5 * MiB]);
    expect(f.stats()).toEqual({ starts: 1, largestBuffer: 65536 });
    expect(f.order.indexOf("persist-id")).toBeLessThan(f.order.indexOf("start"));
    expect(f.order.indexOf("persist-session")).toBeLessThan(f.order.indexOf("chunk:0"));
    expect(f.order.at(-1)).toBe("verify");
    expect(f.order.indexOf("query")).toBeLessThan(f.order.indexOf(`chunk:${MiB / 2}`));
    expect(JSON.stringify(f.checkpoints)).not.toContain("private-capability");
    const encrypted = f.checkpoints.find((patch) => patch.sessionEncrypted)?.sessionEncrypted;
    expect(f.store.unseal(encrypted!, "account:upload")).toBe(session);
    expect(() => f.store.unseal(encrypted!, "other:upload")).toThrow();
    expect(f.checkpoints).toContainEqual({ uploadedBytes: MiB / 2 });
  });
  it("recovers a completed upload by its planned ID after restart without opening a second session", async () => {
    const f = await fixture();
    await f.worker.execute(f.job, f.checkpoint, vi.fn(), new AbortController().signal);
    const before = f.request.mock.calls.length;
    const stored = {
      ...f.job,
      plannedFileId: "reserved",
      driveFolderId: "folder",
      fileName: "Movie (1).mp4",
      uploadedBytes: 123,
    };
    expect(
      (await f.worker.execute(stored, vi.fn(), vi.fn(), new AbortController().signal)).id,
    ).toBe("reserved");
    expect(f.request.mock.calls.length - before).toBe(1);
    expect(f.stats().starts).toBe(1);
  });
});
