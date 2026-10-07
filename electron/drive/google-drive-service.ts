import { open, stat, type FileHandle } from "node:fs/promises";
import { extname } from "node:path";
import { Readable } from "node:stream";
import type { GoogleAuthService } from "./google-auth-service";
import {
  DriveRequestError,
  GoogleHttpsTransport,
  googleResponseError,
  jsonObject,
  validateSessionUrl,
  type DriveHttpRequest,
  type DriveHttpResponse,
  type DriveTransport,
} from "./drive-transport";
export { DriveRequestError } from "./drive-transport";

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  trashed: boolean;
  parents: string[];
  appProperties: Record<string, string>;
}
export type UploadSessionState =
  | { kind: "incomplete"; uploadedBytes: number }
  | { kind: "complete"; file: DriveFileMetadata }
  | { kind: "expired" };
export interface StartResumableInput {
  fileId: string;
  folderId: string;
  name: string;
  mimeType: string;
  fileSize: number;
  mediaId: string;
  uploadId: string;
}
export interface UploadChunkInput {
  sessionURL: string;
  filePath: string;
  fileSize: number;
  modifiedAt: number;
  offset: number;
  chunkSize?: number;
  onProgress?: (bytes: number) => void;
}
export interface GoogleDriveOptions {
  auth: Pick<GoogleAuthService, "getAccessToken" | "getAccount">;
  transport?: DriveTransport;
}
const BASE = "https://www.googleapis.com/drive/v3";
const FIELDS = "id,name,mimeType,size,trashed,parents,appProperties";
const FOLDER = "application/vnd.google-apps.folder";
const UNIT = 256 * 1024;
function invalid(): never {
  throw new DriveRequestError("driveVerificationFailed", false);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) invalid();
  return value;
}
function textValue(value: unknown, max = 1024): string {
  if (typeof value !== "string" || !value.length || value.length > max || /\p{Cc}/u.test(value))
    invalid();
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    invalid();
  return Number(value);
}
function size(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new DriveRequestError("invalidInput", false);
}
export function parseDriveFile(value: unknown): DriveFileMetadata {
  const data = object(value);
  if (
    typeof data.trashed !== "boolean" ||
    !Array.isArray(data.parents) ||
    data.parents.length > 100
  )
    invalid();
  const properties: Record<string, string> = {};
  if (data.appProperties !== undefined) {
    const source = object(data.appProperties);
    if (Object.keys(source).length > 100) invalid();
    for (const [key, value] of Object.entries(source)) {
      textValue(key, 124);
      properties[key] = textValue(value, 124);
    }
  }
  return {
    id: id(data.id),
    name: textValue(data.name),
    mimeType: textValue(data.mimeType, 255),
    trashed: data.trashed,
    parents: data.parents.map(id),
    appProperties: properties,
    ...(data.size !== undefined ? { size: integer(data.size) } : {}),
  };
}
function ownedRoot(file: DriveFileMetadata): boolean {
  return (
    !file.trashed &&
    file.mimeType === FOLDER &&
    file.appProperties.mediavault === "1" &&
    file.appProperties.role === "root"
  );
}
function chunkStream(handle: FileHandle, start: number, end: number): Readable {
  // Destroying a FileHandle-created ReadStream closes its shared descriptor even
  // with autoClose:false. A generator keeps descriptor ownership in uploadChunk.
  return Readable.from(
    (async function* () {
      for (let position = start; position <= end;) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - position + 1));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) throw new DriveRequestError("fileChanged", false);
        position += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    })(),
    { objectMode: false, highWaterMark: 64 * 1024 },
  );
}

/** Google resources only; every uploaded file is tagged and uses a preallocated ID. */
export class GoogleDriveService {
  private readonly transport: DriveTransport;
  private rootPending: { account: string; promise: Promise<DriveFileMetadata> } | undefined;
  private namePending: Promise<unknown> = Promise.resolve();
  private readonly reservations = new Map<string, Set<string>>();
  constructor(private readonly options: GoogleDriveOptions) {
    this.transport = options.transport ?? new GoogleHttpsTransport();
  }
  private account(): string {
    const account = this.options.auth.getAccount();
    if (!account.connected || !account.providerAccountId)
      throw new DriveRequestError("driveNotConnected", false);
    return account.providerAccountId;
  }
  private async request(
    factory: () => DriveHttpRequest,
    signal?: AbortSignal,
  ): Promise<DriveHttpResponse> {
    const account = this.account();
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new DriveRequestError("cancelled", false);
      const token =
        attempt === 0
          ? await this.options.auth.getAccessToken(signal)
          : await this.options.auth.getAccessToken(signal, true);
      if (this.account() !== account) throw new DriveRequestError("driveAccountChanged", false);
      const input = factory();
      let response: DriveHttpResponse;
      try {
        response = await this.transport.request({
          ...input,
          headers: { ...input.headers, Authorization: `Bearer ${token}` },
          ...(signal ? { signal } : {}),
        });
      } finally {
        if (typeof input.body === "object") input.body.destroy();
      }
      if (signal?.aborted) throw new DriveRequestError("cancelled", false);
      if (this.account() !== account) throw new DriveRequestError("driveAccountChanged", false);
      if (response.status === 401 && attempt === 0) continue;
      return response;
    }
    throw new DriveRequestError("driveTokenExpired", false);
  }
  async getQuota(signal?: AbortSignal): Promise<{ storageLimit?: number; storageUsed?: number }> {
    const response = await this.request(
      () => ({ url: `${BASE}/about?fields=storageQuota(limit,usage)`, method: "GET" }),
      signal,
    );
    if (response.status !== 200) throw googleResponseError(response);
    const quota = object(jsonObject(response).storageQuota);
    return {
      ...(quota.limit !== undefined ? { storageLimit: integer(quota.limit) } : {}),
      ...(quota.usage !== undefined ? { storageUsed: integer(quota.usage) } : {}),
    };
  }
  async generateFileId(signal?: AbortSignal): Promise<string> {
    const response = await this.request(
      () => ({ url: `${BASE}/files/generateIds?count=1&space=drive&type=files`, method: "GET" }),
      signal,
    );
    if (response.status !== 200) throw googleResponseError(response);
    const data = jsonObject(response);
    if (!Array.isArray(data.ids) || data.ids.length !== 1) invalid();
    return id(data.ids[0]);
  }
  async getFile(fileId: string, signal?: AbortSignal): Promise<DriveFileMetadata | null> {
    const response = await this.request(
      () => ({ url: `${BASE}/files/${id(fileId)}?fields=${FIELDS}`, method: "GET" }),
      signal,
    );
    if (response.status === 404) return null;
    if (response.status !== 200) throw googleResponseError(response);
    const file = parseDriveFile(jsonObject(response));
    if (file.id !== fileId) invalid();
    return file;
  }
  async ensureRootFolder(existingId?: string, signal?: AbortSignal): Promise<DriveFileMetadata> {
    const account = this.account();
    if (this.rootPending?.account === account) return this.rootPending.promise;
    const promise = this.findOrCreateRoot(existingId, signal);
    this.rootPending = { account, promise };
    try {
      return await promise;
    } finally {
      if (this.rootPending?.promise === promise) this.rootPending = undefined;
    }
  }
  private async findOrCreateRoot(
    existingId?: string,
    signal?: AbortSignal,
  ): Promise<DriveFileMetadata> {
    if (existingId) {
      const existing = await this.getFile(existingId, signal);
      if (existing && ownedRoot(existing)) return existing;
    }
    const query = new URLSearchParams({
      q: `trashed = false and mimeType = '${FOLDER}' and 'root' in parents and appProperties has { key='mediavault' and value='1' } and appProperties has { key='role' and value='root' }`,
      spaces: "drive",
      pageSize: "100",
      fields: `files(${FIELDS}),nextPageToken`,
      orderBy: "createdTime",
    });
    const response = await this.request(
      () => ({ url: `${BASE}/files?${query}`, method: "GET" }),
      signal,
    );
    if (response.status !== 200) throw googleResponseError(response);
    const data = jsonObject(response);
    if (!Array.isArray(data.files) || data.files.length > 100) invalid();
    for (const entry of data.files) {
      const file = parseDriveFile(entry);
      if (ownedRoot(file)) return file;
    }
    // A preallocated folder ID makes the creation itself safe to reconcile on timeout.
    const fileId = await this.generateFileId(signal);
    const metadata = {
      id: fileId,
      name: "MediaVault",
      mimeType: FOLDER,
      parents: ["root"],
      appProperties: { mediavault: "1", role: "root" },
    };
    try {
      const created = await this.request(
        () => ({
          url: `${BASE}/files?fields=${FIELDS}`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(metadata),
        }),
        signal,
      );
      if (created.status !== 200 && created.status !== 201) throw googleResponseError(created);
      const file = parseDriveFile(jsonObject(created));
      if (file.id !== fileId || !ownedRoot(file)) invalid();
      return file;
    } catch (error) {
      if (signal?.aborted) throw error;
      // Query the known ID once; never blindly repeat a create POST.
      const recovered = await this.getFile(fileId, signal).catch(() => null);
      if (recovered && ownedRoot(recovered)) return recovered;
      throw error;
    }
  }
  async uniqueFileName(
    folderId: string,
    desiredName: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const account = this.account();
    id(folderId);
    textValue(desiredName, 255);
    if (/[\\/]/.test(desiredName)) throw new DriveRequestError("invalidInput", false);
    const operation = this.namePending
      .catch(() => {})
      .then(async () => {
        if (this.account() !== account) throw new DriveRequestError("driveAccountChanged", false);
        const folder = await this.getFile(folderId, signal);
        if (!folder || !ownedRoot(folder))
          throw new DriveRequestError("drivePermissionDenied", false);
        const key = `${account}:${folderId}`;
        const names = new Set(this.reservations.get(key));
        let token: string | undefined;
        for (let page = 0; page < 100; page++) {
          const query = new URLSearchParams({
            q: `'${folderId}' in parents and trashed = false`,
            spaces: "drive",
            pageSize: "1000",
            fields: "files(name),nextPageToken",
            ...(token ? { pageToken: token } : {}),
          });
          const response = await this.request(
            () => ({ url: `${BASE}/files?${query}`, method: "GET" }),
            signal,
          );
          if (response.status !== 200) throw googleResponseError(response);
          const data = jsonObject(response);
          if (!Array.isArray(data.files) || data.files.length > 1000) invalid();
          for (const entry of data.files)
            names.add(textValue(object(entry).name).normalize("NFC").toLowerCase());
          token =
            data.nextPageToken === undefined ? undefined : textValue(data.nextPageToken, 2048);
          if (!token) break;
          if (page === 99) throw new DriveRequestError("driveUnavailable", false);
        }
        const extension = extname(desiredName).slice(0, 24);
        const stem = desiredName.slice(0, desiredName.length - extname(desiredName).length);
        let name = desiredName;
        for (let suffix = 1; names.has(name.normalize("NFC").toLowerCase()); suffix++) {
          if (suffix > 100_000) throw new DriveRequestError("driveUnavailable", false);
          const ending = ` (${suffix})${extension}`;
          name = `${stem.slice(0, 255 - ending.length)}${ending}`;
        }
        if (signal?.aborted) throw new DriveRequestError("cancelled", false);
        const reserved = this.reservations.get(key) ?? new Set<string>();
        if (reserved.size >= 10_000) throw new DriveRequestError("driveUnavailable", false);
        reserved.add(name.normalize("NFC").toLowerCase());
        this.reservations.set(key, reserved);
        return name;
      });
    this.namePending = operation.catch(() => {});
    return operation;
  }
  async startResumable(input: StartResumableInput, signal?: AbortSignal): Promise<string> {
    id(input.fileId);
    id(input.folderId);
    size(input.fileSize);
    textValue(input.name, 255);
    textValue(input.mimeType, 255);
    textValue(input.mediaId, 100);
    textValue(input.uploadId, 100);
    const metadata = {
      id: input.fileId,
      name: input.name,
      mimeType: input.mimeType,
      parents: [input.folderId],
      appProperties: { mediavault: "1", mediaId: input.mediaId, uploadId: input.uploadId },
    };
    const response = await this.request(
      () => ({
        url: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=${FIELDS}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": input.mimeType,
          "X-Upload-Content-Length": String(input.fileSize),
        },
        body: JSON.stringify(metadata),
      }),
      signal,
    );
    if (response.status === 409) throw new DriveRequestError("driveVerificationFailed", false);
    if (response.status !== 200 && response.status !== 201) throw googleResponseError(response);
    return validateSessionUrl(response.headers.location ?? "");
  }
  private state(response: DriveHttpResponse, fileSize: number): UploadSessionState {
    if (response.status === 404 || response.status === 410) return { kind: "expired" };
    if (response.status === 200 || response.status === 201)
      return { kind: "complete", file: parseDriveFile(jsonObject(response)) };
    if (response.status === 308) {
      const range = response.headers.range;
      if (range === undefined) return { kind: "incomplete", uploadedBytes: 0 };
      const match = /^bytes=0-(\d+)$/.exec(range);
      if (!match) invalid();
      const last = Number(match[1]);
      if (!Number.isSafeInteger(last) || last < 0 || last >= fileSize) invalid();
      return { kind: "incomplete", uploadedBytes: last + 1 };
    }
    throw googleResponseError(response);
  }
  async queryResumable(
    sessionURL: string,
    fileSize: number,
    signal?: AbortSignal,
  ): Promise<UploadSessionState> {
    const url = validateSessionUrl(sessionURL);
    size(fileSize);
    const response = await this.request(
      () => ({
        url,
        method: "PUT",
        headers: { "Content-Length": "0", "Content-Range": `bytes */${fileSize}` },
        body: "",
      }),
      signal,
    );
    return this.state(response, fileSize);
  }
  async uploadChunk(input: UploadChunkInput, signal?: AbortSignal): Promise<UploadSessionState> {
    const url = validateSessionUrl(input.sessionURL);
    size(input.fileSize);
    const chunkSize = input.chunkSize ?? 8 * 1024 * 1024;
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      input.offset >= input.fileSize ||
      !Number.isSafeInteger(chunkSize) ||
      chunkSize < UNIT ||
      chunkSize % UNIT !== 0 ||
      chunkSize > 64 * 1024 * 1024 ||
      !Number.isFinite(input.modifiedAt)
    )
      throw new DriveRequestError("invalidInput", false);
    const end = Math.min(input.fileSize, input.offset + chunkSize) - 1;
    try {
      const handle = await open(input.filePath, "r");
      try {
        const before = await handle.stat({ bigint: true });
        // Persisted metadata uses millisecond numbers; file identity must retain
        // all bits of Windows file IDs and nanosecond timestamps.
        const modifiedAt = Number(before.mtimeMs) + Number(before.mtimeNs % 1_000_000n) / 1_000_000;
        if (
          !before.isFile() ||
          before.size !== BigInt(input.fileSize) ||
          modifiedAt !== input.modifiedAt
        )
          throw new DriveRequestError("fileChanged", false);
        const response = await this.request(
          () => ({
            url,
            method: "PUT",
            headers: {
              "Content-Length": String(end - input.offset + 1),
              "Content-Range": `bytes ${input.offset}-${end}/${input.fileSize}`,
              "Content-Type": "application/octet-stream",
            },
            body: chunkStream(handle, input.offset, end),
            timeoutMs: 10 * 60_000,
            ...(input.onProgress ? { onUploadProgress: input.onProgress } : {}),
          }),
          signal,
        );
        const after = await handle.stat({ bigint: true });
        const current = await stat(input.filePath, { bigint: true });
        if (
          after.size !== before.size ||
          after.mtimeNs !== before.mtimeNs ||
          current.size !== before.size ||
          current.mtimeNs !== before.mtimeNs ||
          current.ino !== before.ino ||
          current.dev !== before.dev
        )
          throw new DriveRequestError("fileChanged", false);
        const state = this.state(response, input.fileSize);
        if (state.kind === "incomplete" && state.uploadedBytes > end + 1) invalid();
        return state;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof DriveRequestError) throw error;
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      throw new DriveRequestError(
        code === "ENOENT"
          ? "fileMissing"
          : code === "EACCES" || code === "EPERM"
            ? "fileAccessDenied"
            : "driveUploadFailed",
        false,
      );
    }
  }
}
