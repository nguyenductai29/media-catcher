# MediaVault

Windows-first desktop media browser built on the existing [Lovable project](https://lovable.dev/projects/89c6c254-01ad-440e-a997-49916bb992b0). React, TanStack routes, Tailwind/shadcn design, and English/Vietnamese UI are shared by the web preview and Electron renderer.

## Desktop features

- Frameless Electron window with working minimize, maximize/restore and close.
- Real WebContentsView: address entry, back/forward, reload/stop, homepage, title/favicon and bounds that follow the sidebar and page layout.
- Separate persistent browser session, optional temporary sessions, homepage preference, clear cookies and clear browser data.
- Live network candidates for video/audio/HLS/DASH, bounded deduplication and segment filtering; scan a page with yt-dlp to see available formats.
- Typed, sender-validated IPC, sandboxed renderer and remote content, safe HTTP(S) navigation and bounded cancellable child processes.

- Real yt-dlp downloads with FFmpeg merge/remux, structured progress, concurrency
  1–5, pause/resume, cancel, retry and persisted queue recovery.
- SQLite download history, library, activity and download preferences. Completed
  jobs enter the library only after ffprobe validates the file.
- Local file/folder imports, metadata and thumbnails, search/sort, grid/list,
  restricted local playback, reveal in folder, separate remove and confirmed delete.

- Google Drive desktop OAuth, encrypted credentials, real quota and a managed
  MediaVault folder. Streamed resumable uploads with concurrency 1–3, live progress,
  pause/resume/cancel/retry and persistent recovery.
- Manual Library uploads and optional auto-upload after a committed download.
  Verified cloud copies, Drive-only Library records, safe local deletion policies,
  account-aware metadata sync and Drive activity in English and Vietnamese.

The web preview remains available without desktop capabilities. Installer, tray,
updater, startup registration and first-run wizard remain future work.

## Run on Windows

Use Node.js 22.12+ and npm for development. The standalone yt-dlp executable does not require Python.

```powershell
npm ci
npm run setup:ytdlp
npm run setup:ffmpeg
npm run electron:dev
```

`setup:ytdlp` explicitly downloads the official release for the host platform, checks its SHA-256 against the release manifest, and refuses to overwrite an existing executable. Binaries are ignored by Git. The app never downloads or updates them silently. A missing binary still allows browsing/network detection and produces a localized message when scanning.

`setup:ffmpeg` installs FFmpeg and ffprobe for Windows x64 from the Gyan build
publisher linked by ffmpeg.org, verifies its SHA-256, extracts only the expected
executables and refuses to overwrite existing files. See the binary setup details
below for supported overrides and licensing. Settings reports all three binaries.

To use an existing trusted development executable:

```powershell
$env:MEDIAVAULT_YTDLP_PATH = 'C:\Tools\yt-dlp.exe'
$env:MEDIAVAULT_FFMPEG_PATH = 'C:\Tools\ffmpeg.exe'
$env:MEDIAVAULT_FFPROBE_PATH = 'C:\Tools\ffprobe.exe'
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
npm run test:desktop
npm run electron:start
```

`build` verifies both the original Lovable web build (`.output`) and static desktop renderer (`dist-desktop`) plus main/preload (`dist-electron`). The desktop uses a local application protocol and hash routing, with no local HTTP server required after building. `electron:start` launches those built artifacts.

`npm run test:desktop` builds and runs real Electron integration checks using
local HTTP fixtures and isolated temporary browser/database/media directories.
It requires a graphical desktop session and the three installed binaries. Phase 2
uses real locally generated H.264/AAC media to exercise downloading, validation,
persistence and automatic library updates.

`npm run dev` continues to run the original Lovable web preview. Native browser controls show a desktop-only message in a regular browser. `npm run build:web` and `npm run build:desktop` can be used independently.

## Connect Google Drive

Follow [Google Drive setup](docs/google-drive-setup.md) to create a Google Cloud
project, enable Drive API, configure Branding/Audience/Data Access, add your test
account, and create an OAuth **Desktop app** client. Then start Electron from the
terminal containing your configuration:

```powershell
$env:GOOGLE_CLIENT_ID = 'YOUR_DESKTOP_CLIENT_ID.apps.googleusercontent.com'
# Optional public desktop credential, if required by your Google client:
$env:GOOGLE_CLIENT_SECRET = 'YOUR_DESKTOP_CLIENT_CREDENTIAL'
npm run electron:dev
```

Open Google Drive → Connect and authorize in the system browser. Configuration
is read by Electron Main; do not use `VITE_` variables. `.env.example` contains only
placeholders. To use a local env file, run
`node --env-file=.env.local scripts/electron-dev.mjs` explicitly.

OAuth uses a temporary loopback callback, random state and S256 PKCE. Requested
scopes are `drive.file`, `openid`, `email` and `profile`; full Drive access is not
requested. Refresh credentials use Electron safeStorage (Windows DPAPI) under
`%APPDATA%\MediaVault\auth\google-auth.dat`; access tokens remain in Main memory.
Upload session URLs are encrypted in SQLite. No tokens or upload sessions enter
the renderer or logs, and unavailable secure storage has no plaintext fallback.

MediaVault creates/reuses **My Drive / MediaVault** by saved ID and app-owned
metadata. Library uploads use that destination and numbered names for collisions.
Sync Now refreshes quota and known managed file IDs; it does not scan your entire
Drive. Disconnect keeps files and completed metadata. A different account cannot
resume previous-account uploads or silently claim their cloud records.

Chunks default to 8 MiB and stream through bounded disk buffers. Pause retains
the encrypted session; Resume validates size/mtime and queries Google's confirmed
offset. Restart restores unfinished work as paused, with metadata reconciliation
for uncertain completions. Expired sessions can restart using the same preallocated
file ID. Cancel discards its session reference and retains that ID for safe Retry;
it does not delete local or remote files. Transient requests have at most three
attempts with backoff. See [Phase 3 architecture and verification](docs/desktop-phase-three.md).

**Auto-upload defaults to off. Local deletion defaults to Never.** Auto-upload
runs only after the local download transaction succeeds. Ask me/Automatically
delete only after verified Drive metadata, matching size and a committed cloud
record, followed by another metadata/file-integrity check. Ask does not occupy an
upload worker. Deletion keeps a Drive-only Library record and thumbnail; local
playback and reveal actions are disabled for unavailable files.

Normal tests and `test:desktop` require no Google credentials. For explicit live
verification, build the desktop app and run `npm run test:drive:manual` from an
interactive terminal with your OAuth configuration. It generates a tiny test video
and opens an isolated profile; you initiate login, uploads and deletion through
the UI. This helper is not an automated real-Google test.

## Local data and boundaries

Browser settings and the browser profile live under `%APPDATA%\MediaVault`, separate from application files. Language remains a lightweight renderer preference and is mirrored to SQLite for native dialogs. Turning off Save browser session creates a fresh in-memory session; changing it reloads the page. Data clearing affects only MediaVault's embedded browser, not Chrome/Edge or the application's language preference.

`%APPDATA%\MediaVault\mediavault.db` stores versioned SQLite tables for downloads,
media, download/Drive settings, upload jobs and activity. Schema v2 preserves v1
data and adds Drive/account/availability metadata. The database uses WAL, foreign keys and
transactional migrations. `better-sqlite3` 13 uses bundled Node-API prebuilds; it
was verified with both the development Node runtime and the installed Electron
runtime without rebuilding. Electron/SQLite code is excluded from the web renderer.

Media directories are created when needed under `%USERPROFILE%\Videos\MediaVault`:
`Downloads`, `Thumbnails` and `Temp`. A native picker can select another download
destination. Existing files are never overwritten; duplicate titles receive
numbered suffixes. Imports reference the selected local file without copying it.
Remove from Library leaves the file intact; Delete Local File asks before deleting.

Pause stops the entire worker process tree and preserves job partials. Resume
queues the same job with `--continue`; actual byte resumption depends on the
server/extractor. Cancel also retains useful partials for Retry. Completed staging
files are cleaned after the database commit. On restart, all unfinished jobs become
paused and require an explicit Resume. Closing with active work asks before pausing
and shutting down workers. Automatic retry, when enabled, permits one retry for
transient download failures.

MP4/MKV selection merges/remuxes without full video re-encoding. Audio mode extracts
the best original audio container. Chromium cannot preview every valid media codec;
the player offers a controlled default-application action. Technical error codes and
job IDs are retained in bounded local logs; cookies, headers, signed URLs and raw
worker output are excluded.

Development integration tests can set absolute `MEDIAVAULT_USER_DATA` and
`MEDIAVAULT_VIDEOS_DIR` paths to isolate local state. Packaged builds ignore all
development path overrides.

Clearing data also clears the saved browser profile when a temporary session is
active, then opens the homepage. The desktop build bundles its interface fonts
locally so its typography does not depend on a font CDN.

HTTP(S) popups open in the existing embedded view. Unsupported external schemes, unsolicited website downloads, device access, notifications and permissions other than fullscreen are blocked. Some sites restrict embedded-browser login or require extra extractor support. yt-dlp does not receive browser cookies in this milestone; authenticated analysis may therefore fail even after login. DRM circumvention is not supported.

See [Phase 2 design and verification](docs/desktop-phase-two.md),
[Phase 3 design and verification](docs/desktop-phase-three.md),
[Google Drive setup](docs/google-drive-setup.md),
[Phase 1 implementation](docs/desktop-milestone-one.md),
[binary setup details](resources/bin/README.md),
[Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security),
[better-sqlite3 releases](https://github.com/WiseLibs/better-sqlite3/releases), and
the [official yt-dlp documentation](https://github.com/yt-dlp/yt-dlp).

Keep connected Git history intact: do not force-push, amend or rebase published commits. Changes on the connected branch sync back to Lovable.

Phase 4 remains unimplemented: installer, tray/background operation, Windows startup,
auto-updater and first-run wizard. Drive downloads, shared drives, Google Picker,
simultaneous accounts and full two-way sync also remain outside this phase.
