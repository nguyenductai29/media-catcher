// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { RequestOptions } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { UpdateRequestGuard, type UpdateResponse } from "./app-update-http";

function fixture() {
  let receive!: (response: UpdateResponse) => void;
  const request = Object.assign(new EventEmitter(), { abort: vi.fn(), end: vi.fn() });
  const executor = {
    createRequest: vi.fn(
      (_options: RequestOptions, callback: (response: UpdateResponse) => void) => {
        receive = callback;
        return request;
      },
    ),
  };
  const guard = new UpdateRequestGuard((url) => url.startsWith("https://github.com/owner/repo/"));
  guard.attach(executor);
  const response = Object.assign(new PassThrough(), {
    headers: {} as Record<string, string>,
    statusCode: 200,
    statusMessage: "OK",
  });
  let delivered = Buffer.alloc(0);
  const consume = () =>
    new Promise<string>((resolve, reject) => {
      const created = executor.createRequest(
        { protocol: "https:", hostname: "github.com", path: "/owner/repo/releases.atom" },
        (stream) => {
          expect(stream.statusCode).toBe(200);
          expect(stream.headers).toEqual(response.headers);
          stream.on("error", reject);
          stream.on("data", (chunk) => {
            delivered = Buffer.concat([delivered, Buffer.from(chunk)]);
          });
          stream.on("end", () => resolve(delivered.toString()));
        },
      );
      created.on("error", reject);
    });
  return {
    guard,
    request,
    response,
    consume,
    receive: () => receive(response),
    delivered: () => delivered.toString(),
    executor,
  };
}

describe("app update response byte boundary", () => {
  it("contains malformed redirect and response handler exceptions at the network boundary", async () => {
    const f = fixture();
    const pending = f.guard.run(
      new AbortController().signal,
      6,
      () =>
        new Promise<void>((_resolve, reject) => {
          const request = f.executor.createRequest(
            { protocol: "https:", hostname: "github.com", path: "/owner/repo/redirect" },
            () => {
              throw new Error("unsafe upstream redirect detail");
            },
          );
          request.on("error", reject);
        }),
    );
    const rejected = expect(pending).rejects.toThrow("updateFailed");
    expect(() => f.receive()).not.toThrow();
    await rejected;
    expect(f.response.destroyed).toBe(true);
  });
  it("rejects a chunked metadata body before overflowing bytes reach the parser", async () => {
    const f = fixture();
    const result = f.guard.run(new AbortController().signal, 6, f.consume);
    const rejected = expect(result).rejects.toThrow("updateFailed");
    f.receive();
    f.response.write("1234");
    f.response.end("5678");
    await rejected;
    expect(f.delivered()).toBe("1234");
    expect(f.request.abort).toHaveBeenCalled();
    expect(f.response.destroyed).toBe(true);
  });
  it("bounds actual installer bytes even when a smaller Content-Length was advertised", async () => {
    const f = fixture();
    f.response.headers["content-length"] = "4";
    const result = f.guard.run(new AbortController().signal, 4, f.consume);
    const rejected = expect(result).rejects.toThrow("updateFailed");
    f.receive();
    f.response.end("12345");
    await rejected;
    expect(f.delivered()).toBe("");
  });
  it("rejects oversized advertised length before forwarding even a first body chunk", async () => {
    const f = fixture();
    f.response.headers["content-length"] = "7";
    const result = f.guard.run(new AbortController().signal, 6, f.consume);
    const rejected = expect(result).rejects.toThrow("updateFailed");
    f.receive();
    await rejected;
    expect(f.delivered()).toBe("");
    expect(f.request.abort).toHaveBeenCalled();
  });
  it("preserves ordinary bounded streaming and request identity", async () => {
    const f = fixture();
    const result = f.guard.run(new AbortController().signal, 6, f.consume);
    f.receive();
    f.response.write("123");
    f.response.end("456");
    await expect(result).resolves.toBe("123456");
    expect(f.request.abort).not.toHaveBeenCalled();
  });
  it("settles and aborts a request whose peer has not sent headers when cancelled", async () => {
    const f = fixture();
    const controller = new AbortController();
    const result = f.guard.run(controller.signal, 6, f.consume);
    const rejected = expect(result).rejects.toThrow("cancelled");
    controller.abort();
    await rejected;
    expect(f.request.abort).toHaveBeenCalledOnce();
  });
  it("destroys a stalled response and rejects further requests after cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    const result = f.guard.run(controller.signal, 6, f.consume);
    const rejected = expect(result).rejects.toThrow("cancelled");
    f.receive();
    f.response.write("1");
    controller.abort();
    await rejected;
    expect(f.response.destroyed).toBe(true);
    expect(() =>
      f.executor.createRequest(
        { protocol: "https:", hostname: "github.com", path: "/owner/repo/late" },
        () => {},
      ),
    ).toThrow("cancelled");
  });
  it("rejects requests outside the pinned repository before reaching the network", async () => {
    const f = fixture();
    await expect(
      f.guard.run(new AbortController().signal, 6, async () => {
        f.executor.createRequest(
          { protocol: "http:", hostname: "github.com", path: "/owner/repo/asset" },
          () => {},
        );
      }),
    ).rejects.toThrow("updateFailed");
    expect(f.request.abort).not.toHaveBeenCalled();
  });
  it("destroys the downstream installer pipeline when a response exceeds its byte cap", async () => {
    const f = fixture();
    const destination = new PassThrough();
    const pending = f.guard.run(
      new AbortController().signal,
      4,
      () =>
        new Promise<void>((resolve, reject) => {
          const request = f.executor.createRequest(
            { protocol: "https:", hostname: "github.com", path: "/owner/repo/installer" },
            (response) => {
              response.on("error", reject);
              destination.on("error", reject);
              destination.on("finish", resolve);
              response.pipe(destination);
            },
          );
          request.on("error", reject);
        }),
    );
    const rejected = expect(pending).rejects.toThrow("updateFailed");
    f.receive();
    f.response.end("12345");
    await rejected;
    expect(destination.destroyed).toBe(true);
  });
});
