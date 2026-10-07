# MediaVault: Windows setup and functional testing

This guide covers the current Windows x64 implementation. Commands use PowerShell
from the repository root unless stated otherwise. Use generated fixtures and an
isolated profile for destructive tests; **never test deletion on personal media**.
The [E2E checklist](final-e2e-checklist.md) separates automated evidence from checks
that still require a real account, reboot or fresh Windows machine.

## 1. Install prerequisites and clone

Install Git for Windows and a supported Node.js x64 runtime, then open a new
PowerShell terminal. The minimum is **Node 22.12.0**; the verified runtime was
**22.23.3**. Use the [official Node distribution](https://nodejs.org/en/download)
and retain the repository lockfile. Python and a system FFmpeg installation are
not required. Electron/installer smoke tests need an interactive Windows desktop.

```powershell
node --version
npm --version
git --version
git clone https://github.com/nguyenductai29/media-catcher.git
Set-Location .\media-catcher
npm ci
```

Keep `package-lock.json` and use `npm ci` for setup. With npm 10.9.8, resolving
dependencies without this lockfile can fail with `Cannot read properties of null
(reading 'edgesOut')`. Restore a deleted lockfile with
`git restore -- package-lock.json` before installing.

The lockfile also preserves `gypfile: false` for `better-sqlite3`, which already
bundles its Windows binary. This works around npm invoking an unnecessary
`node-gyp rebuild` ([upstream issue](https://github.com/WiseLibs/better-sqlite3/issues/1516)).
Regenerating the lockfile can remove that field; preserve it in the
`node_modules/better-sqlite3` entry when updating dependencies.

Choose an NTFS/hard-link-capable download destination with sufficient free space.
MediaVault preflights exclusive hard-link publication before downloading; FAT/exFAT
and shares without this capability are unsupported download destinations. Keep
data/media outside the installation. The per-user app/installer needs no elevation.

## 2. Set up tools and launch development

```powershell
$env:MEDIAVAULT_YTDLP_VERSION = '2026.08.19'
$env:MEDIAVAULT_FFMPEG_VERSION = '9.0.2'
npm run setup:ytdlp
npm run setup:ffmpeg
npm run electron:dev
```

The versions above match the checked-in packaging manifest. Setup explicitly
downloads and verifies official yt-dlp and the Gyan FFmpeg/ffprobe build linked by
FFmpeg's project. It refuses to overwrite existing files. Settings
→ Binaries reports versions. Missing tools produce localized errors.

Development tools live in `resources\bin`. Absolute `MEDIAVAULT_YTDLP_PATH`,
`MEDIAVAULT_FFMPEG_PATH` and `MEDIAVAULT_FFPROBE_PATH` variables can select trusted
development executables. Packaged builds ignore these overrides; an explicit
development yt-dlp override also disables in-app replacement of that executable.

Packaging pins binary bytes in `resources/notices/binaries.json`. Omitting these
version variables selects latest. If that differs from the manifest, packaging
intentionally fails. Review the selected release's
licenses/source inputs and update the manifest deliberately; do not bypass checks.
See [binary instructions](../resources/bin/README.md) and
[third-party notices](../THIRD-PARTY-NOTICES.md).

Main/preload changes need a development restart. React edits refresh normally.
`npm run dev` opens the web preview, which cannot perform native downloads or Drive
authorization. `npm run electron:start` launches already-built desktop artifacts.

## 3. Configure Google Drive

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select a
   project. Open **APIs & Services → Library → Google Drive API → Enable**.
   See Google's [API enablement guide](https://developers.google.com/workspace/guides/enable-apis).
2. Open **Google Auth Platform → Branding**. If necessary, choose **Get started**;
   enter your app name, support email and developer contact.
3. Under **Audience**, choose **External** for a personal account, keep development
   in **Testing**, and add your account under **Test users**. Internal access needs
   an eligible Workspace organization. Under **Data Access**, add the scopes below.
   Google's [consent guide](https://developers.google.com/workspace/guides/configure-oauth-consent)
   describes these sections.
4. Under **Clients → Create client**, choose **Desktop app**, name it and create it.
   Copy its client ID. Use Desktop app, not Web application or a service account.
   See Google's [desktop credential instructions](https://developers.google.com/workspace/guides/create-credentials#desktop-app).

Requested scopes:

- `https://www.googleapis.com/auth/drive.file`
- `openid`
- `https://www.googleapis.com/auth/userinfo.email` (`email`)
- `https://www.googleapis.com/auth/userinfo.profile` (`profile`)

`drive.file` limits access to files created by or explicitly shared with the app;
MediaVault manages its own folder/uploads rather than enumerating all Drive files.
See [Google's Drive scope reference](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

MediaVault opens the system browser and listens on a temporary `127.0.0.1` port
with state and S256 PKCE. A Desktop client needs no hosted callback. The code sends
`client_secret` only when supplied; Google's installed-app flow defines it as
optional. If your client/token exchange requires it, use the matching Desktop
credential, not a service-account key. A distributed Desktop client cannot keep
that value confidential. See [Google's desktop OAuth flow](https://developers.google.com/identity/protocols/oauth2/native-app).

Set configuration in the same terminal that starts the app:

```powershell
$env:GOOGLE_CLIENT_ID = 'YOUR_DESKTOP_CLIENT_ID.apps.googleusercontent.com'
# Optional, only if supplied/required for this Desktop client:
$env:GOOGLE_CLIENT_SECRET = 'YOUR_DESKTOP_CLIENT_CREDENTIAL'
npm run electron:dev
```

Alternatively, copy `.env.example` to an untracked `.env.local` once, edit its
placeholders, and load it explicitly. Do not overwrite an existing local env file.

```powershell
if (Test-Path -LiteralPath .env.local) { throw '.env.local already exists; edit it instead.' }
Copy-Item -LiteralPath .env.example -Destination .env.local
# Edit .env.local, then:
node --env-file=.env.local scripts/electron-dev.mjs
```

The normal development command and the installed application do **not** load this
file into Main automatically. Building with these variables does **not** embed
them. Never use a `VITE_` prefix, commit credential JSON, or put access/refresh tokens
in these settings.

### Installed app, desktop shortcut and Windows startup

For persistent installed-app configuration, set your own Windows **User** variables
and the current terminal variables. This stores public Desktop client configuration,
not the access/refresh tokens MediaVault encrypts separately:

If these variable names already serve another application, retain their previous
configuration and use a dedicated configured terminal instead of overwriting them.

```powershell
$driveClientId = 'YOUR_DESKTOP_CLIENT_ID.apps.googleusercontent.com'
[Environment]::SetEnvironmentVariable('GOOGLE_CLIENT_ID', $driveClientId, 'User')
$env:GOOGLE_CLIENT_ID = $driveClientId
# Only when required for your Desktop client:
$driveDesktopCredential = 'YOUR_DESKTOP_CLIENT_CREDENTIAL'
[Environment]::SetEnvironmentVariable('GOOGLE_CLIENT_SECRET', $driveDesktopCredential, 'User')
$env:GOOGLE_CLIENT_SECRET = $driveDesktopCredential
```

Exit every existing MediaVault instance. Launch immediately from that terminal
using the actual installed path, normally:

```powershell
& "$env:LOCALAPPDATA\Programs\MediaVault\MediaVault.exe"
```

Sign out of Windows and back in before testing shortcut/Start Menu/startup launches
so Explorer and the app inherit the new environment. A variable set only in an
unrelated terminal will not configure an already-running app or old Explorer.
Use the current-terminal method alone if you do not want persistent configuration.
If later removing configuration you deliberately added, remove only those values:

```powershell
[Environment]::SetEnvironmentVariable('GOOGLE_CLIENT_ID', $null, 'User')
[Environment]::SetEnvironmentVariable('GOOGLE_CLIENT_SECRET', $null, 'User')
Remove-Item Env:GOOGLE_CLIENT_ID -ErrorAction SilentlyContinue
Remove-Item Env:GOOGLE_CLIENT_SECRET -ErrorAction SilentlyContinue
```

Do not remove pre-existing values used by another application. Disconnect MediaVault
first if you also want its saved authorization removed; removing configuration
alone does not revoke a Google grant.

Open **Google Drive → Connect**, or connect in onboarding/Settings. Authorize your
test account in the system browser and return to MediaVault. Verify account, quota
and **My Drive / MediaVault**. Cancelling must leave it disconnected. Testing-mode
grants can expire; reconnect according to Google's
[token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

Refresh credentials are encrypted in the profile's `auth\google-auth.dat`; access
tokens stay in Main memory. Upload sessions are encrypted in SQLite. Windows
safeStorage uses DPAPI; this protects against other OS users, not malware running
as the same user. There is no plaintext fallback. See
[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
Disconnect pauses uploads/removes saved authorization while retaining files.

## 4. Complete onboarding and check background behavior

A new profile shows six steps: language, download folder, quality, format, optional
Drive connection, and background/startup preferences. The default folder is Windows
Videos → `MediaVault\Downloads`; another supported folder can be native-picked.
The wizard offers Best/1080p/720p and MP4/MKV/original. Drive can be skipped.

Finish saves preferences and completion. Established earlier profiles skip the
wizard. Defaults are dark theme, close to tray, startup OFF, auto-upload OFF and
local deletion Never. Startup registration is available for packaged Windows;
development Electron is deliberately unsupported.

Close-to-tray hides the window while active work continues. Restore through the
tray. Its menu exposes Downloads, Settings, download/upload pause/resume and Exit.
Explicit Exit asks about active work and drains workers; Cancel keeps the app
running. Settings also offers Exit as a tray fallback. A real reboot/startup check
remains manual, separate from automated registry ON/OFF readback. Electron's
[login-item API](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows)
describes Windows registration behavior.

## 5. Generate and serve safe local media

In another terminal at the repository root:

```powershell
npm run fixtures:generate -- --output .\artifacts\fixtures --dash --large-mib 128
```

The helper prints a **new run directory** and manifest. It creates a 10-second
1080p MP4, a 60-second 360p MP4/HLS, optional DASH and an optional playable larger MP4. Larger fixtures contain
generated media, not sparse fake video. Existing files are not overwritten.
Substitute the printed absolute run directory:

```powershell
npm run fixtures:serve -- --directory 'C:\path\to\printed-run-directory' --port 8765
```

The server binds `127.0.0.1` only. Open its printed index in MediaVault:

| Route                                | Purpose                                           |
| ------------------------------------ | ------------------------------------------------- |
| `/clip-10s.mp4`, `/clip-60s.mp4`     | Direct MP4 with byte ranges                       |
| `/video-10s`, `/video-60s`           | HTML5 pages for detection/analysis                |
| `/hls/index.m3u8`                    | HLS playlist/segments                             |
| `/hls-video`                         | HTML5 page linking the HLS fixture                |
| `/dash-video`, `/dash/index.mpd`     | Optional generated DASH page/manifest             |
| `/video-large`, `/large.mp4`         | Optional larger generated fixture                 |
| `/login`                             | Set a local test session cookie inside MediaVault |
| `/protected-video`, `/protected.mp4` | Non-DRM media requiring that cookie               |
| `/logout`                            | Clear the fixture login                           |

Use the index for optional DASH/large-file links. Terminal commands are `offline`,
`online`, `throttle 128`, `interrupt 256`, `normal`, `status`, `quit`. Rate and
interrupt values use KiB/s and KiB. There are no HTTP mutation controls. Generated
files remain for inspection after shutdown.

Without `--port`, a free ephemeral port is chosen and printed. Cookie sessions
belong to this fixture-server run; restarting the server requires logging in again.
Optional `--large-mib` values range from 16 to 2048 MiB.

Open a video page, play it to trigger detection, scan formats, open the download
dialog and confirm a generated destination. Test MP4/MKV and audio-only; verify
progress, pause/resume, Library metadata and playback. Use `/video-10s` to verify
1080p. The quality setting is a preference/cap, not upscaling of the 360p fixture.

For authentication, scan `/protected-video` before login and expect failure. Visit
`/login` **inside MediaVault**, return, scan and download. Public analysis runs first;
a recognized authentication failure may retry once with narrowly scoped cookies.
The bridge neither imports Chrome/Edge cookies nor bypasses DRM. Cookie jars stay
Main-only and are removed after operations; startup clears stale owned jars.
Clear the browser session and verify a session-dependent retry fails safely until
reauthorization. Avoid an external debugger attachment during the short CDP bridge
operation.

Use a larger/throttled fixture for interruption/tray tests. `offline` is a local
server failure, not a physical adapter outage; test that separately. Restart should
restore unfinished jobs paused, requiring explicit Resume.

## 6. Run real Google checks manually

Use an interactive configured terminal:

```powershell
npm run build:desktop
npm run test:drive:manual
# Generate a larger playable fixture for pause/recovery checks:
npm run test:drive:manual -- --large-mib 128
# Alternative with explicit local env loading:
node --env-file=.env.local scripts/test-drive-manual.mjs --large-mib 128
```

The helper uses generated media and an isolated profile. It never authorizes,
uploads or deletes on your behalf. Follow its printed commands/checklist. Through
the UI, connect, upload small/larger generated files, pause/resume, restart the same
profile, inspect the real Drive result and test auto-upload.

Choose one manual-helper command per run, rather than starting concurrent profiles.
Its terminal commands are `status`, `restart`, `help` and `quit`. Restart retains
the generated profile; status reports safe state without asserting real-upload
success on your behalf.

After packaging, prefer an actual packaged executable for the final Google test.
This mode uses its bundled FFmpeg/ffprobe and passes isolated native profile paths:

```powershell
$packagedApp = (Resolve-Path -LiteralPath .\release\win-unpacked\MediaVault.exe).Path
npm run test:drive:manual -- --packaged-executable "$packagedApp" --large-mib 128
```

For the installed app, assign its actual absolute `.exe` path to `$packagedApp`.
Google configuration must still be present in the helper's launch environment.
The helper requires this repository's Node dependencies; a fresh-machine user can
instead follow the same UI checklist directly in the installed application.

Start with **Never** deletion. Test **Ask** by cancelling once, then confirming for
a disposable generated file. Test **Automatically** with another disposable file
after verifying the correct account/folder. Removal requires confirmed upload,
independent Drive metadata/size verification and committed cloud state. A Drive-only
record remains and local play/reveal are disabled. Another account must not resume
or relabel the first account's uploads.

Disconnect afterwards. Remove only generated Drive copies through Google's UI.
Retain the profile for further recovery checks; never recursively remove personal
Videos/AppData folders. No real-account check runs automatically in normal tests.

## 7. Build and install the Windows package

Close apps running from `release\win-unpacked` before rebuilding:

```powershell
npm run build
npm run package:win
npm run test:packaged
```

| Output                                                                                     | Purpose                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `release\MediaVault-Setup-0.1.0.exe`                                                       | Default per-user Windows x64 NSIS installer |
| `release\win-unpacked\MediaVault.exe`                                                      | Actual unpacked application                 |
| Install `resources\bin\yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`                            | Bundled tools                               |
| Install `resources\app.asar.unpacked\node_modules\better-sqlite3\prebuilds\win32-x64.node` | SQLite Node-API prebuild                    |
| Install `resources\notices`                                                                | Binary hashes/source references/licenses    |

`package:dir` builds only unpacked output. Staging does not rebuild development
`node_modules`. The actual native filename is `win32-x64.node`, not
`better_sqlite3.node`. Packaged smoke loads it and real tools with restricted PATH,
Unicode/space paths and isolated data, then checks unchanged install files.

Run the installer you built, then open its shortcut; it does not auto-launch.
Installation is per-user without elevation. Uninstall preserves AppData/media.
Current local artifacts are **unsigned**. Use an approved local testing environment
if Windows policy blocks them; do not weaken machine protections.

For an isolated unpacked launch, create new profile paths outside installation:

```powershell
$profileRoot = Join-Path $env:TEMP ('MediaVault manual Tiếng Việt 日本語 ' + [guid]::NewGuid())
$profilePath = Join-Path $profileRoot 'profile'
$videosPath = Join-Path $profileRoot 'videos'
& .\release\win-unpacked\MediaVault.exe "--user-data-dir=$profilePath" "--media-videos-dir=$videosPath"
```

For installed Google testing, use section 3's launch/environment steps. These two
Main-only switches accept one absolute value each in dev/packaged mode and reject
paths redirected into install/resources. The videos switch selects a parent;
app-owned folders appear under its `MediaVault` child. Keep values for restarts.
Packaged builds ignore development binary/path override variables.

## 8. Verify install, upgrade and uninstall

Use a dedicated clean test account/machine. The helper refuses an existing
MediaVault install/shortcut/process; do not bypass preflight. It uses generated
temporary Unicode/space installation, profile and media paths only.

Build both versions serially without editing the tracked package version:

```powershell
npm run package:win
npm run package:win -- '--config.extraMetadata.version=0.1.1'
$baseline = Join-Path (Get-Location).Path 'release\MediaVault-Setup-0.1.0.exe'
$upgrade = Join-Path (Get-Location).Path 'release\MediaVault-Setup-0.1.1.exe'
$env:MEDIAVAULT_SMOKE_ARTIFACTS = Join-Path (Get-Location).Path 'artifacts\final'
npm run test:installer -- "--baseline=$baseline" "--upgrade=$upgrade"
Remove-Item Env:MEDIAVAULT_SMOKE_ARTIFACTS
```

Keep the long `--config.extraMetadata.version=0.1.1` argument quoted in PowerShell.
The helper performs actual silent NSIS 0.1.0 install, imports generated media,
saves VI/theme/onboarding preferences, closes, upgrades to 0.1.1 and compares
Library IDs, SQLite schema/data, settings and media. Startup ON/OFF is tested only
if no previous entry exists: native registration and parsed arguments are read
back, then startup is restored OFF. Existing entries are preserved and compared.

It runs the owned uninstaller, checks executable/registration/shortcut removal,
and verifies retained profile/database/media. It never deletes registry entries
manually. The upgraded app also reports the correct maintenance/diagnostics version,
schema and tools. Failures retain scratch data for inspection. The command above
writes `artifacts\final\installer-result.json`; without the evidence override the
default is `artifacts\milestone-c\installer-result.json`. Capture a terminal log
separately when repeating it. The install/upgrade/uninstall flow passed in milestone
C. Actual reboot and fresh-machine behavior remain manual.

The second build leaves `win-unpacked` at 0.1.1. Set
`$env:MEDIAVAULT_EXPECTED_VERSION = '0.1.1'` before smoking that output, then remove
that test-only variable. Rebuild the default package to return to 0.1.0. Do not run
concurrent package/smoke jobs against the same output.

For manual upgrade, exit, install the newer package over the old one and reopen
the same profile. Compare Library/settings/files. Before manual uninstall,
disconnect Drive, set startup OFF, exit and use Windows Installed apps. Verify
profile/media remain. Do not delete personal media to demonstrate retention.

## 9. Storage, recovery, maintenance and diagnostics

Default user data is `%APPDATA%\MediaVault`; media/cache is in Windows Videos under
`MediaVault\Downloads`, `Thumbnails`, `Temp`. `mediavault.db` uses schema v3, WAL
and transactional migrations; original v1/v2 migrations remain unchanged.
Validated backups are created **before schema upgrades**, retaining three newest
valid copies. They are not continuous backups of all recent jobs or media.
Corruption offers native recovery/open-folder/exit choices. Explicit restore
quarantines DB/WAL/SHM evidence; there is no silent reset.

Settings → Storage reports five size categories. Cleanup considers only owned
unreferenced staging/unused thumbnails older than 24 hours and rotated logs older
than seven days. Persisted-job partials/referenced media are protected. Optional
sampled duplicate detection defaults OFF and reads at most three 1 MiB samples;
it is a duplicate hint, not full-file integrity verification.

Settings → Binaries offers explicit yt-dlp Check/Update using official metadata,
SHA-256, bounded downloads, version verification and an exclusive binary lease.
An atomic verified override lives in `userData\bin`; packaged tools stay unchanged.
Missing/invalid overrides fall back safely. Check/Update repairs an absent or
already-quarantined override. A corrupt immutable executable still present at the
expected filename instead produces a checksum error: fully exit MediaVault, then
explicitly rename/quarantine **only that identified corrupt `userData\bin` EXE**
and reopen before Check/Update. Preserve it for diagnosis; never delete the profile,
database, browser session or media to repair a tool. Update requires idle tools;
Check remains available to refresh stale busy state.
FFmpeg/ffprobe version/build source are shown without silent self-updates.

Diagnostics shows app/Electron/Node/tool versions, platform, schema, local paths,
disk space, active counts and Drive/session state. Logs support component/kind
filter, selected copy, folder open and clear; the UI shows at most 200 entries.
Rotation is five files of at most 1 MiB each. Export uses a native save picker and
allowlisted JSON; cancelling writes nothing. Media, credential/cookie files, OAuth
codes, authorization headers, resumable/signed sensitive URLs and all local paths
are excluded from the JSON export. Paths are displayed only on the Diagnostics
page; review them before sharing a screenshot. Export includes aggregate job-status
counts, not raw job records.

## 10. Application updates and release preparation

`resources/update-provider.json` defaults to `{"provider": null}`. Settings
honestly reports unconfigured updates and disables unavailable actions. Mounting
Settings performs no automatic network update check.

A release maintainer may configure this strict build-time shape and rebuild:

```json
{
  "provider": "github",
  "owner": "your-public-owner",
  "repo": "your-public-release-repository",
  "publisherName": "EXACT SIGNING CERTIFICATE PUBLISHER"
}
```

The provider is compiled into Main, with no renderer/userData/environment feed
override. Only the pinned public repository/official GitHub asset hosts are used;
no private-feed token is embedded. Configured builds enable `forceCodeSigning`
and pin the publisher. Supply signing credentials outside tracked config through
the supported certificate store or `CSC_LINK`/`CSC_KEY_PASSWORD`, following
[electron-builder 26 signing](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/).
Never commit a certificate/password/token.

Check, Download and **Install update and exit** are separate user actions. Updates
require one expected installer name, SHA-512, exact declared size (maximum 2 GiB)
and valid Authenticode matching the publisher. Streaming caps are 2 MiB for metadata
and the selected installer size for binary bodies. Missing/malformed signature
results fail closed. Files are rechecked before install; workers drain first.
Ordinary exit never installs automatically; successful install does not auto-restart.

Package scripts use `--publish never`. No signed public feed or signed MediaVault
update has been tested. Native verification accepted a known signed Windows binary
and rejected a wrong publisher/unsigned installer. Complete a real signed release
test separately. Resolve the GPL corresponding-source gaps in
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) before public redistribution:
complete matching standalone-binary source inputs have not been verified. Local
packaging success is not public-release readiness.

## 11. Repeat automated checks

Close manual test applications, then run serially:

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
npm audit --omit=dev
git diff --check
```

None authorizes real Google accounts. Final E verification passed 602 tests in
74 files, 11 binary setup, seven packaging and eight fixture tests, typecheck,
lint, web/desktop builds, actual desktop/packaged smoke and NSIS install/upgrade/
uninstall. See [the final report](final-phase-report.md) for evidence and limits;
use fresh command output after further changes.
The audited lockfile had zero production advisories and eight moderate build-time
transitive reports from one unpatched `sprintf-js` advisory, no high/critical.
Do not apply a forced breaking downgrade just to change that count.

Keep failed-run evidence/profile. Use localized errors and Diagnostics rather than
sharing raw secrets. For Google issues check client type, project/test user,
matching optional credential and account policy. For publication issues check
NTFS, free space and native-picked destination permissions; for tool issues check
versions and setup/manifest guidance.
