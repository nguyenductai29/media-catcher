// @vitest-environment node
import { describe, expect, it } from "vitest";
import { classifyProcessFailure } from "./process-failure";
describe("sanitized process failures", () => {
  it.each([
    "HTTP Error 401: secret-url",
    "HTTP Error 403: cookie=private",
    "Please sign in to access this video",
    "Login required",
  ])("identifies authentication without retaining diagnostics: %s", (diagnostic) => {
    const error = classifyProcessFailure(diagnostic, "analysisFailed");
    expect(error.message).toBe("analysisFailed");
    expect(error.authenticationRequired).toBe(true);
    expect(JSON.stringify(error)).not.toMatch(/secret|private|sign in/i);
    expect(error.cause).toBeUndefined();
  });
  it.each([
    "Unsupported URL",
    "No video formats found",
    "HTTP Error 404",
    "HTTP Error 500",
    "filename: login-video",
  ])("never treats unrelated failure as authentication: %s", (diagnostic) => {
    expect(classifyProcessFailure(diagnostic, "analysisFailed").authenticationRequired).toBe(false);
  });
  it.each([
    "getaddrinfo failed",
    "Connection reset by peer",
    "Network is unreachable",
    "ENOTFOUND private-host",
    "The read operation timed out",
    "socket timed out",
  ])("identifies recoverable connectivity failure: %s", (diagnostic) => {
    expect(classifyProcessFailure(diagnostic, "downloadFailed").message).toBe("networkUnavailable");
  });
  it("prioritizes DRM and disk-full failures over authentication words", () => {
    expect(classifyProcessFailure("DRM protected HTTP Error 403", "analysisFailed")).toMatchObject({
      message: "drmProtected",
      authenticationRequired: false,
    });
    expect(classifyProcessFailure("ENOSPC HTTP Error 401", "downloadFailed").message).toBe(
      "insufficientSpace",
    );
  });
});
