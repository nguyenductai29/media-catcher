// @vitest-environment node
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  DriveRequestError,
  GoogleHttpsTransport,
  validateGoogleUrl,
  validateSessionUrl,
} from "./drive-transport";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: mocks.request }));
describe("Google HTTP boundary", () => {
  it("maps a disconnected socket to a resumable network pause without automatic retry", async () => {
    let outgoing: PassThrough | undefined;
    mocks.request.mockImplementation(() => {
      outgoing = new PassThrough();
      Object.assign(outgoing, { setTimeout: () => outgoing });
      outgoing.resume();
      return outgoing;
    });
    const body = new PassThrough();
    const pending = new GoogleHttpsTransport().request({
      url: "https://www.googleapis.com/drive/v3/files",
      method: "POST",
      body,
    });
    outgoing!.emit(
      "error",
      Object.assign(new Error("private socket details"), { code: "ENETUNREACH" }),
    );
    await expect(pending).rejects.toMatchObject({
      message: "networkUnavailable",
      retryable: false,
    });
    expect(body.destroyed).toBe(true);
  });
  it("rejects credentials, redirects to other hosts and non-Google session endpoints", () => {
    for (const url of [
      "http://www.googleapis.com/drive/v3/files",
      "https://evil.test/upload/drive/v3/files",
      "https://www.googleapis.com.evil.test/drive/v3/files",
      "https://token@www.googleapis.com/drive/v3/files",
      "https://www.googleapis.com/drive/v3/files#fragment",
    ])
      expect(() => validateGoogleUrl(url)).toThrow();
    expect(
      validateSessionUrl(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=test",
      ),
    ).toContain("upload_id=test");
    expect(() =>
      validateSessionUrl("https://www.googleapis.com/drive/v3/files?upload_id=test"),
    ).toThrow();
  });
  it("streams the request and returns308 without following Location", async () => {
    mocks.request.mockClear();
    let bytes = 0;
    mocks.request.mockImplementation((_url, _options, callback) => {
      const request = new PassThrough();
      Object.assign(request, { setTimeout: () => request });
      request.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
      });
      request.on("finish", () => {
        const response = Readable.from([Buffer.from("{}")]);
        Object.assign(response, {
          statusCode: 308,
          headers: { range: "bytes=0-8", location: "https://evil.test" },
        });
        callback(response);
      });
      return request;
    });
    const result = await new GoogleHttpsTransport().request({
      url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=test",
      method: "PUT",
      body: Readable.from([Buffer.from("streaming")]),
    });
    expect(bytes).toBe(9);
    expect(result.status).toBe(308);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("destroys an unfinished upload body when Google replies early", async () => {
    let outgoing: PassThrough | undefined;
    mocks.request.mockImplementation((_url, _options, callback) => {
      outgoing = new PassThrough();
      Object.assign(outgoing, { setTimeout: () => outgoing });
      outgoing.resume();
      queueMicrotask(() => {
        const response = Readable.from([Buffer.from("{}")]);
        Object.assign(response, { statusCode: 401, headers: {} });
        callback(response);
      });
      return outgoing;
    });
    const body = new PassThrough();
    body.write(Buffer.alloc(64));
    expect(
      (
        await new GoogleHttpsTransport().request({
          url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=test",
          method: "PUT",
          body,
        })
      ).status,
    ).toBe(401);
    expect(body.destroyed).toBe(true);
    expect(outgoing?.destroyed).toBe(true);
  });
  it("abort destroys the source and pending request without leaking transport details", async () => {
    let outgoing: PassThrough | undefined;
    mocks.request.mockImplementation(() => {
      outgoing = new PassThrough();
      Object.assign(outgoing, { setTimeout: () => outgoing });
      outgoing.resume();
      return outgoing;
    });
    const controller = new AbortController();
    const body = new PassThrough();
    const pending = new GoogleHttpsTransport().request({
      url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=test",
      method: "PUT",
      body,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/^cancelled$/);
    expect(body.destroyed).toBe(true);
    expect(outgoing?.destroyed).toBe(true);
  });
  it.each([
    [new DriveRequestError("fileChanged", false), "fileChanged"],
    [new DriveRequestError("fileAccessDenied", false), "fileAccessDenied"],
    [new DriveRequestError("fileMissing", false), "fileMissing"],
    [new Error("private-path-and-credential-diagnostics"), "fileMissing"],
    [new DriveRequestError("driveUnavailable", true), "fileMissing"],
  ] as const)("preserves only safe local-file stream errors (%s)", async (error, expected) => {
    let outgoing: PassThrough | undefined;
    mocks.request.mockImplementation(() => {
      outgoing = new PassThrough();
      Object.assign(outgoing, { setTimeout: () => outgoing });
      outgoing.resume();
      return outgoing;
    });
    const body = new PassThrough();
    const pending = new GoogleHttpsTransport().request({
      url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=test",
      method: "PUT",
      body,
    });
    body.destroy(error);
    await expect(pending).rejects.toMatchObject({
      message: expected,
      code: expected,
      retryable: false,
    });
    expect(body.destroyed).toBe(true);
    expect(outgoing?.destroyed).toBe(true);
  });
});
