import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ComponentType } from "react";
import type { BrowserSettings, DownloadSettings } from "../../shared/models";
import { Route } from "@/routes/settings";
import { I18nProvider } from "@/lib/i18n";
import { desktopFixture } from "./desktop-fixture";

afterEach(() => {
  cleanup();
  delete window.mediaVault;
  localStorage.clear();
});

it("loads and saves browser session settings through the desktop bridge", async () => {
  const fixture = desktopFixture();
  let saved: BrowserSettings | undefined;
  fixture.api.settings.update = async (settings) => {
    saved = { version: 1, ...settings };
    return { ok: true, value: saved };
  };
  window.mediaVault = fixture.api;
  const SettingsPage = Route.options.component as ComponentType;
  render(
    <I18nProvider>
      <SettingsPage />
    </I18nProvider>,
  );
  const homepage = screen.getByRole("textbox", { name: "Default homepage" });
  await waitFor(() => expect(homepage).toHaveValue("https://example.org/"));
  fireEvent.change(homepage, { target: { value: "https://new.example/" } });
  fireEvent.click(screen.getByRole("switch", { name: "Save browser session" }));
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  const browser = within(screen.getByRole("heading", { name: "Browser" }).closest("section")!);
  expect(await browser.findByRole("status")).toHaveTextContent("Browser settings saved");
  expect(saved).toEqual({ version: 1, homepage: "https://new.example/", saveSession: false });
});

it("reports settings failures without claiming successful persistence", async () => {
  const fixture = desktopFixture();
  fixture.api.settings.update = async () => ({ ok: false, error: "settingsFailed" });
  window.mediaVault = fixture.api;
  const SettingsPage = Route.options.component as ComponentType;
  render(
    <I18nProvider>
      <SettingsPage />
    </I18nProvider>,
  );
  const save = screen.getByRole("button", { name: "Save settings" });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  expect(await screen.findByRole("alert")).toHaveTextContent("Settings could not be saved");
  expect(screen.queryByText("Browser settings saved")).not.toBeInTheDocument();
});

it("saves download preferences with an approved native directory and shows all media tools", async () => {
  const fixture = desktopFixture();
  let saved: DownloadSettings | undefined;
  fixture.api.downloads.chooseDirectory = async () => ({ ok: true, value: "D:\\Media" });
  fixture.api.settings.updateDownloads = async (settings) => {
    saved = settings;
    return { ok: true, value: settings };
  };
  window.mediaVault = fixture.api;
  const SettingsPage = Route.options.component as ComponentType;
  render(
    <I18nProvider>
      <SettingsPage />
    </I18nProvider>,
  );
  const save = await screen.findByRole("button", { name: "Save download settings" });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  await screen.findByText("D:\\Media");
  fireEvent.click(screen.getByRole("switch", { name: "Automatically retry failed downloads" }));
  fireEvent.click(save);
  await screen.findByText("Download settings saved");
  expect(saved).toEqual({
    directory: "D:\\Media",
    concurrency: 2,
    quality: "best",
    container: "mp4",
    autoRetry: true,
  });
  const tools = within(screen.getByRole("heading", { name: "Media tools" }).closest("section")!);
  expect(tools.getByText("yt-dlp")).toBeInTheDocument();
  expect(tools.getByText("FFmpeg")).toBeInTheDocument();
  expect(tools.getByText("ffprobe")).toBeInTheDocument();
});
