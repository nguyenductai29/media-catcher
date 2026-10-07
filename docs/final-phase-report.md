# MediaVault final phase report

Date: 2026-10-07. Target: Windows x64. Application version: `0.1.0`.

Implementation and automated Windows verification are finished. Milestones A–E
passed their local gates, including the final packaged app and actual NSIS
install/upgrade/uninstall. Real Google, fresh-machine, physical reboot and signed
release acceptance remain explicit manual checks. No public release, Git push,
real Google authorization, or real Drive upload was performed. Changes are uncommitted.

## Product behavior

- The existing Lovable layout, React routes, Main-process services, typed preload
  bridge, and EN/VI localization remain in place.
- The branded tray opens MediaVault, Downloads, or Settings; pauses/resumes both
  queues; and provides explicit Exit. Closing defaults to hiding the window while
  Main continues work. An unavailable tray falls back to a confirmed exit. Active
  work is drained only after accepted Exit.
- Windows startup defaults OFF. The setting reads actual user registration and
  checks the MediaVault startup item, including Windows paths with spaces and
  Unicode. The packaged installer acceptance toggles real startup registration ON
  and OFF and verifies the native command arguments. A physical OS reboot remains
  a manual checklist item.
- First launch offers language, download folder, quality, format, optional Google
  Drive, and background behavior. Completion is persisted; established older
  profiles do not unexpectedly enter onboarding. App identity is
  `com.mediavault.desktop`, executable `MediaVault.exe`, author `nguyenductai29`.

## Reliability and authenticated media

The Main-only cookie bridge obtains cookies from the MediaVault browser session,
checks domain/path/security/expiry, and rejects partitioned or ambiguous cookies.
Electron session cookies are cross-checked against Main-owned Chromium metadata so
partitioned cookies cannot be mistaken for ordinary cookies. It never reads another
browser's profile. Public analysis is attempted first; only an authentication
failure can trigger one scoped-cookie retry. Authorized downloads create cookie
material just before spawning yt-dlp. Persisted jobs retain only the requirement
flag, never cookie contents.

Netscape jars use unique exclusive files in an owned temporary directory. Cleanup
waits for child termination on success, failure, pause, cancel, session changes and
shutdown; startup removes owned stale jars. Removal means filesystem unlink, not a
claim of physical SSD erasure. Cookie values and temporary jar paths do not enter
the renderer, application logs, diagnostics or exported reports. DRM remains
unsupported.

Offline operations pause for explicit resume. Download publication journals cover
copying, processing, and final publication, preserve original components until
success, and compare exact Windows file IDs. Completed outputs are not overwritten
or duplicated during recovery. Publication requires a target supporting hard links
(use NTFS on Windows); failure is detected before a large transfer. Drive recovery
retains its account/mutation checks, resumable session handling and finalization
reconciliation, with tests for disconnect and interrupted completion.

Database migrations create a consistent SQLite snapshot first and retain three
backups. Corruption never silently replaces the database with an empty one. A
native dialog offers the data folder, explicit restore, or Exit; damaged originals
are quarantined. Storage cleanup is limited to owned stale, unreferenced staging,
thumbnails and old logs. It preserves resumable jobs and user media. Optional
duplicate detection samples the first, middle and last 1 MiB instead of hashing an
entire large video; it is a duplicate hint, not an integrity guarantee.

## Database and files

Migration v3 adds `downloads.requires_browser_session` and
`media.content_fingerprint`, plus the partial `(file_size, content_fingerprint)`
index for local media. Original v1 and v2 SQL is unchanged. Product/storage settings
reuse the existing settings table; diagnostics and updates need no extra tables.

| Item                        | Location                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Final local installer       | `release/MediaVault-Setup-0.1.0.exe`                                                                         |
| Upgrade acceptance build    | `release/MediaVault-Setup-0.1.1.exe`                                                                         |
| Unpacked executable         | `release/win-unpacked/MediaVault.exe`                                                                        |
| Bundled tools               | `<installation>/resources/bin/{yt-dlp,ffmpeg,ffprobe}.exe`                                                   |
| Native SQLite               | `resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-x64.node`                           |
| Installed notices           | `<installation>/resources/notices/`                                                                          |
| Database/settings/auth/logs | Electron `app.getPath("userData")`, shown in Diagnostics                                                     |
| Default media               | Windows Videos known folder + `MediaVault\Downloads` (typically `%USERPROFILE%\Videos\MediaVault\Downloads`) |
| yt-dlp update override      | `<userData>/bin/`, with a verified immutable executable and atomic active pointer                            |

better-sqlite3 13 uses a Node-API `win32-x64.node` prebuild rather than a file literally
named `better_sqlite3.node`. Actual packaged and installed database operations,
rather than filename assumptions, verify it loads.

NSIS installs per user without elevation. Data and media remain outside the install
directory. Upgrade preserves the profile, settings and Library; uninstall preserves
database and media. The automated installer test refuses an existing installation
and uses its own temporary paths, then verifies removal of its installation,
registration and shortcuts.

## Updates and diagnostics

yt-dlp updates require separate explicit user actions. Checks and downloads use
official stable release endpoints, strict redirects, bounded streams, SHA-256
verification and an actual executable version probe. Activation atomically changes
an app-owned pointer; bundled binaries are unchanged. Shared process leases and an
exclusive update lease prevent replacing a running tool. Failed checks, cancellation
or invalid bytes preserve the prior working binary. Explicit checks re-read the
actual executable version so a deleted/quarantined override can be reinstalled.
A corrupted still-present immutable target is rejected rather than overwritten;
see the setup guide for deliberate repair. FFmpeg and ffprobe display their bundled
version/source and do not auto-update.

App updates default to **Update service not configured**. The immutable
`resources/update-provider.json` can enable a public GitHub provider with an expected
Windows publisher; such builds require signing. Check, Download and Install are
separate operations. Installation drains work and exits; it does not promise an
automatic relaunch. The adapter disables background download/install, prereleases,
downgrades, differential downloads and web installers. Metadata is capped at 2 MiB;
installer bytes are capped at the manifest size, with a 2 GiB ceiling. SHA-512 and
strict Authenticode publisher verification run before acceptance and again before
installation. Unavailable/malformed PowerShell verification fails closed. No token
or private release provider is supported. No publishing command ran.

Diagnostics shows real app/runtime/platform/schema/paths, tool versions, connection
and session state, active job counts, and available disk space. Display-only paths
are omitted from export. The log viewer filters, copies a selected sanitized entry,
opens its folder and clears logs. Export uses a native save picker and creates a new
JSON file from an explicit allowlist. It excludes media, titles, account details,
paths, URLs, OAuth credentials/codes, cookies and resumable sessions. It includes
aggregate counts for every download/upload status without individual job records. Logs use a
closed vocabulary, five files of at most 1 MiB and at most 128 pending appends; reads
return at most 200 entries. Export cleanup preserves any replacement file.

## Security review summary

Remote browser pages remain sandboxed without Node or an application preload.
Main validates the shell sender, main frame, origin and typed arguments for narrow
IPC capabilities; native pickers approve filesystem choices. Production CSP and
the controlled media protocol remain in force. OAuth uses PKCE/state and a loopback
callback; tokens and encrypted resumable sessions remain in Main/OS-backed storage.
Subprocesses use argument arrays with no shell. Cleanup rejects redirected paths
and preserves user media. Shutdown blocks new work and drains jobs, tool probes,
cookie operations and updates before database closure. Review corrections include
exact Windows file identities, export replacement protection and bounded update
response streams. The [security review](final-security-review.md) records evidence,
performance constraints and the limits of this source review.

## Dependencies, scripts and changed files

New dependencies: production `electron-updater@6.8.9`; development
`electron-builder@26.15.3`. Supported Node minimum is `22.12.0`; this machine used
Node `22.23.3`. Electron `44.6.0` embeds Node `24.21.0`. Tool pins are yt-dlp
`2026.08.19`, FFmpeg/ffprobe `9.0.2` Gyan essentials, and better-sqlite3 `13.0.3`.

New scripts: `package:dir`, `package:win`, `test:packaging`, `test:packaged`,
`test:installer`, `fixtures:generate`, `fixtures:serve`, and `test:fixtures`.
`test:desktop` and the explicitly interactive `test:drive:manual` are extended.
All package commands use `--publish never`.

The [complete changed-file inventory](final-changed-files.txt) lists 161 files
relative to task-start commit `5417666`, including new source, tests, documentation,
branding and notices. Generated build/test artifacts are ignored. Changes include:

- `electron/main.ts`, product/lifecycle/tray/login services and startup path guards.
- Browser cookie bridge/metadata; download publication, process classification,
  queue drain/recovery; Drive transport and queue/coordinator recovery.
- Database backup/recovery/v3, repository fingerprint support, Library sampling,
  Storage Manager and settings guards.
- Binary leases/updater/store/official HTTP; configured app update adapter, bounded
  HTTP/signature verification; diagnostics/logger and narrow IPC handlers.
- `shared/` DTOs, preload, Settings components/hooks, first-run wizard, AppShell,
  styles, EN/VI dictionaries and corresponding tests.
- Builder/staging/install/smoke/fixture/manual-Drive scripts, branding, notices,
  package manifests and final setup/test/audit documentation.

## Verification evidence

| Gate    | Evidence obtained                                                                                                                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A       | 347 tests; typecheck/lint/build; actual onboarding/tray/background/relaunch smoke                                                                                                                                                      |
| B       | 450 tests; typecheck/lint/build; actual local HttpOnly authentication, MP4/HLS, recovery and storage smoke                                                                                                                             |
| C       | Actual packaged executable and native tools in space/Vietnamese/Japanese paths; actual per-user 0.1.0 install, startup ON/OFF, 0.1.1 upgrade and uninstall with data hashes preserved                                                  |
| D       | 597 tests in 72 files; 11 binary setup tests; seven staging tests; typecheck/lint/web+desktop build/package; full desktop and packaged workflow                                                                                        |
| E final | 602 tests in 74 files; 11 binary setup, seven packaging and eight real fixture tests; typecheck/lint/build; full desktop and packaged smoke; fresh 0.1.0/0.1.1 NSIS builds and actual install/upgrade/uninstall; audit and diff checks |

Evidence is under `artifacts/milestone-{a,b,c,d}/` and `artifacts/final/`. Native D
tests activate and restart a real yt-dlp executable using locally simulated release
responses. Native signature tests accept a Microsoft-signed system executable and
reject a wrong publisher and the unsigned local installer. Packaged smoke loads
SQLite and the updater provider from the package with a restricted PATH, exercises
the real browser/download/Library/diagnostic workflow, and verifies install files
remain unchanged. This does not claim a live signed-release update was installed.

Final evidence under `artifacts/final/`:

| Check                                            | Result / evidence                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck and Vitest                             | Passed; `typecheck.log`, `tests.log` (602 tests / 74 files)                                                                                                               |
| ESLint                                           | Zero errors, seven existing Fast Refresh warnings; `lint.log`                                                                                                             |
| Binary setup / package staging / fixture helpers | 11 / 7 / 8 passed, zero skips; `binary-setup.log`, `packaging-tests.log`, `fixtures.log`                                                                                  |
| Web and desktop builds                           | Passed; `build.log`; existing large-chunk warning remains                                                                                                                 |
| Actual development Electron workflow             | Passed; `desktop-smoke.log`                                                                                                                                               |
| Actual packaged workflow                         | Passed; `packaged-smoke.log`, `packaged-runtime.json`, `packaged-result.json`; all 383 installation files unchanged                                                       |
| Actual per-user install → upgrade → uninstall    | Passed; `installer-smoke.log`, `installer-result.json`; startup ON/OFF, native SQLite, settings/media preservation, upgraded maintenance/diagnostics and cleanup verified |
| Final unpacked output                            | Restored to 0.1.0; Main/preload match final build and all three binaries match pinned hashes; `restored-package-verification.json`                                        |
| Process cleanup                                  | Zero owned application/tool processes; `process-audit.json`                                                                                                               |
| Migration compatibility                          | Original two migrations unchanged, v3 added; `migration-verification.json`                                                                                                |
| Formatting and whitespace                        | Final documents formatted; `git diff --check` passed; `diff-check.log`                                                                                                    |

The local 0.1.0 installer is **186,864,705 bytes**, unsigned, with SHA-256:

```text
0ccb1cd34c8c8ef6ff6a7ec60610ba320cb09e44b8240bcd978ccbd139a38bcd
```

`installer-artifacts.json` records both installer hashes, sizes and unsigned status.
An initial final packaging attempt encountered `EPERM` while renaming its staging
resources directory. No owned process remained; an unchanged retry succeeded,
as did the subsequent upgrade and unpacked builds. The failed attempt is retained
in `package-win-attempt-1.log`; its exact external cause was not established.

## Dependency review

The final audit reports **8 moderate, 0 high, 0 critical** findings, all
propagated from one advisory: unbounded precision format strings in
`sprintf-js@1.1.3`. Its path is builder → app-builder-lib → @electron/get 3.1 →
global-agent → roarr → sprintf-js; dmg-builder and Squirrel add propagation entries.
The advisory lists no patched version. [GitHub advisory GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).

`npm audit --omit=dev` reports zero findings. Inspection of all 19 staged runtime
package manifests found none of the eight affected packages. Installed global-agent
calls use constant format messages with network details in structured fields; no
attacker-controlled format-string route was identified in that build path. This is
a limited source review, not proof that development tooling is invulnerable.

No forced audit fix was applied: npm suggests downgrading the tested builder to
26.5.0, and overriding its downloader/proxy packages would cross major/module-format
boundaries. Retain the advisory for follow-up when a compatible upstream fix exists.
Raw audit JSON (`npm-audit.json`, `npm-audit-production.json`) and runtime exposure
evidence are in `artifacts/final/`. The full audit exits 1 for the documented moderate
findings; the production-only audit exits 0.

## Manual handoff and limitations

Use [the setup guide](final-setup-and-test.md) for exact PowerShell setup, Google
Cloud Desktop client configuration, signing and install commands, then run
[the E2E checklist](final-e2e-checklist.md). The [security review](final-security-review.md)
records boundary checks and remaining constraints.

- Real Google authorization, quota, uploads (including a large upload), auto-upload
  and deletion policies require the user's test account. Run `npm run
test:drive:manual` only in an interactive terminal after client configuration.
  Use generated disposable files for deletion-policy tests.
- A fresh Windows machine, physical reboot/login startup, and a live signed public
  app-update feed remain manual checks. Local installer builds are unsigned.
- Windows x64 is the supported package. Output folders need hard-link support;
  extremely long user-selected base paths may still exceed external tool limits.
- Library/download snapshots contain complete collections, and explicit storage
  scans are linear in the selected tree. Extreme-library and long-running memory
  benchmarks remain unperformed.
- The browser supports authorized non-DRM media. Site-specific yt-dlp support,
  external JavaScript runtime requirements and protected streams remain upstream
  constraints; there is no DRM bypass.
- Bundled binary notices and exact source references are included, but complete
  corresponding source for the standalone combined executables has not been
  verified. [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) explains what remains
  before public redistribution. This task produced local test installers only.
- An earlier automatic approval review rejected deletion of an inactive failed-test
  package copy with “blocked by policy.” It remains at
  `C:\Users\tai\AppData\Local\Temp\mediavault-package-GZE1Pi`; the rejection was not
  bypassed. That retained copy is unrelated to the final installer.
