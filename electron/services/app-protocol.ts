import { extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { MediaItem } from "../../shared/models";
import { validateOwnedFile } from "../downloads/download-files";
import { streamMediaFile } from "./media-stream";

interface ProtocolOptions {
  rendererRoot: string;
  thumbnailDirectory: string;
  trustedOrigin: string;
  library: { validateKnownFile(id: string): Promise<string>; get(id: string): MediaItem };
  fetchFile(url: string, options?: { headers: Record<string, string> }): Promise<Response>;
  streamMedia?: typeof streamMediaFile;
}
export function createAppProtocol(options: ProtocolOptions) {
  return async (request: Request & { initiatorOrigin?: string | undefined }): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (
        url.protocol !== "mediavault:" ||
        request.method !== "GET" ||
        url.username ||
        url.password ||
        url.port
      )
        return new Response(null, { status: 403 });
      if (url.host === "media") {
        // This non-page-controlled field is supplied by Electron. The remote
        // browser also uses a separate session without this protocol handler.
        if (request.initiatorOrigin !== options.trustedOrigin || url.search || url.hash)
          return new Response(null, { status: 403 });
        const match = /^\/([a-z0-9_-]{1,100})\/(video|thumbnail)$/i.exec(url.pathname);
        if (!match?.[1]) return new Response(null, { status: 403 });
        let path: string;
        if (match[2] === "video") path = await options.library.validateKnownFile(match[1]);
        else {
          const item = options.library.get(match[1]);
          if (!item.thumbnailPath) return new Response(null, { status: 404 });
          path = await validateOwnedFile(options.thumbnailDirectory, item.thumbnailPath);
        }
        const range = request.headers.get("range");
        if (range && !/^bytes=\d*-\d*$/.test(range)) return new Response(null, { status: 416 });
        return await (options.streamMedia ?? streamMediaFile)(path, range, request.signal);
      }
      if (url.host !== "app") return new Response(null, { status: 403 });
      const path = resolve(
        options.rendererRoot,
        `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
      );
      const rel = relative(options.rendererRoot, path);
      if (isAbsolute(rel) || rel.startsWith("..") || !extname(path))
        return new Response(null, { status: 403 });
      return await options.fetchFile(pathToFileURL(path).href);
    } catch {
      return new Response(null, { status: 404 });
    }
  };
}
