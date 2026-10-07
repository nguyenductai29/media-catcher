# MediaVault

Windows-first desktop media browser built on the existing [Lovable project](https://lovable.dev/projects/89c6c254-01ad-440e-a997-49916bb992b0). React, TanStack routes, Tailwind/shadcn design, and English/Vietnamese UI are shared by the web preview and Electron renderer.

## Milestone one

- Frameless Electron window with working minimize, maximize/restore and close.
- Real WebContentsView: address entry, back/forward, reload/stop, homepage, title/favicon and bounds that follow the sidebar and page layout.
- Separate persistent browser session, optional temporary sessions, homepage preference, clear cookies and clear browser data.
- Live network candidates for video/audio/HLS/DASH, bounded deduplication and segment filtering; scan a page with yt-dlp to see available formats.
- Typed, sender-validated IPC, sandboxed renderer and remote content, safe HTTP(S) navigation and bounded cancellable child processes.

Downloads are disabled in the detection panel. Downloads, Library, Drive, Activity, storage figures and settings outside the Browser section are still the original prototype data. No Drive, download engine, SQLite, FFmpeg, tray, first-run wizard or installer is implemented in this milestone.

## Run on Windows

Use Node.js 22.12+ and npm for development. The standalone yt-dlp executable does not require Python.

```powershell
npm ci
npm run setup:ytdlp
npm run electron:dev
```

`setup:ytdlp` explicitly downloads the official release for the host platform, checks its SHA-256 against the release manifest, and refuses to overwrite an existing executable. Binaries are ignored by Git. The app never downloads or updates them silently. A missing binary still allows browsing/network detection and produces a localized message when scanning.

To use an existing trusted development executable:

```powershell
$env:MEDIAVAULT_YTDLP_PATH = 'C:\Tools\yt-dlp.exe'
npm run electron:dev
```

The override is ignored in a packaged application. Production lookup is `process.resourcesPath/bin/yt-dlp.exe`; future packaging must include it there. F12 toggles renderer DevTools in development. Changes to Electron main/preload require restarting `electron:dev`; React changes refresh normally.

## Build and verify

```powershell
npm run typecheck
npm run lint
npm test
npm run test:binary-setup
npm run build
npm run electron:start
```

`build` verifies both the original Lovable web build (`.output`) and static desktop renderer (`dist-desktop`) plus main/preload (`dist-electron`). The desktop uses a local application protocol and hash routing, with no local HTTP server required after building. `electron:start` launches those built artifacts.

`npm run test:desktop` builds and runs real Electron integration checks using local HTTP fixtures and isolated temporary browser profiles. It requires a graphical desktop session. Install yt-dlp first to also exercise real metadata analysis. The fixture verifies metadata/detection, not video codec playback.

`npm run dev` continues to run the original Lovable web preview. Native browser controls show a desktop-only message in a regular browser. `npm run build:web` and `npm run build:desktop` can be used independently.

## Local data and boundaries

Browser settings and the browser profile live under `%APPDATA%\MediaVault`, separate from application files. Language remains a lightweight renderer preference. Turning off Save browser session creates a fresh in-memory session; changing it reloads the page. Data clearing affects only MediaVault's embedded browser, not Chrome/Edge or the application's language preference.

Clearing data also clears the saved browser profile when a temporary session is
active, then opens the homepage. The desktop build bundles its interface fonts
locally so its typography does not depend on a font CDN.

HTTP(S) popups open in the existing embedded view. Unsupported external schemes, unsolicited website downloads, device access, notifications and permissions other than fullscreen are blocked. Some sites restrict embedded-browser login or require extra extractor support. yt-dlp does not receive browser cookies in this milestone; authenticated analysis may therefore fail even after login. DRM circumvention is not supported.

See [implementation plan](docs/desktop-milestone-one.md), [binary setup details](resources/bin/README.md), [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security), and the [official yt-dlp documentation](https://github.com/yt-dlp/yt-dlp).

Keep connected Git history intact: do not force-push, amend or rebase published commits. Changes on the connected branch sync back to Lovable.
