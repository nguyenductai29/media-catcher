// @vitest-environment node
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleDriveService } from "./google-drive-service";
import type { DriveHttpRequest, DriveHttpResponse } from "./drive-transport";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const session =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=secret-session";
const response = (
  data: unknown = {},
  status = 200,
  headers: Record<string, string> = {},
): DriveHttpResponse => ({ status, headers, body: Buffer.from(JSON.stringify(data)) });
const rootFolder = {
  id: "root-id",
  name: "MediaVault",
  mimeType: "application/vnd.google-apps.folder",
  trashed: false,
  parents: ["root"],
  appProperties: { mediavault: "1", role: "root" },
};
const file = {
  id: "planned-id",
  name: "Movie.mp4",
  mimeType: "video/mp4",
  size: "1048576",
  trashed: false,
  parents: ["root-id"],
  appProperties: { mediavault: "1", mediaId: "media-id", uploadId: "upload-id" },
};
function fixture(handler: (input: DriveHttpRequest) => Promise<DriveHttpResponse>) {
  const request = vi.fn(handler);
  const getAccessToken = vi.fn(async (_signal?: AbortSignal, force = false) =>
    force ? "fresh" : "access",
  );
  const getAccount = () => ({
    connected: true,
    configured: true,
    connecting: false,
    providerAccountId: "account-id",
  });
  return {
    drive: new GoogleDriveService({ auth: { getAccessToken, getAccount }, transport: { request } }),
    request,
    getAccessToken,
  };
}
describe("Google Drive resumable API", () => {
  it("uses a preallocated ID and exact ownership metadata for resumable creation", async () => {
    const { drive, request } = fixture(async () => response({}, 200, { location: session }));
    expect(
      await drive.startResumable({
        fileId: "planned-id",
        folderId: "root-id",
        name: "Movie.mp4",
        mimeType: "video/mp4",
        fileSize: 1048576,
        mediaId: "media-id",
        uploadId: "upload-id",
      }),
    ).toBe(session);
    expect(JSON.parse(String(request.mock.calls[0]?.[0].body))).toMatchObject({
      id: "planned-id",
      parents: ["root-id"],
      appProperties: file.appProperties,
    });
    expect(request.mock.calls[0]?.[0].headers).toMatchObject({
      "X-Upload-Content-Length": "1048576",
      Authorization: "Bearer access",
    });
  });
  it("only trusts server Range, treats an absent Range as zero, and recognizes expiration/completion", async () => {
    const replies = [
      response({}, 308, { range: "bytes=0-262143" }),
      response({}, 308),
      response({}, 404),
      response(file, 201),
    ];
    const { drive, request } = fixture(async () => replies.shift()!);
    expect(await drive.queryResumable(session, 1048576)).toEqual({
      kind: "incomplete",
      uploadedBytes: 262144,
    });
    expect(await drive.queryResumable(session, 1048576)).toEqual({
      kind: "incomplete",
      uploadedBytes: 0,
    });
    expect(await drive.queryResumable(session, 1048576)).toEqual({ kind: "expired" });
    expect(await drive.queryResumable(session, 1048576)).toMatchObject({
      kind: "complete",
      file: { id: "planned-id", size: 1048576 },
    });
    expect(request.mock.calls[0]?.[0].headers).toMatchObject({
      "Content-Range": "bytes */1048576",
      "Content-Length": "0",
    });
  });
  it("rejects malformed/out-of-bounds ranges and hostile session URLs without requests", async () => {
    const { drive, request } = fixture(async () =>
      response({}, 308, { range: "bytes=1-9999999999" }),
    );
    await expect(drive.queryResumable(session, 1048576)).rejects.toThrow(
      /^driveVerificationFailed$/,
    );
    await expect(
      drive.queryResumable("https://evil.test/upload?upload_id=secret", 1048576),
    ).rejects.toThrow(/^driveVerificationFailed$/);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("streams one bounded file chunk and reports bytes sent separately from acknowledged bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mv-drive-chunk-"));
    roots.push(root);
    const filePath = join(root, "movie.mp4");
    await writeFile(filePath, Buffer.alloc(1024 * 1024, 7));
    const modifiedAt = (await stat(filePath)).mtimeMs;
    let sent = 0;
    const progress: number[] = [];
    const { drive, request } = fixture(async (input) => {
      expect(input.body).toBeInstanceOf(Readable);
      for await (const raw of input.body as Readable) {
        const chunk = raw as Buffer;
        expect(chunk.length).toBeLessThanOrEqual(65536);
        sent += chunk.length;
        input.onUploadProgress?.(sent);
      }
      return response({}, 308, { range: "bytes=0-131071" });
    });
    expect(
      await drive.uploadChunk({
        sessionURL: session,
        filePath,
        fileSize: 1048576,
        modifiedAt,
        offset: 0,
        chunkSize: 262144,
        onProgress: (bytes) => progress.push(bytes),
      }),
    ).toEqual({ kind: "incomplete", uploadedBytes: 131072 });
    expect(sent).toBe(262144);
    expect(progress.at(-1)).toBe(262144);
    expect(request.mock.calls[0]?.[0].headers?.["Content-Range"]).toBe("bytes 0-262143/1048576");
  });
  it("rejects a changed source before sending and after a chunk has streamed", async () => {
    const root = await mkdtemp(join(tmpdir(), "mv-drive-change-"));
    roots.push(root);
    const filePath = join(root, "movie.mp4");
    await writeFile(filePath, Buffer.alloc(262144));
    const modifiedAt = (await stat(filePath)).mtimeMs;
    const { drive, request } = fixture(async (input) => {
      for await (const _chunk of input.body as Readable) {
        /* Consume source. */
      }
      await writeFile(filePath, Buffer.alloc(1));
      return response({}, 308);
    });
    await expect(
      drive.uploadChunk({
        sessionURL: session,
        filePath,
        fileSize: 262144,
        modifiedAt: modifiedAt - 1000,
        offset: 0,
      }),
    ).rejects.toThrow(/^fileChanged$/);
    expect(request).not.toHaveBeenCalled();
    await expect(
      drive.uploadChunk({ sessionURL: session, filePath, fileSize: 262144, modifiedAt, offset: 0 }),
    ).rejects.toThrow(/^fileChanged$/);
  });
  it("refreshes once after401, maps quota/rate errors, and does not retry session creation on409", async () => {
    const replies = [
      response({}, 401),
      response({ storageQuota: { limit: "2000", usage: "100" } }),
      response({ error: { errors: [{ reason: "storageQuotaExceeded" }] } }, 403),
      response({}, 429, { "retry-after": "5" }),
      response({}, 409),
    ];
    const { drive, getAccessToken, request } = fixture(async () => replies.shift()!);
    expect(await drive.getQuota()).toEqual({ storageLimit: 2000, storageUsed: 100 });
    expect(getAccessToken).toHaveBeenLastCalledWith(undefined, true);
    await expect(drive.getQuota()).rejects.toMatchObject({
      code: "driveQuotaExceeded",
      retryable: false,
    });
    await expect(drive.getQuota()).rejects.toMatchObject({
      code: "driveUnavailable",
      retryable: true,
      retryAfterMs: 5000,
    });
    await expect(
      drive.startResumable({
        fileId: "planned-id",
        folderId: "root-id",
        name: "Movie.mp4",
        mimeType: "video/mp4",
        fileSize: 1,
        mediaId: "media",
        uploadId: "upload",
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(request).toHaveBeenCalledTimes(5);
  });
  it("reuses only an owned root folder and serializes collision names within that folder", async () => {
    const { drive } = fixture(async (input) => {
      const url = new URL(input.url);
      if (url.pathname.endsWith("root-id")) return response(rootFolder);
      expect(url.searchParams.get("q")).toContain("'root-id' in parents");
      return response({ files: [{ name: "Movie.mp4" }, { name: "Movie (1).mp4" }] });
    });
    expect(await drive.ensureRootFolder("root-id")).toEqual(rootFolder);
    expect(
      await Promise.all([
        drive.uniqueFileName("root-id", "Movie.mp4"),
        drive.uniqueFileName("root-id", "Movie.mp4"),
      ]),
    ).toEqual(["Movie (2).mp4", "Movie (3).mp4"]);
  });
  it("validates file identity and unknown JSON shapes instead of trusting successful status", async () => {
    const { drive } = fixture(async () => response({ ...file, id: "wrong-id" }));
    await expect(drive.getFile("planned-id")).rejects.toThrow(/^driveVerificationFailed$/);
    const invalid = fixture(async () => response({ storageQuota: { limit: "NaN" } }));
    await expect(invalid.drive.getQuota()).rejects.toThrow(/^driveVerificationFailed$/);
  });
  it("reopens the bounded chunk after401 and closes the descriptor after abort", async () => {
    const root = await mkdtemp(join(tmpdir(), "mv-drive-replay-"));
    roots.push(root);
    const filePath = join(root, "replay.mp4");
    await writeFile(filePath, Buffer.alloc(262144, 5));
    const modifiedAt = (await stat(filePath)).mtimeMs;
    const counts: number[] = [];
    const { drive } = fixture(async (input) => {
      let bytes = 0;
      for await (const chunk of input.body as Readable) bytes += (chunk as Buffer).length;
      counts.push(bytes);
      return counts.length === 1
        ? response({}, 401)
        : response({}, 308, { range: "bytes=0-262143" });
    });
    expect(
      await drive.uploadChunk({
        sessionURL: session,
        filePath,
        fileSize: 262144,
        modifiedAt,
        offset: 0,
      }),
    ).toEqual({ kind: "incomplete", uploadedBytes: 262144 });
    expect(counts).toEqual([262144, 262144]);
    const controller = new AbortController();
    const cancelled = fixture(async (input) => {
      for await (const _chunk of input.body as Readable) {
        controller.abort();
        break;
      }
      return response({}, 308);
    });
    await expect(
      cancelled.drive.uploadChunk(
        { sessionURL: session, filePath, fileSize: 262144, modifiedAt, offset: 0 },
        controller.signal,
      ),
    ).rejects.toThrow(/^cancelled$/);
    // Windows would reject removal if a pending descriptor remained open.
    await rm(filePath);
    expect(await stat(filePath).catch(() => undefined)).toBeUndefined();
  });
  it("creates one tagged root and reconciles its generated ID after an ambiguous response", async () => {
    let posts = 0;
    const { drive } = fixture(async (input) => {
      const url = new URL(input.url);
      if (url.pathname.endsWith("generateIds")) return response({ ids: ["new-root"] });
      if (input.method === "POST") {
        posts++;
        expect(JSON.parse(String(input.body))).toMatchObject({
          id: "new-root",
          appProperties: { mediavault: "1", role: "root" },
        });
        throw new Error("network interrupted");
      }
      if (url.pathname.endsWith("new-root")) return response({ ...rootFolder, id: "new-root" });
      return response({ files: [] });
    });
    expect((await drive.ensureRootFolder()).id).toBe("new-root");
    expect(posts).toBe(1);
  });
  it("does not list a foreign destination and rejects a resumable redirect outside Google", async () => {
    const { drive, request } = fixture(async () => response({ ...rootFolder, appProperties: {} }));
    await expect(drive.uniqueFileName("root-id", "Movie.mp4")).rejects.toThrow(
      /^drivePermissionDenied$/,
    );
    expect(request).toHaveBeenCalledTimes(1);
    const hostile = fixture(async () =>
      response({}, 200, { location: "https://evil.test/upload?upload_id=secret" }),
    );
    await expect(
      hostile.drive.startResumable({
        fileId: "planned-id",
        folderId: "root-id",
        name: "Movie.mp4",
        mimeType: "video/mp4",
        fileSize: 1,
        mediaId: "media",
        uploadId: "upload",
      }),
    ).rejects.toThrow(/^driveVerificationFailed$/);
  });
});
