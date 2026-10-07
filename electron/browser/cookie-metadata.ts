import { createHash } from "node:crypto";

export interface CookieMetadata {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  expires: number;
  fingerprint: string;
}
export interface CookieDebugger {
  attach(): void;
  detach(): void;
  isAttached(): boolean;
  sendCommand(method: string, params: unknown): Promise<unknown>;
  on(event: "detach", listener: () => void): unknown;
  removeListener(event: "detach", listener: () => void): unknown;
}
const queues = new WeakMap<CookieDebugger, Promise<void>>();
export const cookieKey = (cookie: { domain: string; path: string; name: string }) =>
  JSON.stringify([cookie.domain.toLowerCase(), cookie.path, cookie.name]);
export const cookieFingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** CDP includes values; discard them immediately after building an in-memory identity check. */
export function parseCookieMetadata(value: unknown): CookieMetadata[] {
  if (!object(value) || !Array.isArray(value["cookies"]) || value["cookies"].length > 3000)
    throw new Error("browserSessionRequired");
  const unique = new Map<string, CookieMetadata>();
  const seen = new Set<string>();
  const blocked = new Set<string>();
  for (const item of value["cookies"] as unknown[]) {
    if (!object(item)) throw new Error("browserSessionRequired");
    const { name, domain, path } = item;
    if (typeof name !== "string" || typeof domain !== "string" || typeof path !== "string")
      throw new Error("browserSessionRequired");
    const key = cookieKey({ name, domain, path });
    if (seen.has(key) || "partitionKey" in item || "partitionKeyOpaque" in item) blocked.add(key);
    seen.add(key);
    if (blocked.has(key)) continue;
    if (
      name.length > 4096 ||
      domain.length > 254 ||
      path.length > 4096 ||
      typeof item["value"] !== "string" ||
      item["value"].length > 16384 ||
      typeof item["secure"] !== "boolean" ||
      typeof item["httpOnly"] !== "boolean" ||
      typeof item["session"] !== "boolean" ||
      typeof item["expires"] !== "number" ||
      !Number.isFinite(item["expires"])
    )
      continue;
    unique.set(key, {
      name,
      domain: domain.toLowerCase(),
      path,
      secure: item["secure"],
      httpOnly: item["httpOnly"],
      session: item["session"],
      expires: item["expires"],
      fingerprint: cookieFingerprint(item["value"]),
    });
  }
  return [...unique.entries()].filter(([key]) => !blocked.has(key)).map(([, item]) => item);
}

/** Own only this brief attachment. Never enable traffic collection or expose CDP through IPC. */
export function readCookieMetadata(
  debug: CookieDebugger,
  pageUrl: string,
  signal?: AbortSignal,
  timeout = 5000,
): Promise<CookieMetadata[]> {
  const run = async () => {
    if (signal?.aborted) throw new Error("cancelled");
    if (debug.isAttached()) throw new Error("browserSessionRequired");
    let owned = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectPending: (error: Error) => void = () => {};
    const detached = () => {
      owned = false;
      rejectPending(new Error("browserSessionRequired"));
    };
    const abort = () => rejectPending(new Error("cancelled"));
    try {
      debug.on("detach", detached);
      debug.attach();
      owned = true;
      const result = await new Promise<unknown>((resolve, reject) => {
        rejectPending = reject;
        timer = setTimeout(() => reject(new Error("browserSessionRequired")), timeout);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
          return;
        }
        debug
          .sendCommand("Network.getCookies", { urls: [pageUrl] })
          .then(resolve, () => reject(new Error("browserSessionRequired")));
      });
      if (!owned || signal?.aborted)
        throw new Error(signal?.aborted ? "cancelled" : "browserSessionRequired");
      return parseCookieMetadata(result);
    } catch {
      throw new Error(signal?.aborted ? "cancelled" : "browserSessionRequired");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (owned) {
        owned = false;
        try {
          if (debug.isAttached()) debug.detach();
        } catch {
          /* Destroyed target. */
        }
      }
      debug.removeListener("detach", detached);
    }
  };
  const result = (queues.get(debug) ?? Promise.resolve()).then(run);
  const tail = result.then(
    () => {},
    () => {},
  );
  queues.set(debug, tail);
  void tail.then(() => {
    if (queues.get(debug) === tail) queues.delete(debug);
  });
  return result;
}
