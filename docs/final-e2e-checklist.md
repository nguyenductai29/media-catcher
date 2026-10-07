# MediaVault final E2E checklist

Use the [setup guide](final-setup-and-test.md) and generated fixtures. Test deletion
only on disposable generated files. **Do not select, overwrite or delete personal
media.** Keep the same isolated profile when testing recovery or upgrade.

Unchecked boxes below are a worksheet for a new run, not failed tests. Check a box
only after observing the stated result; record N/A with a reason for an unsupported
site/codec or unconfigured signed provider. Automated coverage does not prove real
Google behavior, Windows reboot login or fresh-machine installation.

## Run record

| Field                                          | Value |
| ---------------------------------------------- | ----- |
| Tester / date                                  |       |
| Commit / app version                           |       |
| Windows edition / build / architecture         |       |
| Installed, unpacked or development executable  |       |
| Isolated profile / generated fixture directory |       |
| Download filesystem / free space               |       |
| Language(s) / theme(s)                         |       |
| Google test account used (record privately)    |       |
| Results / evidence location                    |       |

Do not include OAuth codes, client credentials, tokens, cookies, authorization
headers or resumable/signed URLs in the record. The Diagnostics page displays local
paths; review screenshots before sharing. Diagnostic JSON exports omit those paths.

## Existing automated evidence

These are completed milestone runs on the development Windows host, not a claim
that the manual worksheet has been performed:

- [x] Milestone B actual HttpOnly local login → authenticated analysis/download,
      session-loss safe failure and reauthorization, no leaked cookie data, cleanup.
      Evidence: `artifacts/milestone-b/desktop-smoke-production.log`.
- [x] Milestone C actual NSIS 0.1.0 → 0.1.1 upgrade/uninstall with native SQLite,
      retained profile/Library/settings/media, Unicode/space installation paths and
      startup ON/OFF registration/argument readback. Evidence:
      `artifacts/milestone-c/installer-result.json` and
      `artifacts/milestone-c/installer-smoke-production.log`.
- [x] Milestone D 597 tests/72 files, typecheck, lint, binary setup/packaging tests,
      web/desktop build and Windows package build passed. Actual development and
      packaged smoke covered local MP4/HLS/auth, Library, diagnostics/native export,
      sanitized logs and default unconfigured update controls. Evidence:
      `artifacts/milestone-d/desktop-smoke-production.log` and
      `artifacts/milestone-d/packaged-smoke-production.log`.
- [x] Native signature validation accepted a signed Windows executable, rejected a
      different publisher and rejected the unsigned local MediaVault installer.
      This does not verify a signed MediaVault release/update feed.
- [x] Final E verification: 602 tests/74 files, 11 binary setup, seven packaging and
      eight fixture tests; typecheck/lint/build; actual desktop and packaged smoke;
      newly built 0.1.0/0.1.1 NSIS install/upgrade/uninstall passed. All 383 packaged
      installation files remained unchanged, and installed upgrade diagnostics,
      startup registration and data/media preservation passed. See `artifacts/final/`
      and [the final report](final-phase-report.md) for logs, hashes and limitations.

Run all final commands again for the final commit; use their actual results rather
than carrying forward old test counts.

## Installation and onboarding — manual fresh-machine check

- [ ] Install on a fresh Windows x64 machine/account without a development toolchain.
- [ ] Launch the actual installed executable/shortcut, without `electron .` or a dev server.
- [ ] Confirm bundled yt-dlp/FFmpeg/ffprobe work without PATH-installed tools.
- [ ] Confirm Library/database operations load the packaged `win32-x64.node` prebuild.
- [ ] Complete all six onboarding steps, including a native-picked test download folder.
- [ ] Switch EN/VI during onboarding; skip optional Drive connection successfully.
- [ ] Finish, exit/reopen, and verify choices persist without showing onboarding again.
- [ ] Upgrade an established profile and verify onboarding does not appear unexpectedly.
- [ ] Check language, dark/light/system theme and app version in Settings.
- [ ] Confirm close-to-tray default and startup OFF default.
- [ ] Enable startup in the installed build and verify Windows Startup Apps/native setting.
- [ ] **Sign out/in or reboot Windows**; verify the installed app starts correctly with
      the intended profile and persistent Google client configuration.
- [ ] Disable startup; repeat login/reboot and verify it no longer starts automatically.
- [ ] Verify development Electron cannot register itself for startup.

## Window, tray and background work

- [ ] Minimize/maximize/restore/close work; window/scroll/sidebar layout remains intact.
- [ ] Close-to-tray hides the window while a generated download continues.
- [ ] With a real test upload active, close-to-tray continues uploading.
- [ ] Restore through tray; Open, Downloads and Settings navigate correctly.
- [ ] Tray Pause/Resume downloads and uploads affect the intended queues.
- [ ] Tray tooltip reports active counts without private URLs or file contents.
- [ ] Explicit Exit with active work offers the localized download/upload confirmation.
- [ ] Cancel Exit leaves work/app running; confirm Exit stops workers and terminates.
- [ ] Reopen and recover unfinished work paused; no unexpected auto-resume.
- [ ] With close behavior Exit selected, titlebar Close follows that choice.
- [ ] Settings Exit remains usable if the tray is unavailable.

## Browser and sessions

- [ ] Open a normal permitted HTTP(S) website; use back/forward/reload/stop/home.
- [ ] Address/title/loading/error state follows the real page.
- [ ] Sidebar collapse, detected panel toggle, resize/maximize and route changes resize
      or hide the native view correctly.
- [ ] Dialogs/onboarding appear above the browser; closing them restores its bounds.
- [ ] Login to the local fixture in MediaVault; an unrelated external browser session
      does not authenticate it.
- [ ] Save session ON retains the test login across app restart.
- [ ] Save session OFF uses a temporary session; restart does not retain that login.
- [ ] Clear cookies invalidates the test login; clear data also clears persisted browser
      data even when the current view uses a temporary session.
- [ ] HTTP(S) popups follow the embedded-browser rule; blocked schemes/site downloads
      and unsolicited device permissions do not gain native access.

## Detection and formats

- [ ] Detect the generated direct MP4 and HTML5 video page.
- [ ] Detect/download the generated HLS playlist; segments do not flood the media panel.
- [ ] Test optional generated DASH where extractor/codec support permits it; record result.
- [ ] Scan real formats; errors do not produce fake successful media or queue entries.
- [ ] Confirm repeated requests deduplicate and page navigation resets current candidates.
- [ ] DRM/encrypted unsupported media produces a clear refusal; no bypass is offered.

## Downloads and recovery

- [ ] Download a public generated video; validate playable output and Library auto-add.
- [ ] Test an authorized public real-world source you control; record extractor support.
- [ ] Scan protected local media before login and observe safe authentication failure.
- [ ] Visit `/login`, then scan/download `/protected-video` through the cookie bridge.
- [ ] Clear the browser session during a paused authenticated job; Resume fails safely,
      then succeeds after re-login without exposing cookies.
- [ ] Verify actual 1080p from a source that provides it; no upscaling is implied.
- [ ] Test audio-only output in its original audio container.
- [ ] Test MP4 and MKV; source metadata remains accurate after merge/remux.
- [ ] Inspect estimated filename and final sanitized filename, including duplicate titles.
- [ ] Test concurrency settings and accurate progress/size/speed/status.
- [ ] Pause/resume a larger throttled fixture; no orphan yt-dlp/FFmpeg process remains.
- [ ] Cancel, then Retry; useful partials are retained and success is committed once.
- [ ] Use fixture terminal `offline`/`online` and `interrupt`/`normal`; recover safely.
- [ ] **Disconnect/reconnect the actual network** during an authorized remote download.
- [ ] Exit/restart with incomplete work, then explicitly Resume the same jobs.
- [ ] Test low-space/invalid destination failure in an isolated controlled environment;
      no completed-looking partial output or overwritten existing file appears.
- [ ] Unsupported hard-link destination fails before transfer with a localized error.
- [ ] Open Folder is unavailable until a completed output path exists.

## Library

- [ ] Completed validated downloads auto-add once, with thumbnail and metadata.
- [ ] Import a generated file with the native picker; the file is referenced, not moved.
- [ ] Import a generated folder non-recursively, then recursively; search/sort/grid/list work.
- [ ] Play local media and seek through the restricted local protocol.
- [ ] Open Folder reveals the expected selected/generated file.
- [ ] Remove from Library leaves the underlying file intact.
- [ ] Delete Local File asks; Cancel preserves it and Confirm deletes only the chosen fixture.
- [ ] Enable sampled duplicate detection and import copies; verify duplicate handling.
      Disable it again; do not interpret the sample as a full integrity hash.
- [ ] Move/remove a generated file externally; refresh shows File missing and disables
      local play/reveal without falsely showing Drive Only.
- [ ] A changed local file does not silently replace an already verified cloud version.

## Google Drive — manual real-account checks

- [ ] Configure Desktop OAuth ID at runtime; test installed shortcut/startup after fresh login.
- [ ] Connect through the system browser; verify test-account identity, real quota and root folder.
- [ ] Cancel authorization once; no false connected state or retained partial grant appears.
- [ ] Upload a small generated file manually; inspect the actual Drive file and size.
- [ ] Upload a larger generated file; progress remains below 100% until finalization commits.
- [ ] Change upload concurrency 1–3 and confirm the setting persists.
- [ ] Pause/resume mid-upload; Google-confirmed bytes and local file integrity are checked.
- [ ] Cancel/retry without deleting local/remote files unexpectedly.
- [ ] Exit/restart during upload; resume the same profile and verify no duplicate remote file.
- [ ] Interrupt the network during upload/finalization; reconnect and reconcile safely.
- [ ] Enable auto-upload, download a new generated video and verify upload follows local commit.
- [ ] Confirm Local + Drive state only after verified cloud completion.
- [ ] Confirm Drive Only state after an authorized local deletion; local play/reveal stay disabled.
- [ ] Open the Drive result in the system browser and inspect its contents.
- [ ] Sync refreshes quota/known records without scanning all unrelated Drive contents.
- [ ] Disconnect/reconnect the same account and verify recovery.
- [ ] Connect a different test account; previous-account items are marked appropriately
      and unfinished jobs cannot silently resume into the new account.
- [ ] Restore auto-upload OFF and disconnect when finished.

## Local deletion safety — generated fixtures only

- [ ] **Never:** verified upload leaves the local fixture intact.
- [ ] **Ask:** reject the native prompt and verify the file remains.
- [ ] **Ask:** accept for a separate disposable fixture after checking its Drive copy.
- [ ] **Automatically:** use a separate disposable fixture; deletion follows independent
      remote verification/size and database commit, never just a progress percentage.
- [ ] Changed/missing local file, changed account, failed metadata verification or cancelled
      upload never authorizes automatic deletion.
- [ ] Restore policy to Never. Remove only generated cloud copies manually if desired.

## Storage and database recovery

- [ ] Inspect all five Storage sizes and toggle sampled duplicate detection.
- [ ] Clean stale Temp, old logs and unused thumbnails; selected media, referenced
      thumbnails and persisted paused-job partials remain.
- [ ] Upgrade an isolated old-schema profile and verify a validated backup and schema v3.
- [ ] On a disposable copy only, exercise corrupt-DB recovery: Open folder and Exit
      preserve the original; explicit Restore retains DB/WAL/SHM evidence in quarantine.
- [ ] With no valid backup, no automatic empty database replaces broken data.

## Maintenance, diagnostics and localization

- [ ] EN and VI cover browser/download/tool/DB/Drive/OAuth/network/cookie/startup/update/
      storage/diagnostics errors; normal UI never displays a raw stack trace.
- [ ] Binaries shows yt-dlp/FFmpeg/ffprobe versions and FFmpeg source.
- [ ] Explicit yt-dlp Check reports current/latest; Update verifies and activates an override.
- [ ] An active analysis/download prevents replacement; cached busy state can be refreshed.
- [ ] A missing/invalid override falls back safely. Check/Update repairs an absent
      override; a corrupt immutable executable still present requires explicit
      quarantine of that identified EXE while the app is fully exited (see guide).
- [ ] Default app updates are visibly unconfigured, with no fake check/download success.
- [ ] **Signed release environment only:** Check → Download → Install update and exit;
      pinned valid publisher required, data preserved, no automatic check/install/restart.
- [ ] Reject unsigned/wrong-publisher/checksum/oversized/stalled update responses safely.
- [ ] Diagnostics fields match installed versions, schema, paths, counts, session and account state.
- [ ] Filter logs by component/kind; select/copy only sanitized entries, open folder and clear.
- [ ] Cancel diagnostic export with no output/success message; save a real JSON export.
- [ ] Inspect export for expected safe metadata and absence of media/tokens/cookies/auth
      files/authorization headers/OAuth codes/client credentials/resumable or signed URLs,
      local paths and raw job records; aggregate job-status counts are present.
- [ ] Confirm bounded log rotation and a responsive UI while work is active.

## Cookie privacy and process boundaries

- [ ] Browser cookie values never appear in renderer DTOs, SQLite job rows, activity or logs.
- [ ] Owned `browser-cookie-temp` is empty after success, failure, cancellation and exit.
- [ ] A stale owned cookie jar in an isolated profile is cleaned on next startup.
- [ ] Diagnostic export excludes cookie jars and credentials completely.
- [ ] Remote content has no Node, filesystem, shell, child-process or unrestricted IPC access.
- [ ] Renderer IPC exposes only typed narrow methods; file paths come through approved
      native selection, URLs/protocols are validated and CSP remains enabled.
- [ ] Large downloads/uploads stream, thumbnails/scans are bounded, progress updates
      remain responsive and shutdown leaves no owned worker process running.

## Upgrade and uninstall — manual repetition

- [ ] Install baseline 0.1.0 in the dedicated clean test environment.
- [ ] Import generated media, save language/theme/download/Drive preferences and note IDs.
- [ ] Install 0.1.1 over it using the guide's quoted extraMetadata build argument.
- [ ] Verify version changed and database schema/Library IDs/preferences/media survived.
- [ ] Verify no unexpected wizard, new cloud upload or auto-resume occurs.
- [ ] Exercise paths with spaces, Vietnamese and Japanese characters; keep practical lengths.
- [ ] Disable startup, disconnect Drive and exit before manual uninstall.
- [ ] Uninstall through the owned uninstaller/Windows Installed apps.
- [ ] Verify executable/owned shortcuts/registration are removed but profile/database/media remain.
- [ ] Do not manually delete registry entries or unrelated installed applications.

## Final verification and release limitations

- [ ] Run and record typecheck, lint, tests, binary setup tests, packaging tests, fixture
      tests, web/desktop build, real desktop smoke and real packaged smoke.
- [ ] Build NSIS successfully; record installer path/version/hash and actual launch evidence.
- [ ] Run installer smoke only when its clean-account preflight passes.
- [ ] Run `npm audit` and `npm audit --omit=dev`; review production reachability instead
      of applying blind breaking upgrades. Run `git diff --check`.
- [ ] Keep real Google, reboot, fresh-machine and signed-feed results explicitly manual
      until actually performed; never infer them from credential-free CI.
- [ ] Resolve signing/public-feed configuration and GPL corresponding-source gaps in
      [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) before public distribution.
- [ ] Record remaining codec/site/DRM and out-of-scope Drive limitations honestly.
- [ ] Preserve personal data; clean up only positively identified generated test assets.
