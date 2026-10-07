import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as wait } from "node:timers/promises";
import { loadFixtureManifest, openFixtureAsset } from "./generate-fixtures.mjs";

const mime = (file) =>
  file.endsWith(".m3u8")
    ? "application/vnd.apple.mpegurl"
    : file.endsWith(".mpd")
      ? "application/dash+xml"
      : file.endsWith(".ts")
        ? "video/mp2t"
        : file.endsWith(".m4s")
          ? "video/iso.segment"
          : "video/mp4";
const document = (title, content) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>MediaVault ${title}</title></head><body><h1>MediaVault ${title}</h1><p>Generated test patterns and audio; no third-party media.</p>${content}<p><a href="/">Fixture index</a></p></body></html>`;
const video = (title, source) =>
  document(
    title,
    `<video controls preload="metadata"><source src="${source}" type="${mime(source)}"></video>`,
  );

function configuration(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["offline", "throttleKiB", "interruptAfterKiB"].includes(key))
  )
    throw new Error("Invalid network fixture options.");
  if (
    ("offline" in value && typeof value.offline !== "boolean") ||
    ("throttleKiB" in value &&
      (!Number.isSafeInteger(value.throttleKiB) ||
        value.throttleKiB < 0 ||
        value.throttleKiB > 65536)) ||
    ("interruptAfterKiB" in value &&
      (!Number.isSafeInteger(value.interruptAfterKiB) ||
        value.interruptAfterKiB < 0 ||
        value.interruptAfterKiB > 2 * 1024 * 1024))
  )
    throw new Error("Invalid network fixture options.");
  return value;
}
function rangeOf(header, bytes) {
  if (header === undefined) return { start: 0, end: bytes - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if (
    (first !== undefined && !Number.isSafeInteger(first)) ||
    (last !== undefined && !Number.isSafeInteger(last))
  )
    return null;
  const start = first === undefined ? Math.max(0, bytes - last) : first;
  const end = first === undefined || last === undefined ? bytes - 1 : Math.min(last, bytes - 1);
  if (start < 0 || start >= bytes || start > end || (first === undefined && last === 0))
    return null;
  return { start, end, partial: true };
}

export async function startFixtureServer(
  { directory, port = 0, throttleKiB = 0, interruptAfterKiB = 0 } = {},
  { openAsset = openFixtureAsset } = {},
) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid loopback fixture port.");
  const files = await loadFixtureManifest(directory);
  let network = { offline: false, ...configuration({ throttleKiB, interruptAfterKiB }) };
  const cookieName = "mv_fixture_session";
  const cookieValue = randomBytes(24).toString("hex");
  const streams = new Set();
  const work = new Set();
  const sockets = new Set();
  const counts = {
    requests: 0,
    mediaRequests: 0,
    authenticated: 0,
    rejectedAuth: 0,
    rangeRequests: 0,
  };
  let origin;
  let closed = false;
  let closing;
  const send = (request, response, status, body = "", headers = {}) => {
    response.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    });
    response.end(request.method === "HEAD" ? undefined : body);
  };
  async function handle(request, response) {
    counts.requests++;
    if (request.headers.host !== new URL(origin).host) {
      send(request, response, 400);
      return;
    }
    if (!["GET", "HEAD"].includes(request.method)) {
      send(request, response, 405, "", { Allow: "GET, HEAD" });
      return;
    }
    if (network.offline) {
      send(request, response, 503, "Fixture network is offline.", { "Retry-After": "1" });
      return;
    }
    let path;
    try {
      const target = request.url;
      if (!target?.startsWith("/") || target.startsWith("//")) throw new Error();
      path = decodeURIComponent(target.split("?", 1)[0]);
      if (/[\\\p{Cc}]/u.test(path) || path.split("/").some((part) => part === "." || part === ".."))
        throw new Error();
    } catch {
      send(request, response, 400);
      return;
    }
    if (path === "/login") {
      send(
        request,
        response,
        200,
        document("signed-in fixture", '<a href="/protected-video">Open protected video</a>'),
        { "Set-Cookie": `${cookieName}=${cookieValue}; HttpOnly; Path=/; SameSite=Lax` },
      );
      return;
    }
    if (path === "/logout") {
      send(request, response, 200, document("signed-out fixture", ""), {
        "Set-Cookie": `${cookieName}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
      });
      return;
    }
    if (["/protected-video", "/protected.mp4"].includes(path)) {
      const authorized = (request.headers.cookie ?? "")
        .split(";")
        .some((part) => part.trim() === `${cookieName}=${cookieValue}`);
      if (!authorized) {
        counts.rejectedAuth++;
        send(
          request,
          response,
          401,
          document("sign-in required", '<a href="/login">Sign in to this local test fixture</a>'),
        );
        return;
      }
      counts.authenticated++;
      if (path === "/protected-video") {
        send(request, response, 200, video("protected video", "/protected.mp4"));
        return;
      }
      path = "/clip-60s.mp4";
    }
    const pages = new Map([
      ["/video-10s", "clip-10s.mp4"],
      ["/video-60s", "clip-60s.mp4"],
      ["/hls-video", "hls/index.m3u8"],
      ["/dash-video", "dash/index.mpd"],
      ["/video-large", "large.mp4"],
    ]);
    if (path === "/") {
      const links = [...pages]
        .filter(([, file]) => files.assets.has(file))
        .map(
          ([page, file]) =>
            `<li><a href="${page}">${file}</a> · <a href="/${file}">direct media</a></li>`,
        )
        .join("");
      send(
        request,
        response,
        200,
        document(
          "local media fixtures",
          `<ul>${links}<li><a href="/login">Local test login</a> · <a href="/protected-video">Protected video</a> · <a href="/logout">Logout</a></li></ul>`,
        ),
      );
      return;
    }
    if (pages.has(path) && files.assets.has(pages.get(path))) {
      send(request, response, 200, video("generated video", `/${pages.get(path)}`));
      return;
    }
    const file = path.slice(1);
    const expected = files.assets.get(file);
    if (!expected) {
      send(request, response, 404);
      return;
    }
    let opened;
    try {
      opened = await openAsset(files.directory, file);
      // Opening a file can yield past disconnect, shutdown, or a terminal offline command.
      // Recheck before attaching a stream so no already-fired close event is missed.
      if (closed || response.destroyed) return;
      if (network.offline) {
        send(request, response, 503, "Fixture network is offline.", { "Retry-After": "1" });
        return;
      }
      const identity = expected.identity;
      if (
        opened.info.size !== BigInt(expected.bytes) ||
        opened.info.ino !== identity.ino ||
        opened.info.dev !== identity.dev ||
        opened.info.mtimeNs !== identity.mtimeNs
      )
        throw new Error();
      const range = rangeOf(request.headers.range, expected.bytes);
      if (!range) {
        send(request, response, 416, "", { "Content-Range": `bytes */${expected.bytes}` });
        return;
      }
      counts.mediaRequests++;
      if (range.partial) counts.rangeRequests++;
      response.writeHead(range.partial ? 206 : 200, {
        "Content-Type": mime(file),
        "Content-Length": range.end - range.start + 1,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(range.partial
          ? { "Content-Range": `bytes ${range.start}-${range.end}/${expected.bytes}` }
          : {}),
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const controller = new AbortController();
      const active = { controller, response };
      streams.add(active);
      const abort = () => controller.abort();
      response.once("close", abort);
      const source = opened.handle.createReadStream({
        start: range.start,
        end: range.end,
        highWaterMark: 64 * 1024,
        autoClose: false,
      });
      response.flushHeaders();
      let sent = 0;
      try {
        for await (let chunk of source) {
          if (controller.signal.aborted || closed) break;
          const limit = network.interruptAfterKiB * 1024;
          if (limit && sent + chunk.length > limit) chunk = chunk.subarray(0, limit - sent);
          if (network.throttleKiB)
            await wait(
              Math.max(1, (chunk.length / (network.throttleKiB * 1024)) * 1000),
              undefined,
              { signal: controller.signal },
            );
          if (!response.write(chunk)) await once(response, "drain", { signal: controller.signal });
          sent += chunk.length;
          if (limit && sent >= limit) {
            await wait(10, undefined, { signal: controller.signal });
            response.destroy();
            break;
          }
        }
        if (!response.destroyed) response.end();
      } finally {
        source.destroy();
        response.removeListener("close", abort);
        controller.abort();
        streams.delete(active);
      }
    } catch {
      if (!response.headersSent) send(request, response, 404);
      else response.destroy();
    } finally {
      await opened?.handle.close();
    }
  }
  const server = createServer((request, response) => {
    const task = handle(request, response).catch(() => response.destroy());
    work.add(task);
    void task.finally(() => work.delete(task));
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    manifest: files.manifest,
    status: () => ({ ...counts, ...network, activeStreams: streams.size }),
    configure(value) {
      if (closed) throw new Error("Fixture server is closed.");
      network = { ...network, ...configuration(value) };
      if (network.offline)
        for (const stream of streams) {
          stream.controller.abort();
          stream.response.destroy();
        }
    },
    close() {
      closing ??= (async () => {
        closed = true;
        for (const stream of streams) {
          stream.controller.abort();
          stream.response.destroy();
        }
        const stopped = new Promise((done) => server.close(done));
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        await stopped;
        await Promise.allSettled([...work]);
      })();
      return closing;
    },
  };
}
