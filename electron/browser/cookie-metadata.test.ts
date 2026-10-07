// @vitest-environment node
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { readCookieMetadata, parseCookieMetadata } from "./cookie-metadata";

const cookie = {
  name: "login",
  value: "secret",
  domain: "example.com",
  path: "/",
  secure: true,
  httpOnly: true,
  session: true,
  expires: -1,
};
class DebuggerFixture extends EventEmitter {
  attached = false;
  attach = vi.fn(() => {
    this.attached = true;
  });
  detach = vi.fn(() => {
    this.attached = false;
    this.emit("detach");
  });
  isAttached = () => this.attached;
  sendCommand = vi.fn(async (_method: string, _params: unknown): Promise<unknown> => ({
    cookies: [cookie],
  }));
}
describe("Main-only cookie partition metadata", () => {
  it("keeps only unique positively identified unpartitioned cookies without retaining values", () => {
    const value = parseCookieMetadata({
      cookies: [
        cookie,
        { ...cookie, name: "partitioned", partitionKey: { topLevelSite: "https://other.test" } },
        { ...cookie, name: "opaque", partitionKeyOpaque: false },
        { ...cookie, name: "duplicate" },
        { ...cookie, name: "duplicate", partitionKeyOpaque: true },
      ],
    });
    expect(value).toHaveLength(1);
    expect(value[0]?.name).toBe("login");
    expect(JSON.stringify(value)).not.toContain("secret");
    expect(() => parseCookieMetadata({})).toThrow(/^browserSessionRequired$/);
  });
  it("uses only the explicit URL and detaches its own debugger", async () => {
    const debug = new DebuggerFixture();
    expect(await readCookieMetadata(debug, "https://example.com/private")).toHaveLength(1);
    expect(debug.sendCommand).toHaveBeenCalledExactlyOnceWith("Network.getCookies", {
      urls: ["https://example.com/private"],
    });
    expect(debug.detach).toHaveBeenCalledOnce();
  });
  it("preserves an existing attachment", async () => {
    const debug = new DebuggerFixture();
    debug.attached = true;
    await expect(readCookieMetadata(debug, "https://example.com")).rejects.toThrow(
      /^browserSessionRequired$/,
    );
    expect(debug.attach).not.toHaveBeenCalled();
    expect(debug.detach).not.toHaveBeenCalled();
  });
  it("bounds hung commands and releases its attachment", async () => {
    const debug = new DebuggerFixture();
    debug.sendCommand.mockImplementation(() => new Promise(() => {}));
    await expect(readCookieMetadata(debug, "https://example.com", undefined, 20)).rejects.toThrow(
      /^browserSessionRequired$/,
    );
    expect(debug.detach).toHaveBeenCalledOnce();
  });
  it("aborts and does not detach a replacement debugger", async () => {
    const debug = new DebuggerFixture();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    debug.sendCommand.mockImplementation(() => {
      started();
      return new Promise(() => {});
    });
    const result = readCookieMetadata(debug, "https://example.com");
    const failure = expect(result).rejects.toThrow(/^browserSessionRequired$/);
    await ready;
    debug.emit("detach"); // Another owner attaches before our finally runs.
    debug.attached = true;
    await failure;
    expect(debug.detach).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(
      readCookieMetadata(debug, "https://example.com", controller.signal),
    ).rejects.toThrow(/^cancelled$/);
  });
  it("serializes overlapping attach/query/detach sequences", async () => {
    const debug = new DebuggerFixture();
    let release!: (value: unknown) => void;
    debug.sendCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = readCookieMetadata(debug, "https://example.com/first");
    await vi.waitFor(() => expect(debug.sendCommand).toHaveBeenCalledOnce());
    const second = readCookieMetadata(debug, "https://example.com/second");
    expect(debug.attach).toHaveBeenCalledOnce();
    release({ cookies: [cookie] });
    await Promise.all([first, second]);
    expect(debug.attach).toHaveBeenCalledTimes(2);
    expect(debug.detach).toHaveBeenCalledTimes(2);
  });
});
