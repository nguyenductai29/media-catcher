export function normalizeBrowserUrl(input: string): string {
  if (
    typeof input !== "string" ||
    input.length > 8192 ||
    [...input].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === "\\",
    )
  )
    throw new Error("invalidUrl");
  const text = input.trim();
  if (!text || text.startsWith("//")) throw new Error("invalidUrl");
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(text);
  const bareHostPort = /^(localhost|[a-z\d.-]+\.[a-z\d.-]+):\d+(\/|$)/i.test(text);
  let url: URL;
  try {
    url = new URL(hasScheme && !bareHostPort ? text : `https://${text}`);
  } catch {
    throw new Error("invalidUrl");
  }
  if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw new Error("invalidUrl");
  return url.href;
}
