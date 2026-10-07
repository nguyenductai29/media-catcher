import { describe, expect, it } from "vitest";
import { classifyMedia, MediaCandidates } from "./media-detector";

describe("network media detection", () => {
  it("keeps a single analyzed format when playback makes more range requests", () => {
    const candidates = new MediaCandidates();
    candidates.addNetwork("https://a.test/a.mp4", "https://a.test/page");
    const item = candidates.list()[0]!;
    candidates.merge([{ ...item, id: "analysis-1", origin: "analysis", formatId: "1080" }]);
    candidates.addNetwork("https://a.test/a.mp4", "https://a.test/page", "video/mp4", 900);
    expect(candidates.list()).toHaveLength(1);
    expect(candidates.list()[0]).toMatchObject({
      origin: "analysis",
      formatId: "1080",
      estimatedSize: 900,
    });
  });
  it("recognizes manifests and media MIME types without filename suffixes", () => {
    expect(classifyMedia("https://a.test/master.m3u8?token=1")?.type).toBe("hls");
    expect(classifyMedia("https://a.test/stream", "application/dash+xml")?.type).toBe("dash");
    expect(classifyMedia("https://a.test/stream", "VIDEO/MP4; codecs=avc1")?.type).toBe("video");
    expect(classifyMedia("https://a.test/sound.aac")?.type).toBe("audio");
  });
  it("ignores segments, non-media responses and invalid protocols", () => {
    for (const url of [
      "https://a.test/chunk.ts",
      "https://a.test/init.m4s",
      "file:///a.mp4",
      "https://a.test/a.js",
    ])
      expect(classifyMedia(url)).toBeNull();
    expect(classifyMedia("https://a.test/chunk.ts", "video/mp2t")).toBeNull();
    expect(classifyMedia("https://a.test/part?x=1", "video/mp2t")).toBeNull();
    expect(classifyMedia("https://a.test/a.mp4", "text/html")).toBeNull();
  });
  it("deduplicates range requests while preserving distinct signed URLs and bounded memory", () => {
    const candidates = new MediaCandidates(2);
    candidates.addNetwork("https://a.test/a.mp4?token=1", "https://a.test/page", "video/mp4", 50);
    candidates.addNetwork("https://a.test/a.mp4?token=1", "https://a.test/page", "video/mp4", 100);
    candidates.addNetwork("https://a.test/a.mp4?token=2", "https://a.test/page", "video/mp4");
    expect(candidates.list()).toHaveLength(2);
    expect(candidates.list()[0]?.estimatedSize).toBe(100);
    candidates.addNetwork("https://a.test/b.mp4", "https://a.test/page");
    expect(candidates.list()).toHaveLength(2);
    candidates.clear();
    expect(candidates.list()).toEqual([]);
  });
});
