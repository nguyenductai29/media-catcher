import { session, type Session } from "electron";
import { randomUUID } from "node:crypto";

const hardenedSessions = new WeakSet<Session>();

export function createBrowserSession(persist: boolean): Session {
  const browserSession = session.fromPartition(
    persist ? "persist:mediavault-browser" : `mediavault-browser-${randomUUID()}`,
  );
  if (hardenedSessions.has(browserSession)) return browserSession;
  hardenedSessions.add(browserSession);
  browserSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(permission === "fullscreen"),
  );
  browserSession.setPermissionCheckHandler((_contents, permission) => permission === "fullscreen");
  browserSession.setDevicePermissionHandler(() => false);
  browserSession.on("will-download", (event) => event.preventDefault());
  return browserSession;
}
