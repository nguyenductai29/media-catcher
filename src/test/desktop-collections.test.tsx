import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";
import type { DownloadJob, MediaItem, Result } from "../../shared/models";
import { Route as DownloadsRoute } from "@/routes/downloads";
import { Route as LibraryRoute } from "@/routes/library";
import { Route as ActivityRoute } from "@/routes/activity";
import { Route as DriveRoute } from "@/routes/drive";
import { I18nProvider, useT } from "@/lib/i18n";
import { desktopFixture } from "./desktop-fixture";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
afterEach(() => {
  cleanup();
  delete window.mediaVault;
  localStorage.clear();
  vi.restoreAllMocks();
});
const job: DownloadJob = {
  id: "job-1",
  title: "Live download",
  sourceUrl: "https://cdn.example/video?token=secret",
  destinationDirectory: "C:\\Videos",
  quality: "best",
  container: "mp4",
  downloadedBytes: 1024,
  totalBytes: 4096,
  progress: 25,
  speed: 100,
  eta: 30,
  status: "downloading",
  createdAt: 1,
  updatedAt: 1,
  attempts: 1,
  fromAnalysis: true,
};
const media: MediaItem = {
  id: "media-1",
  title: "Local sample",
  sourceType: "local",
  localPath: "C:\\Videos\\sample.mp4",
  duration: 65,
  width: 1920,
  height: 1080,
  resolution: "1920×1080",
  container: "mp4",
  fileSize: 4096,
  modifiedAt: 1,
  createdAt: 1,
  updatedAt: 1,
};
const show = (Page: ComponentType) =>
  render(
    <I18nProvider>
      <Page />
    </I18nProvider>,
  );

describe("desktop collection views", () => {
  it("keeps the unavailable Drive integration disconnected without sample storage", () => {
    window.mediaVault = desktopFixture().api;
    show(DriveRoute.options.component as ComponentType);
    expect(document.body.textContent).not.toContain("user@example.com");
    expect(document.body.textContent).not.toContain("812 GB");
    for (const button of screen.getAllByRole("button", { name: "Connect Account" }))
      expect(button).toBeDisabled();
  });
  it("keeps live jobs over a late snapshot and waits for backend pause events", async () => {
    const f = desktopFixture();
    let resolve!: (result: Result<DownloadJob[]>) => void;
    f.api.downloads.list = () =>
      new Promise((r) => {
        resolve = r;
      });
    f.api.downloads.pause = vi.fn(async () => ({ ok: true as const, value: undefined }));
    window.mediaVault = f.api;
    const page = show(DownloadsRoute.options.component as ComponentType);
    expect(screen.queryByText("Neon Streets")).not.toBeInTheDocument();
    await waitFor(() => expect(f.downloadListeners.size).toBe(1));
    act(() => f.emitDownloads([job]));
    await act(async () => resolve({ ok: true, value: [] }));
    expect(screen.getByText("Live download")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("token=secret");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(f.api.downloads.pause).toHaveBeenCalledWith("job-1"));
    expect(screen.getByText("Downloading", { exact: true })).toBeInTheDocument();
    act(() => f.emitDownloads([{ ...job, status: "paused" }]));
    expect(screen.getByText("Paused", { exact: true })).toBeInTheDocument();
    page.unmount();
    expect(f.downloadListeners.size).toBe(0);
  });
  it("keeps a library item when native deletion is cancelled and uses id based playback", async () => {
    const f = desktopFixture();
    f.api.library.list = async () => ({ ok: true, value: [media] });
    f.api.library.deleteFile = vi.fn(async () => ({ ok: true as const, value: false }));
    f.api.library.play = vi.fn(async () => ({
      ok: true as const,
      value: "mediavault://media/media-1/video",
    }));
    f.api.library.openExternal = vi.fn(async () => ({
      ok: false as const,
      error: "fileMissing" as const,
    }));
    window.mediaVault = f.api;
    show(LibraryRoute.options.component as ComponentType);
    fireEvent.click(await screen.findByText("Local sample"));
    const details = await screen.findByRole("dialog");
    fireEvent.click(within(details).getByRole("button", { name: "Delete Local" }));
    await waitFor(() => expect(f.api.library.deleteFile).toHaveBeenCalledWith("media-1"));
    expect(within(details).getByText("Local sample")).toBeInTheDocument();
    fireEvent.click(within(details).getByRole("button", { name: "Play" }));
    await waitFor(() => expect(f.api.library.play).toHaveBeenCalledWith("media-1"));
    await waitFor(() =>
      expect(document.querySelector("video")?.getAttribute("src")).toBe(
        "mediavault://media/media-1/video",
      ),
    );
    fireEvent.error(document.querySelector("video")!);
    expect(screen.getByText("This format cannot be previewed in MediaVault.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open with default app" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog")).getByText(
          "The file could not be found. Refresh the library.",
        ),
      ).toBeInTheDocument(),
    );
  });
  it("renders persisted typed activity with real titles and dates", async () => {
    const f = desktopFixture();
    f.api.activity.list = async () => ({
      ok: true,
      value: [
        { id: "event-1", type: "downloadCompleted", title: "Real title", createdAt: Date.now() },
      ],
    });
    window.mediaVault = f.api;
    show(ActivityRoute.options.component as ComponentType);
    expect(await screen.findByText(/Real title/)).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.queryByText(/Movie A/)).not.toBeInTheDocument();
  });
  it("restores the saved language before synchronizing native dialogs", async () => {
    const f = desktopFixture();
    f.api.settings.setLanguage = vi.fn(async () => ({ ok: true as const, value: undefined }));
    window.mediaVault = f.api;
    localStorage.setItem("mv-lang", "vi");
    function Language() {
      const { lang, setLang } = useT();
      return <button onClick={() => setLang("en")}>{lang}</button>;
    }
    show(Language);
    await waitFor(() => expect(f.api.settings.setLanguage).toHaveBeenCalledWith("vi"));
    expect(f.api.settings.setLanguage).not.toHaveBeenCalledWith("en");
    fireEvent.click(screen.getByRole("button", { name: "vi" }));
    await waitFor(() => expect(f.api.settings.setLanguage).toHaveBeenLastCalledWith("en"));
  });
});
