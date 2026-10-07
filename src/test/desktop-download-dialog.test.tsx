import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DownloadDialog } from "@/components/app/DownloadDialog";
import { I18nProvider } from "@/lib/i18n";
import type { DetectedMedia, DownloadJob, Result } from "../../shared/models";
import { desktopFixture } from "./desktop-fixture";

afterEach(() => {
  cleanup();
  delete window.mediaVault;
  localStorage.clear();
  vi.restoreAllMocks();
});
const media: DetectedMedia = {
  id: "candidate-1",
  url: "https://cdn.example/audio?secret=hidden",
  sourcePageUrl: "https://example.org/watch",
  type: "audio",
  origin: "analysis",
  title: "Audio title",
  detectedAt: 1,
};

it("keeps the default directory after native cancellation and queues original audio", async () => {
  const f = desktopFixture();
  const add = vi.spyOn(f.api.downloads, "add");
  const choose = vi.spyOn(f.api.downloads, "chooseDirectory");
  window.mediaVault = f.api;
  render(
    <I18nProvider>
      <DownloadDialog media={media} onClose={() => {}} />
    </I18nProvider>,
  );
  const queue = screen.getByRole("button", { name: "Add to downloads" });
  await waitFor(() => expect(queue).toBeEnabled());
  expect(screen.getByRole("combobox", { name: "Container" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  await waitFor(() => expect(choose).toHaveBeenCalledOnce());
  await waitFor(() => expect(queue).toBeEnabled());
  expect(screen.getByText("C:\\Videos\\MediaVault\\Downloads")).toBeInTheDocument();
  fireEvent.click(queue);
  await waitFor(() =>
    expect(add).toHaveBeenCalledWith({
      mediaId: "candidate-1",
      title: "Audio title",
      quality: "audio",
      container: "original",
      destinationDirectory: "C:\\Videos\\MediaVault\\Downloads",
    }),
  );
  expect(document.body.textContent).not.toContain("secret=hidden");
});

it("keeps failed submissions open with a localized error and prevents a duplicate pending job", async () => {
  const f = desktopFixture();
  let reject!: () => void;
  f.api.downloads.add = vi.fn(
    () =>
      new Promise<Result<DownloadJob>>((resolve) => {
        reject = () => resolve({ ok: false, error: "insufficientSpace" });
      }),
  );
  const close = vi.fn();
  window.mediaVault = f.api;
  render(
    <I18nProvider>
      <DownloadDialog media={{ ...media, type: "video" }} onClose={close} />
    </I18nProvider>,
  );
  const queue = screen.getByRole("button", { name: "Add to downloads" });
  await waitFor(() => expect(queue).toBeEnabled());
  fireEvent.change(screen.getByRole("textbox", { name: "File title" }), {
    target: { value: "CON?." },
  });
  expect(screen.getByText("_CON.mp4")).toBeInTheDocument();
  fireEvent.click(queue);
  fireEvent.click(queue);
  expect(f.api.downloads.add).toHaveBeenCalledOnce();
  reject();
  expect(await screen.findByRole("alert")).toHaveTextContent("There is not enough free space");
  expect(close).not.toHaveBeenCalled();
  expect(queue).toBeEnabled();
});
