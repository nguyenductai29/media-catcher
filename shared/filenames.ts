/** Portable display and main-process filename normalization; no filesystem access. */
export function sanitizeFilename(value: string): string {
  let name = value.replace(/[<>:"/\\|?*\p{Cc}]/gu, "").replace(/^[.\s]+|[.\s]+$/g, "");
  name =
    Array.from(name)
      .slice(0, 120)
      .join("")
      .replace(/[.\s]+$/g, "") || "Media";
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}
