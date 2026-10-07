import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";
import type { BrowserState, Result, ViewBounds } from "../../shared/models";
import { useDesktopBrowser } from "@/hooks/use-desktop";
import { Route } from "@/routes/index";
import { I18nProvider } from "@/lib/i18n";
import { browserState, desktopFixture } from "./desktop-fixture";

afterEach(() => {
  cleanup();
  delete window.mediaVault;
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("desktop browser state", () => {
  it("can hide and reopen the detected media panel", () => {
    const BrowserPage = Route.options.component as ComponentType;
    render(
      <I18nProvider>
        <BrowserPage />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide detected media" }));
    expect(screen.queryByRole("heading", { name: "Detected Media" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show detected media" }));
    expect(screen.getByRole("heading", { name: "Detected Media" })).toBeInTheDocument();
  });

  it("keeps a live navigation event when the initial snapshot arrives late", async () => {
    const fixture = desktopFixture();
    let resolveSnapshot!: (state: Result<BrowserState>) => void;
    fixture.api.browser.getState = () =>
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      });
    window.mediaVault = fixture.api;
    const { result, unmount } = renderHook(() => useDesktopBrowser());
    await waitFor(() => expect(fixture.listeners.size).toBe(1));
    act(() => fixture.emit({ ...browserState, url: "https://new.example/", canGoBack: true }));
    await act(async () => resolveSnapshot({ ok: true, value: browserState }));
    expect(result.current.state.url).toBe("https://new.example/");
    expect(result.current.state.canGoBack).toBe(true);
    unmount();
    expect(fixture.listeners.size).toBe(0);
  });

  it("shows a desktop requirement without sample detections in a web browser", () => {
    const BrowserPage = Route.options.component as ComponentType;
    render(
      <I18nProvider>
        <BrowserPage />
      </I18nProvider>,
    );
    expect(screen.getByText("Open MediaVault desktop to browse")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan Media" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
  });

  it("opens the entered URL and submits a detected candidate without exposing its signed URL", async () => {
    const fixture = desktopFixture();
    const add = vi.spyOn(fixture.api.downloads, "add");
    const opened: string[] = [];
    fixture.api.browser.open = async (url) => {
      opened.push(url);
      return { ok: true, value: undefined };
    };
    window.mediaVault = fixture.api;
    const BrowserPage = Route.options.component as ComponentType;
    render(
      <I18nProvider>
        <BrowserPage />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Go" })).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox", { name: "Website address" }), {
      target: { value: "example.net/video" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(opened).toEqual(["example.net/video"]));
    act(() =>
      fixture.emit({
        ...browserState,
        media: [
          {
            id: "format-1",
            url: "https://cdn.example/video.mp4?secret=hidden",
            sourcePageUrl: browserState.url,
            type: "video",
            origin: "analysis",
            title: "Example video",
            resolution: "1920×1080",
            container: "mp4",
            bitrate: 4200,
            detectedAt: 1,
          },
        ],
      }),
    );
    expect(screen.getByText("Example video")).toBeInTheDocument();
    expect(screen.getByText("1920×1080")).toBeInTheDocument();
    expect(screen.getByText("4,200 kbps")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add to downloads" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to downloads" }));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith({
        mediaId: "format-1",
        title: "Example video",
        quality: "best",
        container: "mp4",
        destinationDirectory: "C:\\Videos\\MediaVault\\Downloads",
      }),
    );
    expect(document.body.textContent).not.toContain("secret=hidden");
  });

  it("repositions the native viewport and hides it for dialogs and route cleanup", async () => {
    const fixture = desktopFixture();
    const bounds: (ViewBounds | null)[] = [];
    fixture.api.browser.setBounds = async (next) => {
      bounds.push(next);
      return { ok: true, value: undefined };
    };
    window.mediaVault = fixture.api;
    const BrowserPage = Route.options.component as ComponentType;
    const { container, unmount } = render(
      <I18nProvider>
        <BrowserPage />
      </I18nProvider>,
    );
    const viewport = container.querySelector("[data-browser-viewport]") as HTMLElement;
    let left = 250;
    vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(() => ({
      x: left,
      y: 140,
      left,
      top: 140,
      right: 750,
      bottom: 540,
      width: 750 - left,
      height: 400,
      toJSON: () => ({}),
    }));
    act(() => window.dispatchEvent(new Event("resize")));
    await waitFor(() => expect(bounds.at(-1)).toEqual({ x: 250, y: 140, width: 500, height: 400 }));
    left = 100;
    act(() => window.dispatchEvent(new Event("resize")));
    await waitFor(() => expect(bounds.at(-1)).toEqual({ x: 100, y: 140, width: 650, height: 400 }));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    act(() => document.body.appendChild(dialog));
    await waitFor(() => expect(bounds.at(-1)).toBeNull());
    act(() => dialog.remove());
    await waitFor(() => expect(bounds.at(-1)).toEqual({ x: 100, y: 140, width: 650, height: 400 }));
    unmount();
    expect(bounds.at(-1)).toBeNull();
  });
});
