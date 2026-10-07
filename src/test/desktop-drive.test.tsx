import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentType } from "react";
import type { DriveSnapshot, DriveUpload, MediaItem, Result } from "../../shared/models";
import { Route as DriveRoute } from "@/routes/drive";
import { Route as LibraryRoute } from "@/routes/library";
import { Route as ActivityRoute } from "@/routes/activity";
import { Route as SettingsRoute } from "@/routes/settings";
import { I18nProvider } from "@/lib/i18n";
import { desktopFixture, driveState } from "./desktop-fixture";

afterEach(() => {
  cleanup();
  delete window.mediaVault;
  localStorage.clear();
  vi.restoreAllMocks();
});
const account = {
  connected: true,
  configured: true,
  connecting: false,
  providerAccountId: "account-1",
  email: "person@example.org",
  rootFolderId: "root-1",
  rootFolderName: "MediaVault",
};
const connected: DriveSnapshot = { ...driveState, account };
const media: MediaItem = {
  id: "media-1",
  title: "Local movie",
  sourceType: "local",
  localPath: "C:\\Videos\\movie.mp4",
  duration: 60,
  width: 1920,
  height: 1080,
  resolution: "1920×1080",
  container: "mp4",
  fileSize: 4096,
  modifiedAt: 1,
  createdAt: 1,
  updatedAt: 1,
};
const upload: DriveUpload = {
  id: "upload-1",
  mediaId: media.id,
  providerAccountId: "account-1",
  fileName: "movie.mp4",
  fileSize: 4096,
  mimeType: "video/mp4",
  uploadedBytes: 2048,
  progress: 50,
  status: "uploading",
  createdAt: 1,
  updatedAt: 1,
};
const show = (Page: ComponentType) =>
  render(
    <I18nProvider>
      <Page />
    </I18nProvider>,
  );

it("keeps an account event over a late initial snapshot and never invents quota", async () => {
  const f = desktopFixture();
  let resolve!: (result: Result<DriveSnapshot>) => void;
  f.api.drive.getState = () =>
    new Promise((r) => {
      resolve = r;
    });
  window.mediaVault = f.api;
  const page = show(DriveRoute.options.component as ComponentType);
  await waitFor(() => expect(f.driveListeners.size).toBe(1));
  act(() => f.emitDrive(connected));
  await act(async () => resolve({ ok: true, value: driveState }));
  expect(screen.getByText("person@example.org")).toBeInTheDocument();
  expect(screen.getAllByText(/Unavailable/).length).toBeGreaterThan(0);
  expect(document.body.textContent).not.toContain("812 GB");
  page.unmount();
  expect(f.driveListeners.size).toBe(0);
});
it("connects through Main and waits for its account state", async () => {
  const f = desktopFixture();
  f.api.drive.getState = async () => ({
    ok: true,
    value: { ...driveState, account: { ...driveState.account, configured: true } },
  });
  const connect = vi
    .spyOn(f.api.drive, "connect")
    .mockResolvedValue({ ok: false, error: "driveAuthFailed" });
  window.mediaVault = f.api;
  show(DriveRoute.options.component as ComponentType);
  const button = screen.getAllByRole("button", { name: "Connect Account" })[0]!;
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(connect).toHaveBeenCalledOnce());
  expect(await screen.findByRole("alert")).toHaveTextContent("Google Drive authorization failed");
  expect(screen.queryByText("person@example.org")).not.toBeInTheDocument();
});
it("uses upload IDs for actions and keeps finalizing separate from uploaded", async () => {
  const f = desktopFixture();
  f.api.drive.getState = async () => ({ ok: true, value: { ...connected, uploads: [upload] } });
  f.api.library.list = async () => ({ ok: true, value: [media] });
  const pause = vi.spyOn(f.api.drive, "pause");
  window.mediaVault = f.api;
  show(DriveRoute.options.component as ComponentType);
  fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
  await waitFor(() => expect(pause).toHaveBeenCalledWith("upload-1"));
  act(() =>
    f.emitDrive({ ...connected, uploads: [{ ...upload, status: "finalizing", progress: 100 }] }),
  );
  expect(screen.getByText("Verifying upload")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open in Drive" })).not.toBeInTheDocument();
  expect(screen.getByText("99%")).toBeInTheDocument();
  expect(screen.queryByText("100%")).not.toBeInTheDocument();
});
it("prevents local operations for Drive-only and missing files without confusing their badges", async () => {
  const f = desktopFixture();
  f.api.drive.getState = async () => ({ ok: true, value: connected });
  f.api.library.list = async () => ({
    ok: true,
    value: [
      {
        ...media,
        localAvailable: false,
        driveAvailable: true,
        driveFileId: "cloud-1",
        driveAccountId: "account-1",
        driveStatus: "completed",
      },
    ],
  });
  const play = vi.spyOn(f.api.library, "play");
  const open = vi.spyOn(f.api.drive, "open");
  window.mediaVault = f.api;
  show(LibraryRoute.options.component as ComponentType);
  fireEvent.click(await screen.findByText("Local movie"));
  const details = screen.getByRole("dialog");
  expect(within(details).getByText("Drive Only")).toBeInTheDocument();
  for (const name of ["Play", "Open Folder", "Copy Path", "Delete Local"])
    expect(within(details).getByRole("button", { name })).toBeDisabled();
  fireEvent.click(within(details).getByRole("button", { name: "Play" }));
  expect(play).not.toHaveBeenCalled();
  fireEvent.click(within(details).getByRole("button", { name: "Open in Drive" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("media-1"));
  act(() => f.emitLibrary([{ ...media, localAvailable: false, driveAvailable: false }]));
  expect(within(details).getByText("Local file missing")).toBeInTheDocument();
  expect(within(details).queryByText("Drive Only")).not.toBeInTheDocument();
});
it("labels files from another account and refuses wrong-account Drive actions", async () => {
  const f = desktopFixture();
  f.api.drive.getState = async () => ({ ok: true, value: connected });
  f.api.library.list = async () => ({
    ok: true,
    value: [
      {
        ...media,
        driveAvailable: true,
        driveFileId: "cloud-1",
        driveAccountId: "account-2",
        driveStatus: "completed",
      },
    ],
  });
  window.mediaVault = f.api;
  show(LibraryRoute.options.component as ComponentType);
  fireEvent.click(await screen.findByText("Local movie"));
  const details = screen.getByRole("dialog");
  expect(within(details).getByText("Another Google account")).toBeInTheDocument();
  expect(within(details).getByRole("button", { name: "Open in Drive" })).toBeDisabled();
  expect(within(details).getByRole("button", { name: "Upload to Drive" })).toBeDisabled();
});
it("preserves unsaved Drive settings across progress snapshots and saves defaults safely", async () => {
  const f = desktopFixture();
  f.api.drive.getState = async () => ({ ok: true, value: connected });
  const save = vi.spyOn(f.api.settings, "updateDrive");
  window.mediaVault = f.api;
  show(SettingsRoute.options.component as ComponentType);
  const toggle = screen.getByRole("switch", {
    name: "Automatically upload to Google Drive after download",
  });
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  act(() => f.emitDrive({ ...connected, uploads: [upload] }));
  expect(toggle).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Save Drive settings" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      concurrency: 2,
      autoUpload: true,
      deleteLocal: "never",
      chunkSizeMiB: 8,
    }),
  );
  expect(await screen.findByText("Drive settings saved")).toBeInTheDocument();
});

it("queues a library upload by media ID from its card and waits for backend status", async () => {
  const f = desktopFixture();
  f.api.drive.getState = async () => ({ ok: true, value: connected });
  f.api.library.list = async () => ({ ok: true, value: [media] });
  let complete!: (value: Result<DriveUpload>) => void;
  const add = vi.spyOn(f.api.drive, "upload").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  window.mediaVault = f.api;
  show(LibraryRoute.options.component as ComponentType);
  const button = await screen.findByRole("button", { name: "Upload to Drive" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(add).toHaveBeenCalledOnce();
  expect(add).toHaveBeenCalledWith("media-1");
  expect(button).toBeDisabled();
  await act(async () => complete({ ok: true, value: { ...upload, status: "queued" } }));
  expect(screen.queryByText("Queued")).not.toBeInTheDocument();
  act(() => f.emitDrive({ ...connected, uploads: [{ ...upload, status: "queued" }] }));
  expect(screen.getByText("Queued")).toBeInTheDocument();
  expect(button).toBeDisabled();
});
it("prompts to connect from a local card without submitting an upload while disconnected", async () => {
  const f = desktopFixture();
  f.api.drive.getState = async () => ({
    ok: true,
    value: { ...driveState, account: { ...driveState.account, configured: true } },
  });
  f.api.library.list = async () => ({ ok: true, value: [media] });
  const add = vi.spyOn(f.api.drive, "upload");
  const connect = vi.spyOn(f.api.drive, "connect");
  window.mediaVault = f.api;
  show(LibraryRoute.options.component as ComponentType);
  fireEvent.click(await screen.findByRole("button", { name: "Upload to Drive" }));
  const details = screen.getByRole("dialog");
  expect(
    within(details).getByText("Connect Google Drive to upload files from your local library."),
  ).toBeInTheDocument();
  expect(add).not.toHaveBeenCalled();
  fireEvent.click(within(details).getByRole("button", { name: "Connect Account" }));
  await waitFor(() => expect(connect).toHaveBeenCalledOnce());
  expect(add).not.toHaveBeenCalled();
});
it("keeps a changed local file distinct from its existing cloud version", async () => {
  const f = desktopFixture();
  f.api.drive.getState = async () => ({ ok: true, value: connected });
  f.api.library.list = async () => ({
    ok: true,
    value: [
      {
        ...media,
        driveAvailable: true,
        driveFileId: "cloud-1",
        driveAccountId: "account-1",
        driveStatus: "changed",
      },
    ],
  });
  window.mediaVault = f.api;
  show(LibraryRoute.options.component as ComponentType);
  expect(await screen.findByText("Local file changed since upload")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Upload to Drive" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Open in Drive" })).toBeEnabled();
});
it("resumes, cancels and retries only the selected upload for its account", async () => {
  const f = desktopFixture();
  f.api.drive.getState = async () => ({
    ok: true,
    value: { ...connected, uploads: [{ ...upload, status: "paused" }] },
  });
  f.api.library.list = async () => ({ ok: true, value: [media] });
  const resume = vi.spyOn(f.api.drive, "resume"),
    cancel = vi.spyOn(f.api.drive, "cancel"),
    retry = vi.spyOn(f.api.drive, "retry");
  window.mediaVault = f.api;
  show(DriveRoute.options.component as ComponentType);
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  await waitFor(() => expect(resume).toHaveBeenCalledWith("upload-1"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith("upload-1"));
  act(() =>
    f.emitDrive({
      ...connected,
      uploads: [{ ...upload, status: "failed", error: "networkUnavailable" }],
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: /^Failed/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry upload" }));
  await waitFor(() => expect(retry).toHaveBeenCalledWith("upload-1"));
  act(() =>
    f.emitDrive({
      ...connected,
      account: { ...account, providerAccountId: "account-2" },
      uploads: [{ ...upload, status: "paused" }],
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: /^Uploading/ }));
  expect(screen.getByText("Another Google account")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
});
it("shows upload activity separately from library events in Vietnamese", async () => {
  const f = desktopFixture();
  f.api.activity.list = async () => ({
    ok: true,
    value: [
      { id: "activity-1", type: "driveUploadCompleted", title: "Movie", createdAt: 1 },
      { id: "activity-2", type: "mediaAdded", title: "Local", createdAt: 1 },
    ],
  });
  window.mediaVault = f.api;
  localStorage.setItem("mv-lang", "vi");
  show(ActivityRoute.options.component as ComponentType);
  expect(await screen.findByText("Tải lên hoàn tất: Movie")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Tải lên" }));
  expect(screen.getByText("Tải lên hoàn tất: Movie")).toBeInTheDocument();
  expect(screen.queryByText(/Local/)).not.toBeInTheDocument();
});

it("offers retry instead of silently requeuing an existing failed upload", async () => {
  const f = desktopFixture();
  f.api.drive.getState = async () => ({
    ok: true,
    value: { ...connected, uploads: [{ ...upload, status: "failed" }] },
  });
  f.api.library.list = async () => ({ ok: true, value: [media] });
  const retry = vi.spyOn(f.api.drive, "retry");
  window.mediaVault = f.api;
  show(LibraryRoute.options.component as ComponentType);
  expect(await screen.findByRole("button", { name: "Upload to Drive" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry upload" }));
  await waitFor(() => expect(retry).toHaveBeenCalledWith("upload-1"));
});
it("does not enable default settings while the persisted Drive snapshot is pending or failed", async () => {
  const f = desktopFixture();
  let complete!: (result: Result<DriveSnapshot>) => void;
  f.api.drive.getState = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  window.mediaVault = f.api;
  show(SettingsRoute.options.component as ComponentType);
  await waitFor(() => expect(f.driveListeners.size).toBe(1));
  expect(screen.getByRole("button", { name: "Save Drive settings" })).toBeDisabled();
  await act(async () => complete({ ok: false, error: "databaseFailed" }));
  expect(screen.getByRole("button", { name: "Save Drive settings" })).toBeDisabled();
});

it("never rounds an unverified upload to 100 percent", async () => {
  const f = desktopFixture();
  f.api.drive.getState = async () => ({
    ok: true,
    value: { ...connected, uploads: [{ ...upload, progress: 99.9 }] },
  });
  window.mediaVault = f.api;
  show(DriveRoute.options.component as ComponentType);
  expect(await screen.findByText("99%")).toBeInTheDocument();
  expect(screen.queryByText("100%")).not.toBeInTheDocument();
  act(() =>
    f.emitDrive({ ...connected, uploads: [{ ...upload, status: "finalizing", progress: 99.9 }] }),
  );
  expect(screen.getByText("99%")).toBeInTheDocument();
  expect(screen.getByText("Verifying upload")).toBeInTheDocument();
});
it.each([DriveRoute.options.component, SettingsRoute.options.component])(
  "can disconnect during pending sync without stale sync results resetting the action",
  async (Page) => {
    const f = desktopFixture();
    f.api.drive.getState = async () => ({ ok: true, value: connected });
    let finishSync!: (result: Result<void>) => void;
    let finishDisconnect!: (result: Result<void>) => void;
    const sync = vi.spyOn(f.api.drive, "sync").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSync = resolve;
        }),
    );
    const disconnect = vi.spyOn(f.api.drive, "disconnect").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDisconnect = resolve;
        }),
    );
    window.mediaVault = f.api;
    show(Page as ComponentType);
    const syncButton = await screen.findByRole("button", { name: "Sync Now" });
    fireEvent.click(syncButton);
    expect(sync).toHaveBeenCalledOnce();
    act(() => f.emitDrive({ ...connected, syncing: true }));
    const disconnectButton = screen.getByRole("button", { name: "Disconnect" });
    expect(disconnectButton).toBeEnabled();
    fireEvent.click(disconnectButton);
    fireEvent.click(disconnectButton);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(disconnectButton).toBeDisabled();
    await act(async () => finishSync({ ok: false, error: "driveUnavailable" }));
    expect(disconnectButton).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => {
      f.emitDrive({ ...driveState, account: { ...driveState.account, configured: true } });
      finishDisconnect({ ok: true, value: undefined });
    });
    expect(screen.getByRole("button", { name: "Connect Account" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  },
);
