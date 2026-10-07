// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../shared/models";
import type { StoredDriveUpload } from "./models";
import { UploadWorker } from "./upload-worker";
import { DriveRequestError } from "./drive-transport";
import type {
  GoogleDriveService,
  StartResumableInput,
  UploadSessionState,
} from "./google-drive-service";

const session =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=private-capability";
const size = 20 * 1024 * 1024;
const job = (): StoredDriveUpload => ({
  id: "upload-1",
  mediaId: "media-1",
  providerAccountId: "account-a",
  localPath: "C:/Videos/movie.mp4",
  modifiedAt: 100,
  fileName: "movie.mp4",
  mimeType: "video/mp4",
  fileSize: size,
  uploadedBytes: 0,
  progress: 0,
  status: "preparing",
  attempts: 1,
  createdAt: 1,
  updatedAt: 1,
});
const remote = () => ({
  id: "reserved-file",
  name: "movie (1).mp4",
  mimeType: "video/mp4",
  size,
  trashed: false,
  parents: ["root-folder"],
  appProperties: { mediavault: "1", mediaId: "media-1", uploadId: "upload-1" },
});
function setup() {
  const order: string[] = [];
  let cloudComplete = false;
  const drive = {
    ensureRootFolder: vi.fn(async () => ({ ...remote(), id: "root-folder" })),
    uniqueFileName: vi.fn(async () => "movie (1).mp4"),
    generateFileId: vi.fn(async () => "reserved-file"),
    getFile: vi.fn(async () => (cloudComplete ? remote() : null)),
    startResumable: vi.fn(async (_input: StartResumableInput) => {
      order.push("start");
      return session;
    }),
    queryResumable: vi.fn(async (): Promise<UploadSessionState> => ({
      kind: "incomplete",
      uploadedBytes: 0,
    })),
    uploadChunk: vi.fn(async (input): Promise<UploadSessionState> => {
      const offset = Math.min(size, input.offset + input.chunkSize);
      if (offset === size) {
        cloudComplete = true;
        return { kind: "complete", file: remote() };
      }
      return { kind: "incomplete", uploadedBytes: offset };
    }),
  } satisfies Pick<
    GoogleDriveService,
    | "ensureRootFolder"
    | "uniqueFileName"
    | "generateFileId"
    | "getFile"
    | "startResumable"
    | "queryResumable"
    | "uploadChunk"
  >;
  const item = {
    id: "media-1",
    localPath: job().localPath,
    fileSize: size,
    modifiedAt: 100,
  } as MediaItem;
  const validateKnownFile = vi.fn(async () => item.localPath);
  const sleep = vi.fn(async () => {});
  const checkpoint = vi.fn((patch) => {
    if (patch.plannedFileId) order.push("persist-id");
    if (patch.sessionEncrypted) order.push("persist-session");
  });
  const store = {
    seal: vi.fn((_value: string, context: string) => `encrypted:${context}`),
    unseal: vi.fn(() => session),
  };
  const worker = new UploadWorker({
    drive,
    store,
    library: { get: () => item, validateKnownFile },
    account: () => ({
      configured: true,
      connecting: false,
      connected: true,
      providerAccountId: "account-a",
    }),
    settings: {
      get: () => ({ concurrency: 2, autoUpload: false, deleteLocal: "never", chunkSizeMiB: 8 }),
    },
    sleep,
  });
  return { drive, worker, checkpoint, order, validateKnownFile, store, sleep, item };
}

describe("resumable Drive worker", () => {
  it("persists a collision-safe filename and preallocated ID before upload, then verifies remote metadata", async () => {
    const f = setup();
    const result = await f.worker.execute(
      job(),
      f.checkpoint,
      vi.fn(),
      new AbortController().signal,
    );
    expect(result.id).toBe("reserved-file");
    expect(f.order.slice(0, 3)).toEqual(["persist-id", "start", "persist-session"]);
    expect(f.drive.uploadChunk.mock.calls.map(([input]) => input.offset)).toEqual([
      0,
      8 * 1024 * 1024,
      16 * 1024 * 1024,
    ]);
    expect(f.drive.startResumable.mock.calls[0]?.[0]).toMatchObject({
      fileId: "reserved-file",
      name: "movie (1).mp4",
      mediaId: "media-1",
      uploadId: "upload-1",
    });
    expect(JSON.stringify(f.checkpoint.mock.calls)).not.toContain("private-capability");
    expect(f.store.seal).toHaveBeenCalledWith(session, "account-a:upload-1");
    expect(f.drive.getFile).toHaveBeenLastCalledWith("reserved-file", expect.any(AbortSignal));
  });
  it("queries the server offset on resume instead of trusting saved progress", async () => {
    const f = setup();
    const offset = 8 * 1024 * 1024;
    f.drive.queryResumable.mockResolvedValueOnce({ kind: "incomplete", uploadedBytes: offset });
    await f.worker.execute(
      {
        ...job(),
        plannedFileId: "reserved-file",
        driveFolderId: "root-folder",
        sessionEncrypted: "cipher",
        uploadedBytes: 123,
      },
      f.checkpoint,
      vi.fn(),
      new AbortController().signal,
    );
    expect(f.drive.uploadChunk.mock.calls[0]?.[0].offset).toBe(offset);
    expect(f.drive.startResumable).not.toHaveBeenCalled();
  });
  it("replaces an expired session while keeping the preallocated ID", async () => {
    const f = setup();
    f.drive.queryResumable.mockResolvedValueOnce({ kind: "expired" });
    await f.worker.execute(
      {
        ...job(),
        plannedFileId: "reserved-file",
        driveFolderId: "root-folder",
        sessionEncrypted: "cipher",
      },
      f.checkpoint,
      vi.fn(),
      new AbortController().signal,
    );
    expect(f.drive.generateFileId).not.toHaveBeenCalled();
    expect(f.drive.startResumable).toHaveBeenCalledTimes(1);
    expect(f.checkpoint).toHaveBeenCalledWith(expect.objectContaining({ sessionEncrypted: null }));
  });
  it("queries accepted bytes after a lost chunk response and never blindly resends", async () => {
    const f = setup();
    f.drive.uploadChunk.mockRejectedValueOnce(new DriveRequestError("driveUnavailable", true));
    f.drive.queryResumable.mockResolvedValueOnce({
      kind: "incomplete",
      uploadedBytes: 8 * 1024 * 1024,
    });
    await f.worker.execute(job(), f.checkpoint, vi.fn(), new AbortController().signal);
    expect(f.drive.uploadChunk.mock.calls.map(([input]) => input.offset)).toEqual([
      0,
      8 * 1024 * 1024,
      16 * 1024 * 1024,
    ]);
    expect(f.sleep).toHaveBeenCalledTimes(1);
  });
  it("bounds retries and does not retry permission errors", async () => {
    const f = setup();
    f.drive.uploadChunk.mockRejectedValue(new DriveRequestError("driveUnavailable", true));
    await expect(
      f.worker.execute(job(), f.checkpoint, vi.fn(), new AbortController().signal),
    ).rejects.toThrow("driveUnavailable");
    expect(f.drive.uploadChunk).toHaveBeenCalledTimes(3);
    expect(f.sleep).toHaveBeenCalledTimes(2);
    const g = setup();
    g.drive.uploadChunk.mockRejectedValue(new DriveRequestError("drivePermissionDenied", false));
    await expect(
      g.worker.execute(job(), g.checkpoint, vi.fn(), new AbortController().signal),
    ).rejects.toThrow("drivePermissionDenied");
    expect(g.drive.uploadChunk).toHaveBeenCalledTimes(1);
    expect(g.sleep).not.toHaveBeenCalled();
  });
  it("reconciles a successful upload without reading or uploading a missing local file", async () => {
    const f = setup();
    f.drive.getFile.mockResolvedValue(remote());
    f.validateKnownFile.mockRejectedValue(new Error("fileMissing"));
    const stored = { ...job(), plannedFileId: "reserved-file", driveFolderId: "root-folder" };
    expect((await f.worker.reconcile(stored, new AbortController().signal))?.id).toBe(
      "reserved-file",
    );
    await f.worker.execute(stored, f.checkpoint, vi.fn(), new AbortController().signal);
    expect(f.drive.startResumable).not.toHaveBeenCalled();
    expect(f.validateKnownFile).not.toHaveBeenCalled();
  });
  it("rejects changed local metadata and mismatched remote size before completion", async () => {
    const f = setup();
    f.item.modifiedAt++;
    await expect(
      f.worker.execute(job(), f.checkpoint, vi.fn(), new AbortController().signal),
    ).rejects.toThrow("fileChanged");
    expect(f.drive.uploadChunk).not.toHaveBeenCalled();
    const g = setup();
    g.drive.getFile.mockResolvedValue({ ...remote(), size: size - 1 });
    await expect(
      g.worker.reconcile(
        { ...job(), plannedFileId: "reserved-file", driveFolderId: "root-folder" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("driveVerificationFailed");
  });
  it("starts no network upload if the preallocated ID cannot be persisted", async () => {
    const f = setup();
    f.checkpoint.mockImplementation(() => {
      throw new Error("databaseFailed");
    });
    await expect(
      f.worker.execute(job(), f.checkpoint, vi.fn(), new AbortController().signal),
    ).rejects.toThrow("databaseFailed");
    expect(f.drive.startResumable).not.toHaveBeenCalled();
  });
  it("polls a fully acknowledged308 until metadata confirms completion without resending bytes", async () => {
    const f = setup();
    f.drive.getFile.mockResolvedValueOnce(null).mockResolvedValue(remote());
    f.drive.queryResumable
      .mockResolvedValueOnce({ kind: "incomplete", uploadedBytes: size })
      .mockResolvedValueOnce({ kind: "incomplete", uploadedBytes: size })
      .mockResolvedValueOnce({ kind: "complete", file: remote() });
    const stored = {
      ...job(),
      plannedFileId: "reserved-file",
      driveFolderId: "root-folder",
      sessionEncrypted: "cipher",
    };
    expect(
      (await f.worker.execute(stored, f.checkpoint, vi.fn(), new AbortController().signal)).id,
    ).toBe("reserved-file");
    expect(f.drive.queryResumable).toHaveBeenCalledTimes(3);
    expect(f.sleep).toHaveBeenCalledTimes(2);
    expect(f.drive.uploadChunk).not.toHaveBeenCalled();
    expect(f.drive.startResumable).not.toHaveBeenCalled();
    expect(f.drive.getFile).toHaveBeenCalledTimes(2);
  });
  it("bounds finalization polling and never claims completion from a full Range alone", async () => {
    const f = setup();
    f.drive.queryResumable.mockResolvedValue({ kind: "incomplete", uploadedBytes: size });
    const stored = {
      ...job(),
      plannedFileId: "reserved-file",
      driveFolderId: "root-folder",
      sessionEncrypted: "cipher",
    };
    await expect(
      f.worker.execute(stored, f.checkpoint, vi.fn(), new AbortController().signal),
    ).rejects.toThrow("driveUnavailable");
    expect(f.drive.queryResumable).toHaveBeenCalledTimes(4);
    expect(f.sleep).toHaveBeenCalledTimes(3);
    expect(f.drive.uploadChunk).not.toHaveBeenCalled();
    expect(f.drive.startResumable).not.toHaveBeenCalled();
  });
});
