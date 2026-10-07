# Final Windows product phase

The user's supplied final-phase specification authorizes implementation and fixes.
Preserve the Phase 1–3 architecture and complete milestones in order. No publishing,
history rewriting, real Google authorization or real user-media tests are implied.

## Design

Keep Main as owner of jobs, cookies, credentials, files, native lifecycle and updates.
Extend SettingsRepository, narrow Result-based IPC and the existing shell/routes.
Hide the existing window for background work; explicit Exit drains services. Build
NSIS per-user x64 with app/binaries in resources and mutable data under userData.
Use local generated media and isolated profiles for both dev and packaged evidence.
The existing cyan terminal/play brand supplies deterministic SVG/PNG/ICO assets.

## A — Productization (verified)

Files: product-settings-service, tray-controller, desktop-lifecycle and tests;
main/preload/IPC/shared contracts; AppShell, Settings, first-run wizard, locales;
branding sources and desktop smoke.

- [x] ProductSettings persists closeBehavior tray/exit (tray), theme dark/light/system
      (dark), startup intent (off) and firstLaunchCompleted. Runtime get reports actual
      OS startup and tray availability. Only packaged Windows may register startup.
- [x] Existing configured users skip onboarding. New users choose language, approved
      download folder, best/1080/720 quality, MP4/MKV/original, optional Drive and background
      preferences. Mark complete only after settings writes succeed.
- [x] Tray commands open/navigate, pause/resume both queues and explicit Exit.
      Close hides only when a live tray exists; fallback retains active-work confirmation.
      Window hidden/minimized never owns or stops a worker. Second launch reopens it.
- [x] Stable com.mediavault.desktop identity, package version, MediaVault branding.
- [x] Verify typecheck, lint, all tests, build and credential-free Electron smoke.

Gate evidence: 347 tests / 42 files, typecheck, lint, web+desktop builds passed.
`artifacts/milestone-a/desktop-smoke-production.log`: real Electron smoke passed
onboarding, hidden tray transfer progress, native reopen, explicit Exit and recovery.

## B — Reliability and authenticated downloads (verified)

Files: cookie bridge and tests, browser manager/session, yt-dlp/worker/queue, DB
backup/recovery, storage service and fingerprint helper, strict IPC/settings UI.

- [x] Export only relevant MediaVault-session cookies to unique app-owned Netscape
      files just in time; no external browsers, renderer cookie values or persisted
      cookie content. Scope domain/path/secure attributes, preserve HttpOnly format.
- [x] Deterministic auth-only analysis fallback, current-page downloads, cleanup on
      every outcome/shutdown/startup; persist requiresBrowserSession/domain only if needed.
- [x] Offline transfers pause with networkUnavailable and require user Resume.
      Review partial/processing and Drive finalization recovery without duplicate outputs.
- [x] Consistent pre-migration SQLite backups (bounded retention); corruption dialog
      offers data folder/explicit restore/exit and never overwrites broken data silently.
- [x] Storage sizes and safe cleanup of stale unreferenced staging, old logs and
      unused thumbnails. Never clean selected user-media paths or resumable job data.
- [x] Optional sampled duplicate fingerprint, bounded to three 1 MiB reads.
- [x] Add only required v3 columns; preserve original v1/v2 SQL.
- [x] Run all tests/build/smoke including cookie-auth local fixture before C.

Gate evidence: 450 tests / 51 files, typecheck, lint, web+desktop builds passed.
`artifacts/milestone-b/desktop-smoke-production.log` records actual HttpOnly login,
public-to-auth analysis retry, authenticated download, session-loss safe pause,
reauthentication/resume, secret-boundary checks and cookie cleanup, plus storage
cleanup and all previous smoke coverage. Publication journals now cover crashes
before/after cross-volume copies and final links, using exact Windows file IDs.
Downloads preflight hard-link support (NTFS on Windows) before transferring bytes.

## C — Packaging and installer (verified)

Files: package.json/lock, electron-builder configuration, packaging scripts,
third-party notices and packaged smoke.

- [x] Add electron-builder; NSIS per-user x64, asar and native SQLite unpacking,
      branded executable/installer, bundled yt-dlp/FFmpeg/ffprobe. Narrow packaged files.
- [x] Keep mutable state outside installation, preserve data on uninstall/upgrade.
      No automatic release publishing. Unsigned local builds allowed; signing documented.
- [x] Bundle notices/source references appropriate to actual binary builds.
- [x] Build installer and exercise unpacked executable with SQLite, actual binaries,
      Browser/MP4/HLS/Library in paths with spaces, Vietnamese and Japanese characters.
- [x] Verify upgrade preservation; provide explicit installed NSIS/uninstall steps
      if unattended installer testing is unsuitable for the user's machine.

Packaged smoke passed with actual SQLite and bundled tools, a restricted PATH and
spaces/Vietnamese/Japanese install and data paths; all copied installation files
remained unchanged. The actual NSIS test then exposed two Windows startup issues:
the Run value name must match the AppUserModelId, and Electron 44 requires a quoted
executable path for login-item lookup. `windows-login-item` now handles both while
leaving setter arguments raw for Electron's native quoting. Twenty-five focused
product/login tests passed; a native registry/CommandLineToArgvW experiment also
passed and restored the prior empty startup state. Both installers were rebuilt;
`artifacts/milestone-c/installer-result.json` records the passing actual per-user
0.1.0 install, startup ON/OFF, 0.1.1 upgrade and uninstall with profile/media hashes
preserved, owned registration/shortcuts removed, and no process left running.

## D — Maintenance, updates and diagnostics (verified)

Files: binary updater, app update service, diagnostics/log/storage IPC/UI and tests.

- [x] User-triggered official yt-dlp release check/download, checksum validation,
      atomic app-owned override, binary-use lock and rollback; never replace a running tool.
- [x] FFmpeg source/version display; app update flow only enabled with configured
      public release provider, honest unconfigured state otherwise. No publishing.
- [x] Diagnostics version/platform/schema/paths/jobs/disk/session/account state,
      bounded sanitized logs/filter/copy/open/clear and JSON export allowlist (no media,
      credentials, cookies, sessions or raw URLs). Bounded rotation.
- [x] All errors localized EN/VI; all mutations narrow trusted IPC and native pickers.
- [x] Run all tests/build/desktop and packaged verification after runtime changes.

The actual desktop smoke passed with local authenticated MP4/HLS, real diagnostics
and native save-dialog export, filtered log copy/clear, privacy checks and honest
unconfigured app update controls (`artifacts/milestone-d/desktop-smoke-production.log`).
Review added regressions for filtered log lookup, bounded pending log writes, exact
Windows file IDs, export cleanup preserving a replacement file, and repairing a
deleted yt-dlp override. The configured app adapter now caps actual response bytes
and validates Authenticode fail-closed. Native checks accepted a signed Windows
executable and rejected a wrong publisher and the unsigned local installer. Abort
drains verifier cleanup and destroys the installer stream before releasing busy state.

Final D gate: 597 tests in 72 files; typecheck; lint (seven existing Fast Refresh
warnings); 11 binary setup and seven packaging tests; web/desktop build and actual
Windows package build all passed. `artifacts/milestone-d/packaged-smoke-production.log`
records the full packaged workflow, including the staged updater dependency and
GitHub provider, Unicode/space paths, restricted PATH and unchanged install files.

## E — Final setup, review and evidence (verified)

- [x] Generated 10/60-second MP4 and HLS fixtures, range/auth/interruption server,
      enhanced manual Drive helper; no copyrighted or personal media used in tests.
- [x] docs/final-setup-and-test.md, final-e2e-checklist.md and final-phase report:
      exact PowerShell setup/Google client/build/install/upgrade/uninstall instructions.
- [x] Audit IPC, CSP, remote isolation, paths, cookies, diagnostic secrecy, shutdown,
      bounded streams/scans/events/logs and package paths. Resolve concrete findings.
- [x] Run npm audit; fix high-confidence issues and explain remaining production risk.
- [x] Final commands: typecheck, lint, test, test:binary-setup, build, test:desktop,
      packaged smoke, builder/installer, audit, diff --check. Record actual evidence and
      distinguish unattended tests from manual Google/OS reboot/install checks.

Final E evidence: 602 tests in 74 files, 11 binary setup tests, seven packaging
tests, eight fixture tests (including real FFmpeg generation/probing), typecheck,
lint (zero errors/seven existing warnings), web/desktop builds, actual desktop and
packaged smoke all passed. Both NSIS versions were rebuilt; the real isolated
0.1.0 install → startup ON/OFF → 0.1.1 upgrade → uninstall test preserved settings,
Library, database and generated media. The unpacked build was restored to 0.1.0
and its final bundles/binary hashes verified. No owned application/tool process
remained. Evidence is under `artifacts/final/`; the phase report records hashes and
the full 161-file inventory. Final audit: zero production findings, eight moderate
development-chain reports from one unpatched advisory; no forced downgrade applied.
Real Google, a fresh Windows machine, physical reboot and a signed public update
feed remain manual acceptance checks, with exact setup/helper/checklist handoff.
