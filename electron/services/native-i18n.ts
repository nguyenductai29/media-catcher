import en from "../../src/locales/en.json";
import vi from "../../src/locales/vi.json";
export function nativeText(
  language: "en" | "vi",
  key: string,
  variables?: Record<string, string | number>,
): string {
  const lookup = (root: unknown) =>
    key
      .split(".")
      .reduce<unknown>(
        (value, part) =>
          typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)[part]
            : undefined,
        root,
      );
  const result = lookup(language === "vi" ? vi : en) ?? lookup(en);
  return typeof result === "string"
    ? result.replace(/\{(\w+)\}/g, (match, name: string) =>
        variables?.[name] === undefined ? match : String(variables[name]),
      )
    : key;
}
