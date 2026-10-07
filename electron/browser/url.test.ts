import { describe, expect, it } from "vitest";
import { normalizeBrowserUrl } from "./url";

describe("browser URLs", () => {
  it("normalizes bare domains and preserves signed URLs", () => {
    expect(normalizeBrowserUrl(" example.com/watch ")).toBe("https://example.com/watch");
    expect(normalizeBrowserUrl("http://localhost:8000/a?q=x%2Fy&token=a+b")).toBe(
      "http://localhost:8000/a?q=x%2Fy&token=a+b",
    );
  });
  it.each([
    "",
    "javascript:alert(1)",
    "file:///C:/secret",
    "data:text/html,hi",
    "ftp://example.com",
    "https://user:password@example.com",
    "https://exa mple.com",
    "//example.com",
    "C:\\secret",
    "https://example.com\n/path",
  ])("rejects unsafe URL %s", (url) => {
    expect(() => normalizeBrowserUrl(url)).toThrow("invalidUrl");
  });
});
