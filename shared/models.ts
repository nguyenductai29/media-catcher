export type ErrorCode =
  | "invalidUrl"
  | "invalidInput"
  | "unavailable"
  | "navigationFailed"
  | "analysisFailed"
  | "analysisTimeout"
  | "binaryMissing"
  | "binaryInvalid"
  | "drmProtected"
  | "cancelled"
  | "settingsFailed"
  | "databaseFailed"
  | "downloadFailed"
  | "probeFailed"
  | "insufficientSpace"
  | "fileMissing"
  | "fileChanged"
  | "fileAccessDenied"
  | "unsupportedFormat";
export type Result<T> = { ok: true; value: T } | { ok: false; error: ErrorCode };
export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface BrowserSettings {
  version: 1;
  homepage: string;
  saveSession: boolean;
}
export interface DetectedMedia {
  id: string;
  url: string;
  sourcePageUrl: string;
  type: "video" | "audio" | "hls" | "dash" | "direct";
  origin: "network" | "analysis";
  title?: string;
  mimeType?: string;
  resolution?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  codec?: string;
  estimatedSize?: number;
  container?: string;
  formatId?: string;
  hasAudio?: boolean;
  detectedAt: number;
}
export interface PageAnalysis {
  title: string;
  webpageUrl: string;
  thumbnail?: string;
  duration?: number;
  uploader?: string;
  website?: string;
  subtitles: string[];
  formats: DetectedMedia[];
  drmProtected: boolean;
}
export interface BrowserState {
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  scanning: boolean;
  media: DetectedMedia[];
  analysis: PageAnalysis | null;
  error: ErrorCode | null;
}
export interface BinaryStatus {
  available: boolean;
  version: string | null;
}
export interface WindowState {
  maximized: boolean;
}

export type DownloadStatus =
  | "queued"
  | "analyzing"
  | "downloading"
  | "processing"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
export type DownloadQuality =
  "best" | "selected" | "2160" | "1440" | "1080" | "720" | "480" | "audio";
export type DownloadContainer = "mp4" | "mkv" | "original";
export interface DownloadSettings {
  directory: string;
  concurrency: number;
  quality: DownloadQuality;
  container: DownloadContainer;
  autoRetry: boolean;
}
/** Renderer selects an already detected candidate. Main owns its URL and metadata. */
export interface AddDownloadInput {
  mediaId: string;
  quality: DownloadQuality;
  container: DownloadContainer;
  destinationDirectory: string;
  title: string;
}
export interface DownloadJob {
  id: string;
  sourceUrl: string;
  pageUrl?: string;
  title: string;
  thumbnail?: string;
  formatId?: string;
  formatLabel?: string;
  resolution?: string;
  container: DownloadContainer;
  quality: DownloadQuality;
  destinationDirectory: string;
  outputPath?: string;
  mediaId?: string;
  downloadedBytes: number;
  totalBytes?: number;
  progress: number;
  speed?: number;
  eta?: number;
  status: DownloadStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: ErrorCode;
  attempts: number;
  /** Whether the extractor URL is a page with selectable format IDs. */
  fromAnalysis: boolean;
}
export interface MediaProbe {
  duration?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  bitrate?: number;
  container: string;
  fileSize: number;
  hasVideo: boolean;
  hasAudio: boolean;
}
export interface MediaItem {
  id: string;
  downloadId?: string;
  title: string;
  sourceUrl?: string;
  sourceType: "download" | "local";
  localPath: string;
  thumbnailPath?: string;
  duration: number;
  width: number;
  height: number;
  resolution: string;
  container: string;
  videoCodec?: string;
  audioCodec?: string;
  bitrate?: number;
  fileSize: number;
  modifiedAt: number;
  createdAt: number;
  updatedAt: number;
}
export type ActivityType =
  | "downloadQueued"
  | "downloadStarted"
  | "downloadPaused"
  | "downloadResumed"
  | "downloadCancelled"
  | "downloadCompleted"
  | "downloadFailed"
  | "mediaAdded"
  | "mediaRemoved"
  | "fileDeleted";
export interface ActivityItem {
  id: string;
  type: ActivityType;
  title: string;
  createdAt: number;
  downloadId?: string;
  mediaId?: string;
  error?: ErrorCode;
}
export interface BinaryDetail extends BinaryStatus {
  state: "ready" | "missing" | "invalid";
}
export interface BinaryStatuses {
  ytDlp: BinaryDetail;
  ffmpeg: BinaryDetail;
  ffprobe: BinaryDetail;
}
export interface ImportSummary {
  added: number;
  skipped: number;
  failed: number;
}
