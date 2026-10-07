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
  | "settingsFailed";
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
