# MediaVault

Windows desktop media browser, download manager, local library and Google Drive
backup app, built on the existing
[Lovable project](https://lovable.dev/projects/89c6c254-01ad-440e-a997-49916bb992b0).
React, TanStack routes, Tailwind/shadcn and English/Vietnamese UI are shared with
the web preview. Electron Main owns native operations, credentials and files.

Start with the [Windows setup and test guide](docs/final-setup-and-test.md), then
use the [final E2E checklist](docs/final-e2e-checklist.md). Local packaged and NSIS
tests have passed; real Google authorization, an actual Windows reboot and a fresh
machine remain explicit manual checks.

The [final phase report](docs/final-phase-report.md) records implementation details,
changed files, verification evidence and remaining limitations.

## What works

- Native embedded browser with navigation, persistent/temporary sessions, network
  media detection and yt-dlp format analysis. Authorized non-DRM analysis/downloads
  can use narrowly scoped cookies from MediaVault's browser.
- Real yt-dlp downloads, FFmpeg merge/remux, ffprobe validation, concurrency 1–5,
  pause/resume/cancel/retry and persisted recovery. Completed files enter Library.
- Local file/folder imports, metadata, thumbnails, search/sort, playback, reveal,
  separate remove/delete actions and optional sampled duplicate detection.
- Google Drive desktop OAuth, real quota and managed folder, streamed resumable
  uploads with concurrency 1–3, account-aware recovery and manual/automatic upload.
  Auto-upload defaults off; local deletion defaults to Never.
- Six-step first-run wizard, tray/background work, explicit Exit, Windows startup
  setting, themes, EN/VI settings and native dialogs.
- SQLite schema v3, backups before migrations, explicit corruption recovery,
  safe storage cleanup, bounded sanitized logs and diagnostic JSON export.
- Explicit verified yt-dlp updates. Application update controls show an honest
  unconfigured state by default; a configured build requires a pinned signed publisher.
- Windows x64 NSIS installer with bundled binaries and native SQLite. Upgrade and
  uninstall preserve application data and local media.

## Run on Windows

Use Windows x64, Git, and Node.js **22.12 or newer**; Node **22.23.3** was used for
verification. Use an NTFS/hard-link-capable download destination. Python is not
required for the standalone yt-dlp executable.

```powershell
git clone https://github.com/nguyenductai29/media-catcher.git
Set-Location .\media-catcher
npm ci
$env:MEDIAVAULT_YTDLP_VERSION = '2026.08.19'
$env:MEDIAVAULT_FFMPEG_VERSION = '9.0.2'
npm run setup:ytdlp
npm run setup:ffmpeg
npm run electron:dev
```

These setup versions match the checked-in notice/checksum manifest. Setup is
explicit and checksum-verified and refuses to replace existing executables.
Selecting newer tools requires a deliberate manifest/license review before packaging.
See [binary setup details](resources/bin/README.md) and
[third-party notices](THIRD-PARTY-NOTICES.md).

`npm run dev` opens the Lovable web preview. Native functionality is available in
Electron. Main/preload edits require restarting `electron:dev`; React changes
refresh normally. F12 opens development renderer tools.

## Google Drive configuration

Create a Google Cloud project, enable Drive API, configure the consent screen and
create an OAuth **Desktop app** client using the
[step-by-step guide](docs/final-setup-and-test.md#3-configure-google-drive).
Start MediaVault from the same PowerShell terminal:

```powershell
$env:GOOGLE_CLIENT_ID = 'YOUR_DESKTOP_CLIENT_ID.apps.googleusercontent.com'
# Only if supplied/required for your Desktop client:
$env:GOOGLE_CLIENT_SECRET = 'YOUR_DESKTOP_CLIENT_CREDENTIAL'
npm run electron:dev
```

These are Main-only launch variables; never use a `VITE_` prefix. `.env.local` is
not loaded automatically. The explicit alternative is
`node --env-file=.env.local scripts/electron-dev.mjs`. Packaged launches also need
the configuration in their environment; building does not embed it.

Connect through the app and authorize in the system browser. Google tokens are
encrypted with OS-backed safeStorage; upload sessions are encrypted in SQLite.
Neither is sent to the renderer. Normal automated tests require no Google account.
`npm run test:drive:manual` is an interactive, isolated real-account helper; it also
accepts `--packaged-executable` with the absolute installed/built `.exe` path.

## Build, package and verify

```powershell
npm run typecheck
npm run lint
npm test
npm run test:binary-setup
npm run test:packaging
npm run test:fixtures
npm run build
npm run test:desktop
npm run package:win
npm run test:packaged
npm audit
```

`build` checks the web build and produces `dist-desktop` plus `dist-electron`.
`electron:start` launches built development artifacts. `package:win` creates
`release\MediaVault-Setup-0.1.0.exe` and `release\win-unpacked\MediaVault.exe`.
`package:dir` creates only the unpacked application. Packaging never publishes.
The [guide](docs/final-setup-and-test.md#8-verify-install-upgrade-and-uninstall)
includes the actual isolated 0.1.0 → 0.1.1 installer test commands.

```powershell
npm run fixtures:generate -- --output .\artifacts\fixtures --dash --large-mib 128
# Substitute the new run directory printed by the generator:
npm run fixtures:serve -- --directory 'C:\path\to\printed-run-directory' --port 8765
```

Fixtures are generated media only: MP4, HLS, optional DASH, authenticated local
video, range requests and controllable interruption. No personal files are selected
or removed. Smoke tests use isolated profiles and actual packaged executables.

## Data and release boundaries

Default mutable data is under `%APPDATA%\MediaVault`; media/cache directories are
under the Windows Videos directory in `MediaVault\Downloads`, `Thumbnails` and
`Temp`. Imports reference their selected file. Remove from Library keeps the file;
Delete Local File requires confirmation. Resume depends on source support, and
unfinished work returns paused after restart.

Supported absolute `--user-data-dir=...` and `--media-videos-dir=...` launch switches
isolate development or packaged profiles outside the installation. Packaged builds
ignore development binary/path override environment variables. Local playback uses
a restricted application protocol; codecs unsupported by Chromium can use the
controlled default-application action.

Local installers are currently **unsigned**. The compiled public update provider
is disabled by `resources/update-provider.json` (`{"provider": null}`). Signing and
a real signed release feed have not been verified. Complete GPL corresponding
source availability for bundled standalone binaries also remains unverified; read
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) before public redistribution. A
successful local build is not a public-release readiness claim.

DRM bypass, Drive downloads, shared drives, simultaneous accounts and full two-way
Drive sync are outside scope. Some sites reject embedded browsers or require
extractor support beyond the current authorized cookie bridge.

## Project history

The [Phase 1](docs/desktop-milestone-one.md),
[Phase 2](docs/desktop-phase-two.md) and
[Phase 3](docs/desktop-phase-three.md) documents describe their historical scope;
the final setup guide describes current behavior. Keep connected Git history
intact: do not force-push, amend or rebase published commits. Changes on the
connected branch sync back to Lovable.
