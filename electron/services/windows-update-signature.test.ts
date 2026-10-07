// @vitest-environment node
import { describe, expect, it } from "vitest";
import { validateSignatureReport } from "./windows-update-signature";
const path = "C:\\Updates\\MediaVault-Setup-0.1.1.exe";
const report = {
  status: 0,
  path,
  subject: 'CN="Example, Inc.", O="Example, Inc.", C=US',
  commonName: "Example, Inc.",
};
describe("strict pinned Windows installer signature", () => {
  it("accepts Valid Authenticode only for the exact path and common name", () => {
    expect(() =>
      validateSignatureReport(JSON.stringify(report), path, "Example, Inc."),
    ).not.toThrow();
    expect(() =>
      validateSignatureReport(
        JSON.stringify(report),
        path,
        'CN="Example, Inc.", O="Example, Inc.", C=US',
      ),
    ).not.toThrow();
  });
  it.each([
    "",
    "null",
    "{}",
    "[]",
    "not-json",
    JSON.stringify({ ...report, status: 2 }),
    JSON.stringify({ ...report, path: "C:\\Different.exe" }),
    JSON.stringify({ ...report, commonName: "Other publisher" }),
    JSON.stringify({ ...report, subject: null }),
    JSON.stringify({ ...report, commonName: "" }),
  ])("fails closed for missing, invalid, wrong-path or wrong-publisher output %s", (output) => {
    expect(() => validateSignatureReport(output, path, "Example, Inc.")).toThrow("updateFailed");
  });
  it("rejects partial publisher-name matches and a different DN organization", () => {
    expect(() => validateSignatureReport(JSON.stringify(report), path, "Example")).toThrow(
      "updateFailed",
    );
    expect(() =>
      validateSignatureReport(JSON.stringify(report), path, 'CN="Example, Inc.", O=Other'),
    ).toThrow("updateFailed");
  });
});
