import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentType } from "react";
import type { Result, StorageSnapshot } from "../../shared/models";
import { Route } from "@/routes/settings";
import { I18nProvider } from "@/lib/i18n";
import { desktopFixture, storageState } from "./desktop-fixture";
afterEach(() => {
  cleanup();
  delete window.mediaVault;
  localStorage.clear();
  vi.restoreAllMocks();
});
const snapshot: StorageSnapshot = {
  downloads: 1000,
  temp: 2000,
  thumbnails: 3000,
  database: 4000,
  logs: 5000,
  fingerprintEnabled: false,
};
function show() {
  const Page = Route.options.component as ComponentType;
  render(
    <I18nProvider>
      <Page />
    </I18nProvider>,
  );
  return within(screen.getByRole("heading", { name: "Storage" }).closest("section")!);
}
it("shows all five native storage totals without changing the default fingerprint preference", async () => {
  const f = desktopFixture();
  f.api.storage.get = async () => ({ ok: true, value: snapshot });
  window.mediaVault = f.api;
  const section = show();
  for (const [name, size] of [
    ["Downloads", "1 kB"],
    ["Temporary files", "2 kB"],
    ["Thumbnails", "3 kB"],
    ["Database", "4 kB"],
    ["Logs", "5 kB"],
  ]) {
    const label = section.getByText(name!);
    await waitFor(() => expect(label.parentElement).toHaveTextContent(size!));
  }
  expect(
    section.getByRole("switch", { name: "Detect duplicate imports using file samples" }),
  ).not.toBeChecked();
});
it.each([
  ["staleTemp", "Clean stale temp"],
  ["oldLogs", "Clean old logs"],
  ["unusedThumbnails", "Clean unused thumbnails"],
] as const)(
  "uses only the native %s cleanup action and waits for its returned totals",
  async (action, label) => {
    const f = desktopFixture();
    f.api.storage.get = async () => ({ ok: true, value: snapshot });
    let finish!: (result: Result<StorageSnapshot>) => void;
    const clean = vi.spyOn(f.api.storage, "clean").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    window.mediaVault = f.api;
    const section = show();
    const button = section.getByRole("button", { name: label });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    fireEvent.click(button);
    expect(clean).toHaveBeenCalledOnce();
    expect(clean).toHaveBeenCalledWith(action);
    expect(section.getByText("2 kB")).toBeInTheDocument();
    expect(button).toBeDisabled();
    expect(section.queryByText(/cleanup completed/)).not.toBeInTheDocument();
    await act(async () =>
      finish({ ok: true, value: { ...snapshot, temp: 0, logs: 0, thumbnails: 0 } }),
    );
    expect(section.getAllByText("0 byte")).toHaveLength(3);
    expect(section.getByRole("status")).toHaveTextContent("cleanup completed");
  },
);
it("keeps sizes and fingerprint disabled when native writes fail", async () => {
  const f = desktopFixture();
  f.api.storage.get = async () => ({ ok: true, value: snapshot });
  vi.spyOn(f.api.storage, "clean").mockResolvedValue({ ok: false, error: "storageFailed" });
  const fingerprint = vi
    .spyOn(f.api.storage, "setFingerprintEnabled")
    .mockResolvedValue({ ok: false, error: "storageFailed" });
  window.mediaVault = f.api;
  const section = show();
  const toggle = section.getByRole("switch", {
    name: "Detect duplicate imports using file samples",
  });
  await waitFor(() => expect(toggle).toBeEnabled());
  fireEvent.click(toggle);
  await waitFor(() => expect(fingerprint).toHaveBeenCalledWith(true));
  expect(toggle).not.toBeChecked();
  await waitFor(() =>
    expect(section.getByRole("button", { name: "Clean stale temp" })).toBeEnabled(),
  );
  fireEvent.click(section.getByRole("button", { name: "Clean stale temp" }));
  expect(await section.findByRole("alert")).toHaveTextContent(
    "Storage could not be read or updated",
  );
  expect(section.getByText("2 kB")).toBeInTheDocument();
  expect(section.queryByRole("status")).not.toBeInTheDocument();
});
it("saves fingerprint detection only after Main confirms and can refresh a failed initial read", async () => {
  const f = desktopFixture();
  const read = vi
    .spyOn(f.api.storage, "get")
    .mockResolvedValueOnce({ ok: false, error: "storageFailed" })
    .mockResolvedValue({ ok: true, value: snapshot });
  const fingerprint = vi
    .spyOn(f.api.storage, "setFingerprintEnabled")
    .mockResolvedValue({ ok: true, value: { ...snapshot, fingerprintEnabled: true } });
  window.mediaVault = f.api;
  const section = show();
  await section.findByRole("alert");
  expect(section.getByRole("button", { name: "Clean stale temp" })).toBeDisabled();
  fireEvent.click(section.getByRole("button", { name: "Refresh storage" }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  const toggle = section.getByRole("switch", {
    name: "Detect duplicate imports using file samples",
  });
  await waitFor(() => expect(toggle).toBeEnabled());
  fireEvent.click(toggle);
  await waitFor(() => expect(fingerprint).toHaveBeenCalledWith(true));
  await waitFor(() => expect(toggle).toBeChecked());
  expect(section.getByRole("status")).toHaveTextContent("Duplicate detection setting saved");
});
it("does not offer pretend storage cleanup in web preview", () => {
  const section = show();
  for (const name of [
    "Clean stale temp",
    "Clean old logs",
    "Clean unused thumbnails",
    "Refresh storage",
  ])
    expect(section.getByRole("button", { name })).toBeDisabled();
  expect(
    section.getByRole("switch", { name: "Detect duplicate imports using file samples" }),
  ).toBeDisabled();
  expect(section.queryByText("0 byte")).not.toBeInTheDocument();
});
