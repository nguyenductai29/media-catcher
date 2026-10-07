import type { EventEmitter } from "node:events";
import type { RequestOptions } from "node:http";
import { Transform, type Readable, type TransformCallback } from "node:stream";
export type UpdateResponse = Readable & {
  statusCode: number;
  statusMessage?: string;
  headers: Record<string, string | string[] | undefined>;
};
interface UpdateRequest extends EventEmitter {
  abort(): void;
}
interface UpdateExecutor {
  createRequest(
    options: RequestOptions,
    callback: (response: UpdateResponse) => void,
  ): UpdateRequest;
}
class BoundedUpdateStream extends Transform {
  private bytes = 0;
  private readonly destinations = new Set<NodeJS.WritableStream>();
  constructor(private readonly limit: number) {
    super({ highWaterMark: 64 * 1024 });
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, next: TransformCallback): void {
    this.bytes += chunk.length;
    // Never forward the overflowing chunk to metadata accumulation or a file writer.
    if (this.bytes > this.limit) next(new Error("updateFailed"));
    else next(null, chunk);
  }
  override pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T {
    this.destinations.add(destination);
    destination.once("close", () => this.destinations.delete(destination));
    return super.pipe(destination, options);
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    // Node pipe() does not forward source errors. The updater's digest/file pipeline
    // must receive the failure too so its own error handler closes the installer file.
    if (error)
      for (const destination of this.destinations) {
        if ("destroy" in destination && typeof destination.destroy === "function")
          destination.destroy(error);
      }
    this.destinations.clear();
    callback(error);
  }
}
export class UpdateRequestGuard {
  private context:
    | {
        signal: AbortSignal;
        limit: number;
        count: number;
        stopped: boolean;
        active: Set<(error: Error) => void>;
        fail(error: Error): void;
      }
    | undefined;
  private readonly attached = new WeakSet<UpdateExecutor>();
  constructor(private readonly allow: (url: string) => boolean) {}

  /** Public executor method, attached via ProviderRuntimeOptions; no private updater access. */
  attach(executor: UpdateExecutor): void {
    if (this.attached.has(executor)) return;
    this.attached.add(executor);
    const original = executor.createRequest.bind(executor);
    executor.createRequest = (options, callback) => {
      const context = this.context;
      if (!context || context.stopped || context.signal.aborted) throw new Error("cancelled");
      const host = options.hostname ?? options.host;
      const url = `${options.protocol ?? "https:"}//${host}${options.port ? `:${options.port}` : ""}${options.path ?? "/"}`;
      if (!this.allow(url) || ++context.count > 32) throw new Error("updateFailed");
      let source: UpdateResponse | undefined;
      let bounded: Transform | undefined;
      let settled = false;
      const cleanup = () => {
        settled = true;
        context.active.delete(stop);
      };
      const stop = (error: Error) => {
        if (settled) return;
        cleanup();
        source?.unpipe();
        source?.destroy();
        bounded?.destroy(error);
        request.abort();
        // Electron abort() does not consistently emit the upstream "aborted" event.
        request.emit("error", error);
      };
      const request = original(options, (response) => {
        source = response;
        if (context.stopped || context.signal.aborted) {
          stop(new Error("cancelled"));
          return;
        }
        const header = Object.entries(response.headers).find(
          ([name]) => name.toLowerCase() === "content-length",
        )?.[1];
        const length = Array.isArray(header)
          ? header.length === 1
            ? header[0]
            : "invalid"
          : header;
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > context.limit)) {
          context.fail(new Error("updateFailed"));
          return;
        }
        const stream = new BoundedUpdateStream(context.limit);
        bounded = stream;
        const result = Object.assign(stream, {
          statusCode: response.statusCode,
          ...(response.statusMessage === undefined
            ? {}
            : { statusMessage: response.statusMessage }),
          headers: response.headers,
        });
        stream.once("error", () =>
          context.fail(new Error(context.signal.aborted ? "cancelled" : "updateFailed")),
        );
        stream.once("end", cleanup);
        response.once("error", () => context.fail(new Error("updateFailed")));
        response.once("aborted", () => context.fail(new Error("updateFailed")));
        try {
          callback(result);
          response.pipe(stream);
        } catch {
          context.fail(new Error("updateFailed"));
        }
      });
      request.on("error", () =>
        context.fail(new Error(context.signal.aborted ? "cancelled" : "updateFailed")),
      );
      request.once("close", () => {
        if (!source) cleanup();
      });
      context.active.add(stop);
      return request;
    };
  }

  async run<T>(signal: AbortSignal, limit: number, operation: () => Promise<T>): Promise<T> {
    if (this.context) throw new Error("updateBusy");
    if (signal.aborted) throw new Error("cancelled");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("updateFailed");
    let reject!: (error: Error) => void;
    const stopped = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const context = {
      signal,
      limit,
      count: 0,
      stopped: false,
      active: new Set<(error: Error) => void>(),
      fail(error: Error) {
        if (context.stopped) return;
        context.stopped = true;
        reject(error);
        for (const stop of [...context.active]) stop(error);
      },
    };
    this.context = context;
    const abort = () => context.fail(new Error("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await Promise.race([operation(), stopped]);
    } finally {
      signal.removeEventListener("abort", abort);
      context.stopped = true;
      for (const stop of [...context.active]) stop(new Error("cancelled"));
      this.context = undefined;
    }
  }
}
