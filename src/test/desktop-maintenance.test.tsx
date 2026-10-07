import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentType } from "react";
import type {
  AppUpdateState,
  DiagnosticLogEntry,
  Result,
  YtDlpUpdateState,
  MaintenanceSnapshot,
} from "../../shared/models";
import { Route } from "@/routes/settings";
import { I18nProvider } from "@/lib/i18n";
import { desktopFixture, maintenanceState, diagnosticsState } from "./desktop-fixture";

afterEach(() => {
  cleanup();
  delete window.mediaVault;
  localStorage.clear();
  vi.restoreAllMocks();
});
function show() {
  const Page = Route.options.component as ComponentType;
  render(
    <I18nProvider>
      <Page />
    </I18nProvider>,
  );
}
function section(name: string) {
  return within(screen.getByRole("heading", { name }).closest("section")!);
}
it("reads cached versions without network checks and honestly disables an unconfigured app updater", async () => {
  const f = desktopFixture();
  const checkApp = vi.spyOn(f.api.maintenance, "checkApp");
  const checkYtDlp = vi.spyOn(f.api.maintenance, "checkYtDlp");
  window.mediaVault = f.api;
  show();
  const app = section("App updates");
  expect(await app.findByText("0.1.0")).toBeInTheDocument();
  expect(app.getByText("App updates are not configured in this build.")).toBeInTheDocument();
  for (const name of ["Check for updates", "Download update", "Install update and exit"])
    expect(app.getByRole("button", { name })).toBeDisabled();
  expect(checkApp).not.toHaveBeenCalled();
  expect(checkYtDlp).not.toHaveBeenCalled();
  expect(screen.getByText("BtbN FFmpeg Builds (GPL)")).toBeInTheDocument();
});
it("waits for a yt-dlp update, prevents repeated actions and retains the current version on failure", async () => {
  const f = desktopFixture();
  f.api.maintenance.get = async () => ({
    ok: true,
    value: {
      ...maintenanceState,
      ytDlp: { ...maintenanceState.ytDlp, available: true, latestVersion: "2026.10.01" },
    },
  });
  let finish!: (result: Result<YtDlpUpdateState>) => void;
  const update = vi.spyOn(f.api.maintenance, "updateYtDlp").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  window.mediaVault = f.api;
  show();
  const tools = section("Media tools");
  const button = tools.getByRole("button", { name: "Update yt-dlp" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  fireEvent.click(button);
  expect(update).toHaveBeenCalledOnce();
  expect(button).toBeDisabled();
  expect(tools.queryByText("yt-dlp updated successfully.")).not.toBeInTheDocument();
  await act(async () => finish({ ok: false, error: "updateChecksumMismatch" }));
  expect(tools.getByRole("alert")).toHaveTextContent("checksum");
  expect(tools.getByText("2026.01.01")).toBeInTheDocument();
  update.mockResolvedValue({
    ok: true,
    value: { ...maintenanceState.ytDlp, currentVersion: "2026.10.01", latestVersion: "2026.10.01" },
  });
  fireEvent.click(button);
  expect(await tools.findByText("yt-dlp updated successfully.")).toBeInTheDocument();
  expect(tools.getByText("yt-dlp").parentElement).toHaveTextContent("2026.10.01");
  expect(button).toBeDisabled();
});
it("allows app download and install only after confirmed update transitions", async () => {
  const f = desktopFixture();
  const initial: AppUpdateState = {
    configured: true,
    currentVersion: "0.1.0",
    latestVersion: null,
    status: "idle",
  };
  f.api.maintenance.get = async () => ({ ok: true, value: { ...maintenanceState, app: initial } });
  let finish!: (result: Result<AppUpdateState>) => void;
  vi.spyOn(f.api.maintenance, "checkApp").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.spyOn(f.api.maintenance, "downloadApp").mockResolvedValue({
    ok: true,
    value: { ...initial, latestVersion: "0.1.1", status: "ready" },
  });
  const install = vi
    .spyOn(f.api.maintenance, "installApp")
    .mockResolvedValue({ ok: false, error: "updateBusy" });
  window.mediaVault = f.api;
  show();
  const app = section("App updates");
  const check = app.getByRole("button", { name: "Check for updates" });
  const download = app.getByRole("button", { name: "Download update" });
  const installButton = app.getByRole("button", { name: "Install update and exit" });
  await waitFor(() => expect(check).toBeEnabled());
  expect(download).toBeDisabled();
  expect(installButton).toBeDisabled();
  fireEvent.click(check);
  expect(check).toBeDisabled();
  await act(async () =>
    finish({ ok: true, value: { ...initial, latestVersion: "0.1.1", status: "available" } }),
  );
  expect(download).toBeEnabled();
  expect(installButton).toBeDisabled();
  fireEvent.click(download);
  await waitFor(() => expect(installButton).toBeEnabled());
  fireEvent.click(installButton);
  expect(await app.findByRole("alert")).toHaveTextContent("Finish active work");
  expect(install).toHaveBeenCalledOnce();
  expect(installButton).toBeEnabled();
});
it("renders diagnostic fields and filters safe log entries before copying the selected native id", async () => {
  const f = desktopFixture();
  const entry: DiagnosticLogEntry = {
    id: "log-owned",
    time: "2026-10-07T10:00:00.000Z",
    component: "download",
    code: "downloadFailed",
    event: null,
  };
  const logs = vi.spyOn(f.api.diagnostics, "logs").mockImplementation(async (filter) => ({
    ok: true,
    value: filter?.component === "upload" ? [] : [entry],
  }));
  const copy = vi.spyOn(f.api.diagnostics, "copyLog");
  window.mediaVault = f.api;
  show();
  const diagnostic = section("Diagnostics");
  expect(await diagnostic.findByText("C:\\Data\\mediavault.db")).toBeInTheDocument();
  expect(diagnostic.getByText("44.6.0")).toBeInTheDocument();
  const copyButton = diagnostic.getByRole("button", { name: "Copy selected entry" });
  expect(copyButton).toBeDisabled();
  fireEvent.click(await diagnostic.findByRole("radio"));
  fireEvent.click(copyButton);
  await waitFor(() => expect(copy).toHaveBeenCalledWith("log-owned"));
  expect(await diagnostic.findByText("Log entry copied.")).toBeInTheDocument();
  fireEvent.change(diagnostic.getByRole("combobox", { name: "Component" }), {
    target: { value: "upload" },
  });
  await waitFor(() => expect(logs).toHaveBeenLastCalledWith({ component: "upload" }));
  expect(await diagnostic.findByText("No matching log entries.")).toBeInTheDocument();
  expect(copyButton).toBeDisabled();
  fireEvent.change(diagnostic.getByRole("combobox", { name: "Entry type" }), {
    target: { value: "error" },
  });
  await waitFor(() =>
    expect(logs).toHaveBeenLastCalledWith({ component: "upload", kind: "error" }),
  );
});
it("does not report success when the diagnostics export chooser is cancelled", async () => {
  const f = desktopFixture();
  window.mediaVault = f.api;
  show();
  const diagnostic = section("Diagnostics");
  const button = diagnostic.getByRole("button", { name: "Export diagnostics" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(button).toBeEnabled());
  expect(diagnostic.queryByText("Diagnostics exported.")).not.toBeInTheDocument();
  f.api.diagnostics.exportDiagnostics = async () => ({ ok: true, value: true });
  fireEvent.click(button);
  expect(await diagnostic.findByText("Diagnostics exported.")).toBeInTheDocument();
});
it("bounds displayed entries and clears the list only after native confirmation", async () => {
  const f = desktopFixture();
  const entries: DiagnosticLogEntry[] = Array.from({ length: 230 }, (_, n) => ({
    id: `log-${n}`,
    time: "2026-10-07T10:00:00.000Z",
    component: "browser",
    code: null,
    event: "authAnalysisRetry",
  }));
  f.api.diagnostics.logs = async () => ({ ok: true, value: entries });
  vi.spyOn(f.api.diagnostics, "clearLogs")
    .mockResolvedValueOnce({ ok: false, error: "diagnosticsFailed" })
    .mockResolvedValue({ ok: true, value: undefined });
  window.mediaVault = f.api;
  show();
  const diagnostic = section("Diagnostics");
  await waitFor(() => expect(diagnostic.getAllByRole("radio", { hidden: true })).toHaveLength(200));
  const clear = diagnostic.getByRole("button", { name: "Clear logs" });
  fireEvent.click(clear);
  expect(await diagnostic.findByRole("alert")).toHaveTextContent("Diagnostics could not");
  expect(diagnostic.getAllByRole("radio", { hidden: true })).toHaveLength(200);
  f.api.diagnostics.logs = async () => ({ ok: true, value: [] });
  fireEvent.click(clear);
  expect(await diagnostic.findByText("Logs cleared.")).toBeInTheDocument();
  expect(diagnostic.queryAllByRole("radio")).toHaveLength(0);
});
it("localizes maintenance and diagnostics controls in Vietnamese and keeps web preview inert", async () => {
  localStorage.setItem("mv-lang", "vi");
  show();
  const diagnostic = section("Chẩn đoán");
  expect(diagnostic.getByRole("button", { name: "Xuất thông tin chẩn đoán" })).toBeDisabled();
  expect(
    section("Cập nhật ứng dụng").getByRole("button", { name: "Kiểm tra cập nhật" }),
  ).toBeDisabled();
  expect(
    section("Cập nhật ứng dụng").getByRole("button", { name: "Cài đặt cập nhật và thoát" }),
  ).toBeDisabled();
  expect(
    section("Công cụ phương tiện").getByRole("button", { name: "Cập nhật yt-dlp" }),
  ).toBeDisabled();
});

it("does not let a late cached refresh undo a confirmed yt-dlp update", async () => {
  const f = desktopFixture();
  const available = {
    ...maintenanceState,
    ytDlp: { ...maintenanceState.ytDlp, available: true, latestVersion: "2026.10.01" },
  };
  let finishRefresh!: (result: Result<MaintenanceSnapshot>) => void;
  let finishUpdate!: (result: Result<YtDlpUpdateState>) => void;
  vi.spyOn(f.api.maintenance, "get")
    .mockResolvedValueOnce({ ok: true, value: available })
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
    );
  vi.spyOn(f.api.maintenance, "updateYtDlp").mockImplementation(
    () =>
      new Promise((resolve) => {
        finishUpdate = resolve;
      }),
  );
  window.mediaVault = f.api;
  show();
  const tools = section("Media tools");
  const update = tools.getByRole("button", { name: "Update yt-dlp" });
  await waitFor(() => expect(update).toBeEnabled());
  fireEvent.click(update);
  fireEvent.click(section("App updates").getByRole("button", { name: "Refresh update status" }));
  await act(async () =>
    finishUpdate({
      ok: true,
      value: { ...available.ytDlp, currentVersion: "2026.10.01", available: false },
    }),
  );
  await act(async () => finishRefresh({ ok: true, value: available }));
  expect(tools.getByText("Current yt-dlp version").parentElement).toHaveTextContent("2026.10.01");
  expect(update).toBeDisabled();
});

it("ignores late log results from a previous filter", async () => {
  const f = desktopFixture();
  let finish!: (result: Result<DiagnosticLogEntry[]>) => void;
  vi.spyOn(f.api.diagnostics, "logs")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ ok: true, value: [] });
  window.mediaVault = f.api;
  show();
  const diagnostic = section("Diagnostics");
  fireEvent.change(diagnostic.getByRole("combobox", { name: "Component" }), {
    target: { value: "upload" },
  });
  await diagnostic.findByText("No matching log entries.");
  await act(async () =>
    finish({
      ok: true,
      value: [
        {
          id: "0".repeat(32),
          time: "2026-10-07T10:00:00.000Z",
          component: "download",
          code: "downloadFailed",
          event: null,
        },
      ],
    }),
  );
  expect(diagnostic.queryByRole("radio")).not.toBeInTheDocument();
  expect(diagnostic.getByRole("button", { name: "Copy selected entry" })).toBeDisabled();
});

it("enables yt-dlp updating only after an explicit check finds a newer release", async () => {
  const f = desktopFixture();
  vi.spyOn(f.api.maintenance, "checkYtDlp").mockResolvedValue({
    ok: true,
    value: { ...maintenanceState.ytDlp, latestVersion: "2026.10.01", available: true },
  });
  window.mediaVault = f.api;
  show();
  const tools = section("Media tools");
  const update = tools.getByRole("button", { name: "Update yt-dlp" });
  const check = tools.getByRole("button", { name: "Check yt-dlp update" });
  await waitFor(() => expect(check).toBeEnabled());
  expect(update).toBeDisabled();
  fireEvent.click(check);
  await waitFor(() => expect(update).toBeEnabled());
  expect(tools.getByText("Latest yt-dlp version").parentElement).toHaveTextContent("2026.10.01");
});

it("allows an explicit check to refresh cached busy status while keeping installation guarded", async () => {
  const f = desktopFixture();
  f.api.maintenance.get = async () => ({
    ok: true,
    value: {
      ...maintenanceState,
      ytDlp: {
        ...maintenanceState.ytDlp,
        busy: true,
        available: true,
        latestVersion: "2026.10.01",
      },
    },
  });
  let finish!: (result: Result<YtDlpUpdateState>) => void;
  const checkCall = vi.spyOn(f.api.maintenance, "checkYtDlp").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const updateCall = vi.spyOn(f.api.maintenance, "updateYtDlp");
  window.mediaVault = f.api;
  show();
  const tools = section("Media tools");
  const check = tools.getByRole("button", { name: "Check yt-dlp update" });
  const update = tools.getByRole("button", { name: "Update yt-dlp" });
  await waitFor(() => expect(check).toBeEnabled());
  expect(update).toBeDisabled();
  expect(
    tools.getByText("yt-dlp was busy at the last check. Check again to refresh its status."),
  ).toBeInTheDocument();
  expect(tools.queryByText("Checking…")).not.toBeInTheDocument();
  fireEvent.click(update);
  expect(updateCall).not.toHaveBeenCalled();
  fireEvent.click(check);
  fireEvent.click(check);
  expect(checkCall).toHaveBeenCalledOnce();
  expect(check).toBeDisabled();
  expect(update).toBeDisabled();
  await act(async () =>
    finish({
      ok: true,
      value: {
        ...maintenanceState.ytDlp,
        busy: false,
        available: true,
        latestVersion: "2026.10.01",
      },
    }),
  );
  expect(check).toBeEnabled();
  expect(update).toBeEnabled();
  expect(
    tools.queryByText("yt-dlp was busy at the last check. Check again to refresh its status."),
  ).not.toBeInTheDocument();
});

it("keeps app download disabled when checking fails and shows a localized Vietnamese error", async () => {
  const f = desktopFixture();
  f.api.maintenance.get = async () => ({
    ok: true,
    value: {
      ...maintenanceState,
      app: { ...maintenanceState.app, configured: true, status: "idle" },
    },
  });
  f.api.maintenance.checkApp = async () => ({ ok: false, error: "updateFailed" });
  localStorage.setItem("mv-lang", "vi");
  window.mediaVault = f.api;
  show();
  const app = section("Cập nhật ứng dụng");
  const check = app.getByRole("button", { name: "Kiểm tra cập nhật" });
  await waitFor(() => expect(check).toBeEnabled());
  fireEvent.click(check);
  expect(await app.findByRole("alert")).toHaveTextContent("Không thể hoàn tất cập nhật");
  expect(app.getByRole("button", { name: "Tải bản cập nhật" })).toBeDisabled();
});

it("refreshes diagnostics without inventing disk space and delegates folder opening to Main", async () => {
  const f = desktopFixture();
  f.api.diagnostics.get = async () => ({ ok: false, error: "diagnosticsFailed" });
  const open = vi.spyOn(f.api.diagnostics, "openLogs");
  window.mediaVault = f.api;
  show();
  const diagnostic = section("Diagnostics");
  await diagnostic.findByRole("alert");
  f.api.diagnostics.get = async () => ({
    ok: true,
    value: { ...diagnosticsState, activeDownloads: 7, availableDiskSpace: null },
  });
  fireEvent.click(diagnostic.getByRole("button", { name: "Refresh diagnostics" }));
  await diagnostic.findByText("C:\\Data\\mediavault.db");
  expect(diagnostic.getByText("Active downloads").parentElement).toHaveTextContent("7");
  expect(diagnostic.getByText("Available disk space").parentElement).toHaveTextContent("Unknown");
  expect(diagnostic.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(diagnostic.getByRole("button", { name: "Open log folder" }));
  await waitFor(() => expect(open).toHaveBeenCalledOnce());
});
