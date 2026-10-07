import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentType, ReactNode } from "react";
import type { ProductSettings, Result } from "../../shared/models";
import { AppShell } from "@/components/app/AppShell";
import { Route as SettingsRoute } from "@/routes/settings";
import { Route as AboutRoute } from "@/routes/about";
import { I18nProvider } from "@/lib/i18n";
import { desktopFixture, productState } from "./desktop-fixture";
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useRouterState: () => "/",
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string;
    children: ReactNode;
    className?: string;
    title?: string;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
afterEach(() => {
  cleanup();
  delete window.mediaVault;
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.classList.remove("dark");
  vi.restoreAllMocks();
  navigate.mockClear();
});
const show = (children: ReactNode) => render(<I18nProvider>{children}</I18nProvider>);
const fresh = () => {
  const f = desktopFixture();
  f.api.settings.getProduct = async () => ({
    ok: true,
    value: { ...productState, firstLaunchCompleted: false },
  });
  window.mediaVault = f.api;
  return f;
};
const next = () => fireEvent.click(screen.getByRole("button", { name: "Next" }));
async function backgroundStep() {
  await screen.findByRole("dialog", { name: "Welcome to MediaVault" });
  next();
  await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
  next();
  next();
  next();
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
}

it("shows onboarding only for a fresh desktop profile and preserves newer product events", async () => {
  const preview = show(
    <AppShell>
      <div />
    </AppShell>,
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  preview.unmount();
  const f = desktopFixture();
  let finish!: (value: Result<ProductSettings>) => void;
  f.api.settings.getProduct = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  window.mediaVault = f.api;
  const page = show(
    <AppShell>
      <div />
    </AppShell>,
  );
  await waitFor(() => expect(f.productListeners.size).toBe(1));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  act(() => f.emitProduct(productState));
  await act(async () =>
    finish({ ok: true, value: { ...productState, firstLaunchCompleted: false } }),
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  page.unmount();
  expect(f.productListeners.size).toBe(0);
});
it("completes all six steps with native folder choice and optional Drive before marking first launch complete", async () => {
  const f = fresh();
  const order: string[] = [];
  const choose = vi
    .spyOn(f.api.downloads, "chooseDirectory")
    .mockResolvedValue({ ok: true, value: "C:\\Picked" });
  const downloads = vi
    .spyOn(f.api.settings, "updateDownloads")
    .mockImplementation(async (value) => {
      order.push("downloads");
      return { ok: true, value };
    });
  const prefs = vi.spyOn(f.api.settings, "updateProduct").mockImplementation(async (value) => {
    order.push("product");
    return { ok: true, value: { ...productState, ...value, firstLaunchCompleted: false } };
  });
  const language = vi.spyOn(f.api.settings, "setLanguage").mockImplementation(async () => {
    order.push("language");
    return { ok: true, value: undefined };
  });
  const complete = vi.spyOn(f.api.settings, "completeFirstLaunch").mockImplementation(async () => {
    order.push("complete");
    return { ok: true, value: productState };
  });
  show(
    <AppShell>
      <div />
    </AppShell>,
  );
  await screen.findByRole("dialog", { name: "Welcome to MediaVault" });
  next();
  fireEvent.click(await screen.findByRole("button", { name: "Browse" }));
  await waitFor(() => expect(choose).toHaveBeenCalledOnce());
  expect(screen.getByText("C:\\Picked")).toBeInTheDocument();
  next();
  fireEvent.click(screen.getByRole("button", { name: "Up to 1080p" }));
  next();
  fireEvent.click(screen.getByRole("button", { name: "MKV" }));
  next();
  expect(screen.getByRole("button", { name: "Connect Account" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  order.length = 0;
  fireEvent.click(screen.getByRole("button", { name: "Finish" }));
  await waitFor(() => expect(complete).toHaveBeenCalledOnce());
  expect(order).toEqual(["language", "downloads", "product", "complete"]);
  expect(language).toHaveBeenLastCalledWith("en");
  expect(downloads).toHaveBeenCalledWith(
    expect.objectContaining({ directory: "C:\\Picked", quality: "1080", container: "mkv" }),
  );
  expect(prefs).toHaveBeenCalledWith({
    closeBehavior: "tray",
    startWithWindows: false,
    theme: "dark",
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});
it("keeps onboarding open if product preferences fail and does not record completion", async () => {
  const f = fresh();
  vi.spyOn(f.api.settings, "updateProduct").mockResolvedValue({
    ok: false,
    error: "startupFailed",
  });
  const complete = vi.spyOn(f.api.settings, "completeFirstLaunch");
  show(
    <AppShell>
      <div />
    </AppShell>,
  );
  await backgroundStep();
  fireEvent.click(screen.getByRole("button", { name: "Finish" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Windows startup could not be updated",
  );
  expect(complete).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});
it("switches wizard copy to Vietnamese immediately", async () => {
  fresh();
  show(
    <AppShell>
      <div />
    </AppShell>,
  );
  const wizard = await screen.findByRole("dialog", { name: "Welcome to MediaVault" });
  fireEvent.click(within(wizard).getByRole("button", { name: "Tiếng Việt" }));
  expect(screen.getByRole("dialog", { name: "Chào mừng đến với MediaVault" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Tiếp theo" })).toBeInTheDocument();
});
it("saves only product preferences and reflects the actual startup result", async () => {
  const f = desktopFixture();
  window.mediaVault = f.api;
  const save = vi
    .spyOn(f.api.settings, "updateProduct")
    .mockResolvedValue({ ok: true, value: productState });
  const Page = SettingsRoute.options.component as ComponentType;
  show(<Page />);
  const startup = await screen.findByRole("switch", { name: "Start MediaVault with Windows" });
  await waitFor(() => expect(startup).toBeEnabled());
  fireEvent.click(startup);
  act(() => f.emitProduct({ ...productState, trayAvailable: false }));
  expect(startup).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Save general settings" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      closeBehavior: "tray",
      startWithWindows: true,
      theme: "dark",
    }),
  );
  await waitFor(() => expect(startup).not.toBeChecked());
});
it("disables unsupported Windows startup and offers explicit application exit", async () => {
  const f = desktopFixture();
  f.api.settings.getProduct = async () => ({
    ok: true,
    value: { ...productState, startupSupported: false, trayAvailable: false },
  });
  const exit = vi.spyOn(f.api.window, "exit");
  window.mediaVault = f.api;
  const Page = SettingsRoute.options.component as ComponentType;
  show(<Page />);
  expect(
    await screen.findByText("Windows startup is available in the installed Windows app."),
  ).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Start MediaVault with Windows" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Exit MediaVault" }));
  await waitFor(() => expect(exit).toHaveBeenCalledOnce());
});
it("applies persisted light/system appearance and listens for tray navigation", async () => {
  const f = desktopFixture();
  f.api.settings.getProduct = async () => ({
    ok: true,
    value: { ...productState, theme: "light" },
  });
  f.api.product.getVersion = async () => ({ ok: true, value: "2.3.4" });
  window.mediaVault = f.api;
  const page = show(
    <AppShell>
      <div />
    </AppShell>,
  );
  await waitFor(() => expect(document.documentElement.dataset["theme"]).toBe("light"));
  expect(document.documentElement).not.toHaveClass("dark");
  expect(await screen.findByText(/2.3.4/)).toBeInTheDocument();
  act(() => f.emitNavigate("/downloads"));
  expect(navigate).toHaveBeenCalledWith({ to: "/downloads" });
  act(() => f.emitProduct({ ...productState, theme: "dark" }));
  expect(document.documentElement).toHaveClass("dark");
  page.unmount();
  expect(f.navigationListeners.size).toBe(0);
});
it("shows the native package version on About instead of prototype metadata", async () => {
  const f = desktopFixture();
  f.api.product.getVersion = async () => ({ ok: true, value: "2.3.4" });
  window.mediaVault = f.api;
  const Page = AboutRoute.options.component as ComponentType;
  show(<Page />);
  expect(await screen.findByText("2.3.4")).toBeInTheDocument();
  expect(screen.queryByText("MV-PERS-0001")).not.toBeInTheDocument();
});

it("restores the actual startup toggle after OS registration fails", async () => {
  const f = desktopFixture();
  vi.spyOn(f.api.settings, "updateProduct").mockResolvedValue({
    ok: false,
    error: "startupFailed",
  });
  window.mediaVault = f.api;
  const Page = SettingsRoute.options.component as ComponentType;
  show(<Page />);
  const startup = await screen.findByRole("switch", { name: "Start MediaVault with Windows" });
  fireEvent.click(startup);
  fireEvent.click(screen.getByRole("button", { name: "Save general settings" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Windows startup could not be updated",
  );
  await waitFor(() => expect(startup).not.toBeChecked());
  expect(screen.queryByText("General settings saved")).not.toBeInTheDocument();
});
it("follows OS appearance changes only when System is selected and removes its listener", async () => {
  const f = desktopFixture();
  f.api.settings.getProduct = async () => ({
    ok: true,
    value: { ...productState, theme: "system" },
  });
  window.mediaVault = f.api;
  const listeners = new Set<() => void>();
  const query = {
    matches: false,
    addEventListener: vi.fn((_type: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: () => void) => listeners.delete(listener)),
  };
  vi.spyOn(window, "matchMedia").mockReturnValue(query as unknown as MediaQueryList);
  const page = show(
    <AppShell>
      <div />
    </AppShell>,
  );
  await waitFor(() => expect(document.documentElement.dataset["theme"]).toBe("light"));
  act(() => {
    query.matches = true;
    listeners.forEach((listener) => listener());
  });
  expect(document.documentElement.dataset["theme"]).toBe("dark");
  act(() => f.emitProduct({ ...productState, theme: "light" }));
  act(() => listeners.forEach((listener) => listener()));
  expect(document.documentElement.dataset["theme"]).toBe("light");
  page.unmount();
  expect(listeners.size).toBe(0);
});
