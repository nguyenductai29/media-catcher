# MediaVault desktop milestone one

## Scope and design

Implement the first milestone from the supplied MediaVault specification only:
secure Electron shell, existing frontend, WebContentsView browser, persistent
isolated session, network detection, and yt-dlp metadata/format analysis.
Downloads, SQLite, Drive, tray and installer generation remain later milestones.

Repository inspection: React 19 + TypeScript, TanStack Start/file routes + Query,
Tailwind 4, shadcn/ui, lucide icons. AppShell is mounted once in __root. Browser
simulation and results are in routes/index.tsx and lib/mock.ts. Other pages use
the same mock module. I18n uses I18nProvider/useT and locales/en.json and vi.json.
Keep these components, route tree, theme, and state approach.

Use a separate static Vite renderer entry for Electron so desktop needs no web
server or cloud backend; retain the existing Lovable web build. Use a registered
app protocol in production and a loopback Vite dev origin in development.
Main owns a frameless window, browser session/view and child process services.
Preload exposes a narrow typed API; main authenticates the sender and validates
every argument. Remote pages have no preload or Node and cannot invoke app IPC.
React measures a dedicated viewport with ResizeObserver and hides the view when
leaving the route or opening an overlay. External HTTP(S) popups navigate in the
same view; other schemes and unsolicited downloads are blocked.

Settings for homepage and session persistence use an atomic app-data JSON file
until the later SQLite milestone. Persistent and ephemeral browser sessions are
separate from the renderer session. Session clearing is explicit. Detection
filters segments, deduplicates exact media URLs, and bounds retained results.
yt-dlp runs with spawn argument arrays, no shell/config/plugin execution,
bounded JSON output, timeout and cancellation. It analyzes only, never downloads.
Development binary path is configurable; an explicit setup command retrieves the
official standalone executable with release checksum verification.

## Implementation plan

- [x] Shell: shared contracts, preload, validated IPC, Electron lifecycle,
      window controls, static renderer build and development launcher.
- [x] Browser: HTTP(S) normalization tests, persistent session/settings,
      navigation state, native bounds, network classification and deduplication tests.
- [x] Analysis: binary discovery/setup, metadata parsing and failure tests,
      cancellable yt-dlp analysis; merge formats without auto-downloading.
- [x] UI: existing Browser layout wired to bridge, session settings, localized
      errors/controls, real title bar, graceful web-only message, disabled downloads.
- [x] Verification: TypeScript, lint, unit tests, web and desktop builds;
      Electron smoke tests for navigation, detection, formats, session persistence,
      bounds, language, IPC isolation and window controls. Independent review.

## Review focus

- Reject unsafe schemes, credentials and untrusted IPC senders.
- Discard stale requests and analysis after navigation; retain distinct signed URLs.
- Hide/resize the native view correctly for route changes and overlays.
- No cookies, tokens, raw process output or stack traces in UI/logs.
- Production loads local assets and retains the existing app routes and locale switch.

## Execution notes

The supplied request already specifies the design and explicitly authorizes
implementation. Work proceeds in the clean shared repository without additional
approval gates, commits, publishing or history rewriting.

## Changed files

- Desktop boundary: `electron/main.ts`, `electron/preload.ts`,
  `electron/ipc/register-ipc.ts`, `shared/models.ts`, `shared/ipc-types.ts`,
  `src/types/desktop.d.ts`.
- Browser: `electron/browser/browser-manager.ts`, `browser-session.ts`,
  `media-detector.ts`, `url.ts`, and `electron/services/settings-service.ts`.
- Analyzer: `electron/downloads/ytdlp-service.ts`,
  `electron/services/binary-service.ts`, `scripts/setup-ytdlp.mjs`,
  `resources/bin/README.md`.
- Renderer: `src/routes/index.tsx`, `settings.tsx`, `__root.tsx`,
  `src/components/app/AppShell.tsx`, `AddUrlDialog.tsx`, `primitives.tsx`,
  `src/components/ui/dialog.tsx`, `src/hooks/use-desktop.ts`, `src/lib/i18n.tsx`,
  `src/locales/en.json`, `vi.json`, and `src/styles.css`.
- Build and launch: `desktop/index.html`, `main.tsx`, `fonts.css`,
  `vite.desktop.config.ts`, `tsconfig.electron.json`, `tsconfig.json`,
  `scripts/build-electron.mjs`, `scripts/electron-dev.mjs`, `package.json`,
  `package-lock.json`, `.gitignore`, `.prettierignore`, and `README.md`.
- Verification: `scripts/smoke-electron.mjs`, `electron/**/*.test.ts`,
  `electron/services/setup-ytdlp.test.mjs`, `src/test/desktop-*.tsx`,
  `src/test/desktop-fixture.ts`, `src/test/setup.ts`, `vitest.config.ts`, and
  `eslint.config.js`.
- Existing prototype routes/mock data and shared UI files also received
  formatting/line-ending fixes for the repository's existing Prettier lint rules.
  Their mock behavior and layouts are retained. Generated route-tree changes
  come from the existing TanStack build.

## Decisions from review

- Keep browser pages on a white default canvas so sites without a background
  declaration remain readable; the app shell keeps its dark design.
- Destroy the remote document before clearing data, clear both active and saved
  profiles, and serialize session mutations. Open the homepage after success.
- Attribute network requests to the current committed document; discard late
  old-page requests and stale analysis results.
- Suppress repeated network rows when analysis already describes that format.
- Cancel the complete yt-dlp process tree, including its Windows launcher worker.

## Verified on Windows (2026-10-07)

- `npm test`: 70 tests passed across 9 files.
- `npm run test:binary-setup`: 5 tests passed, including tamper rejection.
- `npm run typecheck`: renderer/shared and Electron checks passed.
- `npm run lint`: zero errors; seven existing Fast Refresh export warnings.
- `npm run build`: Lovable web and static Electron builds passed. Vite retains
  a non-blocking warning about the renderer bundle exceeding 500 kB.
- Production and development Electron smoke runs both exited 0. They covered
  navigation, HTTP popups, media filtering/deduplication, real yt-dlp formats,
  native sidebar/panel/window sizing, route hiding, EN/VI, window controls,
  rejected foreign IPC, Node isolation, cookie persistence, temporary-session
  isolation across relaunches, and clearing active/inactive browser storage.
- The official checksum-verified yt-dlp 2026.08.19 executable analyzed the local
  HTML media fixture. A separate stalled-HTTP check confirmed cancellation
  leaves no launcher/worker processes running.
- Visual inspection covered the original dark shell and the actual native
  website canvas. Screenshots and smoke logs are in ignored `artifacts/`.

Run UI tests separately from concurrent CPU-heavy builds on slower machines:
an initial simultaneous verification batch exceeded two UI test timeouts;
the normal isolated suite passed in approximately three seconds.

## Remaining limitations

- Downloads, FFmpeg, SQLite/library, Drive, tray, installer, and other later
  milestones are not implemented. Their existing UI mocks remain.
- yt-dlp does not yet receive embedded-browser cookies. Sites requiring login,
  provider-specific extraction runtimes, or disallowing embedded browsers may
  not analyze successfully. DRM is explicitly unsupported.
- Automated media fixtures exercise browser networking and metadata analysis;
  the synthetic MP4 fixture is not a codec/playback conformance test.
- Installer generation and packaged execution are deferred. The production
  smoke uses compiled desktop artifacts launched with the installed Electron
  runtime. No published history was rewritten and no commits were pushed.
