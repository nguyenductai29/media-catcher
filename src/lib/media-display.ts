export function mediaHost(url?: string) {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
}
export function formatBytes(value: number | undefined, lang: string, unknown: string) {
  if (value === undefined || !Number.isFinite(value) || value < 0) return unknown;
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];
  const index =
    value > 0 ? Math.max(0, Math.min(4, Math.floor(Math.log(value) / Math.log(1000)))) : 0;
  return new Intl.NumberFormat(lang, {
    style: "unit",
    unit: units[index],
    maximumFractionDigits: 1,
  }).format(value / 1000 ** index);
}
export function formatDuration(value?: number) {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
  const seconds = Math.floor(value);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}:` : ""}${hours ? String(minutes).padStart(2, "0") : minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
export function mediaThumbnail(id: string) {
  return `mediavault://media/${encodeURIComponent(id)}/thumbnail`;
}
