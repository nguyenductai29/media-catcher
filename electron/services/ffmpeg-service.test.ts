// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseProbeMetadata } from "./ffmpeg-service";

describe("ffprobe metadata boundary", () => {
  it("extracts finite AV metadata and uses actual file size", () => {
    expect(
      parseProbeMetadata(
        {
          format: {
            duration: "3.125",
            bit_rate: "128000",
            format_name: "mov,mp4,m4a,3gp,3g2,mj2",
            size: "999999",
          },
          streams: [
            { codec_type: "video", codec_name: "h264", width: 320, height: 180 },
            { codec_type: "audio", codec_name: "aac" },
          ],
        },
        1234,
        ".mp4",
      ),
    ).toEqual({
      duration: 3.125,
      bitrate: 128000,
      container: "mp4",
      fileSize: 1234,
      hasVideo: true,
      hasAudio: true,
      width: 320,
      height: 180,
      videoCodec: "h264",
      audioCodec: "aac",
    });
  });
  it("ignores cover art and unavailable values for audio media", () => {
    expect(
      parseProbeMetadata(
        {
          format: { duration: "N/A", format_name: "mp3" },
          streams: [
            {
              codec_type: "video",
              codec_name: "mjpeg",
              width: 500,
              height: 500,
              disposition: { attached_pic: 1 },
            },
            { codec_type: "audio", codec_name: "mp3" },
          ],
        },
        123,
        ".mp3",
      ),
    ).toEqual({
      container: "mp3",
      fileSize: 123,
      hasVideo: false,
      hasAudio: true,
      audioCodec: "mp3",
    });
  });
  it("rejects malformed, empty and non-media metadata", () => {
    for (const value of [
      null,
      [],
      {},
      { streams: "bad" },
      { streams: [{ codec_type: "subtitle" }], format: { format_name: "webvtt" } },
      {
        streams: [{ codec_type: "video", width: -1, height: Infinity }],
        format: { format_name: "mp4" },
      },
    ]) {
      expect(() => parseProbeMetadata(value, 123, ".mp4")).toThrow(/^probeFailed$/);
    }
  });
});
