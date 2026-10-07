import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ComponentType } from "react";
import type { BrowserSettings } from "../../shared/models";
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
  expect(await screen.findByRole("status")).toHaveTextContent("Browser settings saved");
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
  expect(await screen.findByRole("alert")).toHaveTextContent("Browser settings could not be saved");
  expect(screen.queryByText("Browser settings saved")).not.toBeInTheDocument();
});
