export interface ProductPreferences {
  closeBehavior: "tray" | "exit";
  startWithWindows: boolean;
  theme: "dark" | "light" | "system";
}
export interface ProductSettings extends ProductPreferences {
  firstLaunchCompleted: boolean;
  startupSupported: boolean;
  trayAvailable: boolean;
}
export type ProductRoute = "/" | "/downloads" | "/settings";

export interface StorageSnapshot {
  downloads: number;
  temp: number;
  thumbnails: number;
  database: number;
  logs: number;
  fingerprintEnabled: boolean;
}
export type StorageCleanup = "staleTemp" | "oldLogs" | "unusedThumbnails";

export interface YtDlpUpdateState {
  currentVersion: string | null;
  latestVersion: string | null;
  available: boolean;
  supported: boolean;
  busy: boolean;
}
export interface AppUpdateState {
  configured: boolean;
  currentVersion: string;
  latestVersion: string | null;
  status: "unconfigured" | "idle" | "checking" | "current" | "available" | "downloading" | "ready";
}
export interface MaintenanceSnapshot {
  ytDlp: YtDlpUpdateState;
  app: AppUpdateState;
  ffmpegSource: string;
}
export type LogComponent =
  | "download"
  | "upload"
  | "drive"
  | "ipc"
  | "startup"
  | "shutdown"
  | "browser"
  | "update"
  | "diagnostics";
export type LogEvent = "authAnalysisRetry" | "authDownloadUsed" | "cookieCleanupFailed";
export interface DiagnosticLogEntry {
  id: string;
  time: string;
  component: LogComponent;
  code: ErrorCode | null;
  event: LogEvent | null;
}
export interface LogFilter {
  component?: LogComponent;
  kind?: "error" | "event";
}
export interface DiagnosticsSnapshot {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
  schemaVersion: number;
  databasePath: string;
  downloadFolder: string;
  binaries: BinaryStatuses;
  driveConnected: boolean;
  browserSession: "persistent" | "temporary";
  activeDownloads: number;
  activeUploads: number;
  availableDiskSpace: number | null;
  settings: {
    language: "en" | "vi";
    theme: ProductPreferences["theme"];
    closeBehavior: ProductPreferences["closeBehavior"];
    startWithWindows: boolean;
    quality: DownloadSettings["quality"];
    container: DownloadSettings["container"];
    downloadConcurrency: number;
    uploadConcurrency: number;
    autoUpload: boolean;
    deleteLocal: DriveSettings["deleteLocal"];
  };
}

export type ErrorCode =
  | "updateFailed"
  | "updateBusy"
  | "updateNotConfigured"
  | "updateChecksumMismatch"
  | "updateUnsupported"
  | "diagnosticsFailed"
  | "startupFailed"
  | "startupUnsupported"
  | "productSettingsFailed"
  | "browserSessionRequired"
  | "storageFailed"
  | "databaseRecoveryFailed"
  | "publicationUnavailable"
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
  | "unsupportedFormat"
  | "driveNotConfigured"
  | "driveNotConnected"
  | "driveAuthFailed"
  | "driveTokenExpired"
  | "driveSecureStorageUnavailable"
  | "drivePermissionDenied"
  | "driveQuotaExceeded"
  | "driveUploadFailed"
  | "driveUploadSessionExpired"
  | "driveFileMissing"
  | "driveVerificationFailed"
  | "driveAccountChanged"
  | "driveAlreadyUploaded"
  | "driveUnavailable"
  | "networkUnavailable";
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
  requiresBrowserSession?: boolean;
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
  /** Authentication is acquired from the current MediaVault session just in time. */
  requiresBrowserSession?: boolean;
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
  /** Sampled duplicate hint only; never an integrity or upload verification hash. */
  contentFingerprint?: string;
  createdAt: number;
  updatedAt: number;
  /** Absent on legacy local-only records means true. Keep last-known path for recovery. */
  localAvailable?: boolean;
  driveAvailable?: boolean;
  driveFileId?: string;
  driveAccountId?: string;
  driveUploadedAt?: number;
  driveStatus?: DriveUploadStatus | "missing" | "changed";
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
  | "fileDeleted"
  | "driveConnected"
  | "driveDisconnected"
  | "driveUploadQueued"
  | "driveUploadStarted"
  | "driveUploadPaused"
  | "driveUploadResumed"
  | "driveUploadCompleted"
  | "driveUploadFailed"
  | "driveUploadCancelled"
  | "localFileDeletedAfterUpload";
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

/** Public account state only. Credentials belong exclusively to Electron Main. */
export interface DriveAccount {
  connected: boolean;
  configured: boolean;
  connecting: boolean;
  providerAccountId?: string;
  email?: string;
  displayName?: string;
  storageLimit?: number;
  storageUsed?: number;
  rootFolderId?: string;
  rootFolderName?: string;
  error?: ErrorCode;
}
export type DriveUploadStatus =
  | "queued"
  | "preparing"
  | "uploading"
  | "paused"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";
export interface DriveUpload {
  id: string;
  mediaId: string;
  providerAccountId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  driveFolderId?: string;
  driveFileId?: string;
  uploadedBytes: number;
  progress: number;
  speed?: number;
  eta?: number;
  status: DriveUploadStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: ErrorCode;
}
export interface DriveSettings {
  concurrency: number;
  autoUpload: boolean;
  deleteLocal: "never" | "ask" | "automatic";
  chunkSizeMiB: number;
}
export interface DriveSnapshot {
  account: DriveAccount;
  uploads: DriveUpload[];
  settings: DriveSettings;
  syncing: boolean;
  error?: ErrorCode;
}
