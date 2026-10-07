import t1 from "@/assets/thumb-1.jpg";
import t2 from "@/assets/thumb-2.jpg";
import t3 from "@/assets/thumb-3.jpg";
import t4 from "@/assets/thumb-4.jpg";

export const thumbs = { t1, t2, t3, t4 };

export type StatusKey =
  | "downloading" | "queued" | "paused" | "completed" | "failed"
  | "scanning" | "detected" | "uploading" | "uploaded" | "localOnly";

export type DetectedMedia = {
  id: string; kind: "video" | "audio"; type: "HLS" | "MP4" | "AAC" | "DASH"; direct: boolean;
  resolution?: string; quality: string; output: string; size: string; audio?: boolean; label: string;
};

export const detectedMedia: DetectedMedia[] = [
  { id: "m1", kind: "video", type: "HLS", direct: false, resolution: "1920×1080", quality: "1080p", output: "MP4", size: "3.8 GB", audio: true, label: "master.m3u8" },
  { id: "m2", kind: "video", type: "MP4", direct: true, resolution: "1280×720", quality: "720p", output: "MP4", size: "1.6 GB", audio: true, label: "movie_720.mp4" },
  { id: "m3", kind: "audio", type: "AAC", direct: true, quality: "128 kbps", output: "M4A", size: "92 MB", label: "audio_en.aac" },
];

export type DownloadItem = {
  id: string; title: string; source: string; resolution: string; type: string; done: number; total: number;
  speed?: string; eta?: string; status: StatusKey; thumb: string;
};

export const downloads: DownloadItem[] = [
  { id: "d1", title: "Movie Example", source: "example.com", resolution: "1080p", type: "MP4", done: 3.2, total: 5.8, speed: "18.4 MB/s", eta: "2m 43s", status: "downloading", thumb: t1 },
  { id: "d2", title: "Ocean Depths — Episode 3", source: "vimeo.com", resolution: "2160p", type: "MKV", done: 1.1, total: 7.4, speed: "6.4 MB/s", eta: "16m 10s", status: "downloading", thumb: t3 },
  { id: "d3", title: "Starship Bridge (Fan Cut)", source: "youtube.com", resolution: "1080p", type: "MP4", done: 0.9, total: 2.3, status: "paused", thumb: t4 },
  { id: "d4", title: "Mountain Sunrise Timelapse", source: "example.org", resolution: "1440p", type: "MP4", done: 0, total: 1.4, status: "queued", thumb: t2 },
  { id: "d5", title: "Concert Live 2024", source: "stream.example.net", resolution: "1080p", type: "MP4", done: 0.4, total: 3.9, status: "failed", thumb: t1 },
  { id: "d6", title: "Movie A", source: "example.com", resolution: "1080p", type: "MP4", done: 4.8, total: 4.8, status: "completed", thumb: t4 },
];

export type LibraryItem = {
  id: string; title: string; duration: string; resolution: string; size: string; source: string; date: string;
  category: "movies" | "videos" | "youtube" | "social" | "other"; local: boolean; drive: boolean; thumb: string;
  codec: string; container: string; path: string; url: string; bitrate: string; fps: string; audio: string;
};

const mk = (o: Partial<LibraryItem> & Pick<LibraryItem, "id" | "title" | "thumb">): LibraryItem => ({
  duration: "1:42:18", resolution: "1920×1080", size: "4.8 GB", source: "example.com", date: "2026-10-06",
  category: "movies", local: true, drive: false, codec: "H.264 / AAC", container: "MP4",
  path: `D:\\MediaVault\\Downloads\\Movies\\${o.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.mp4`,
  url: "https://example.com/watch/movie", bitrate: "6.2 Mbps", fps: "23.976", audio: "Stereo · 48 kHz", ...o,
});

export const library: LibraryItem[] = [
  mk({ id: "l1", title: "Movie A", thumb: t4, drive: true }),
  mk({ id: "l2", title: "Neon Rain", thumb: t1, duration: "2:04:51", size: "5.6 GB" }),
  mk({ id: "l3", title: "Mountain Sunrise Timelapse", thumb: t2, duration: "0:08:12", size: "1.4 GB", resolution: "2560×1440", category: "videos", source: "example.org", drive: true, local: false }),
  mk({ id: "l4", title: "Ocean Depths — Episode 1", thumb: t3, duration: "0:52:30", size: "3.1 GB", resolution: "3840×2160", category: "videos", source: "vimeo.com", codec: "HEVC / AAC", container: "MKV", drive: true }),
  mk({ id: "l5", title: "Starship Bridge Breakdown", thumb: t4, duration: "0:21:07", size: "980 MB", category: "youtube", source: "youtube.com", date: "2026-10-04" }),
  mk({ id: "l6", title: "City at 3AM (Reel)", thumb: t1, duration: "0:00:58", size: "86 MB", resolution: "1080×1920", category: "social", source: "instagram.com", date: "2026-10-02" }),
  mk({ id: "l7", title: "Jellyfish Ambient Loop", thumb: t3, duration: "1:00:00", size: "2.2 GB", category: "other", source: "local", date: "2026-09-28", drive: true }),
  mk({ id: "l8", title: "Above the Clouds", thumb: t2, duration: "1:31:44", size: "4.1 GB", date: "2026-09-21" }),
];

export type DriveItem = { id: string; title: string; size: string; tab: "uploaded" | "uploading" | "local" | "failed"; progress?: number; done?: string; thumb: string };
export const driveItems: DriveItem[] = [
  { id: "g1", title: "Movie A.mp4", size: "4.8 GB", tab: "uploading", progress: 76, done: "3.7 GB", thumb: t4 },
  { id: "g2", title: "Ocean Depths E2.mkv", size: "3.4 GB", tab: "uploading", progress: 22, done: "0.7 GB", thumb: t3 },
  { id: "g3", title: "Mountain Sunrise.mp4", size: "1.4 GB", tab: "uploaded", thumb: t2 },
  { id: "g4", title: "Jellyfish Ambient Loop.mp4", size: "2.2 GB", tab: "uploaded", thumb: t3 },
  { id: "g5", title: "Neon Rain.mp4", size: "5.6 GB", tab: "local", thumb: t1 },
  { id: "g6", title: "Starship Bridge Breakdown.mp4", size: "980 MB", tab: "local", thumb: t4 },
  { id: "g7", title: "City at 3AM.mp4", size: "86 MB", tab: "failed", thumb: t1 },
];

export type ActivityItem = { id: string; time: string; day: "today" | "yesterday"; key: string; kind: "downloads" | "uploads" | "errors" | "browser"; tone: "success" | "info" | "error" | "primary" };
export const activity: ActivityItem[] = [
  { id: "a1", time: "14:32", day: "today", key: "dlDone", kind: "downloads", tone: "success" },
  { id: "a2", time: "14:31", day: "today", key: "upDone", kind: "uploads", tone: "success" },
  { id: "a3", time: "14:20", day: "today", key: "upStart", kind: "uploads", tone: "info" },
  { id: "a4", time: "14:12", day: "today", key: "detected", kind: "browser", tone: "primary" },
  { id: "a5", time: "13:58", day: "today", key: "dlFail", kind: "errors", tone: "error" },
  { id: "a6", time: "21:04", day: "yesterday", key: "dlStart", kind: "downloads", tone: "info" },
  { id: "a7", time: "20:47", day: "yesterday", key: "scan", kind: "browser", tone: "primary" },
];
