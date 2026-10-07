import { expect, it } from "vitest";
import { formatBytes, formatDuration, mediaHost } from "@/lib/media-display";

it("formats unknown, zero and sub-byte progress without inventing values", () => {
  expect(formatBytes(undefined, "en", "Unknown")).toBe("Unknown");
  expect(formatBytes(0, "en", "Unknown")).toContain("0");
  expect(formatBytes(0.5, "en", "Unknown")).toContain("0.5");
  expect(formatDuration(undefined)).toBe("—");
  expect(formatDuration(3661)).toBe("1:01:01");
});
it("only displays the hostname of a media source", () => {
  expect(mediaHost("https://user:password@cdn.example/path?token=secret#fragment")).toBe(
    "cdn.example",
  );
  expect(mediaHost("not a URL")).toBe("");
});
