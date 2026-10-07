# MediaVault final security and reliability review

Reviewed on 2026-10-07 for the Windows x64 desktop build. This is a source review
with targeted regression tests and local integration evidence, not an external
penetration test or a guarantee against all defects. The application version is
`0.1.0`; the installer acceptance also uses a deliberate `0.1.1` upgrade build.

The review covers the current Main/preload/IPC boundary, browser session and cookie
bridge, Google auth/Drive upload lifecycle, media protocols, file publication and
cleanup, database recovery, diagnostics, updates, renderer DTOs, and relevant
performance limits. The [final phase report](final-phase-report.md) records the
complete final gate results; do not infer a final build result from a focused test.

## Trust boundaries and privacy

| Boundary                        | Reviewed behavior and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote page → application       | The remote `WebContentsView` has no preload, Node integration, or `mediaVault` bridge. Context isolation, sandbox and web security are enabled. Navigation accepts HTTP(S), rejects credentials/invalid schemes, and manages popups in the same view. Automatic page downloads and device permissions are denied. Browser tests and actual desktop/packaged smoke exercise this separation.                                                                       |
| Shell renderer → Main           | Preload exposes named capabilities and removable subscriptions, never a generic IPC method. Main checks the exact shell `webContents`, its main frame, and the expected production/development origin before dispatch. Inputs use bounded IDs, enums, booleans and object schemas. Renderer-provided media IDs resolve to Main-owned candidates/records; native dialogs approve filesystem choices.                                                               |
| Shell content and media         | Production CSP restricts scripts to the application origin, disallows frames/objects, and limits media to the controlled protocol. The development inline-script exception only applies while Vite serves its React preamble. Media requests require the trusted initiator and a known record. File streaming uses bounded buffers and explicit single-range 206/416 responses; actual player and Range checks passed.                                            |
| Browser cookies → yt-dlp        | Only the MediaVault browser session is consulted. Chromium cookie metadata is cross-checked against Electron cookies; partitioned/ambiguous cookies are refused. Cookie scope, security, expiry and current-page generation are checked. Public analysis runs first; one authentication-required retry may obtain scoped cookies. No other browser profile is read.                                                                                               |
| Temporary cookie material       | Unique exclusive jars are written in the owned profile directory immediately around subprocess work. Abort/session changes wait for child termination before cleanup, and startup removes owned stale jars. Values and jar paths do not enter renderer DTOs, SQLite job records, logs or diagnostic exports. Real HttpOnly local-fixture tests cover analysis, download, clear-session interruption, reauthentication and cleanup.                                |
| Google authentication           | System-browser OAuth uses PKCE and random state with a bounded loopback callback on `127.0.0.1`. Callback method/host/path/state are checked. Scope is `drive.file` plus account identity scopes. Access tokens stay in Main memory; refresh credentials and resumable sessions use OS-backed `safeStorage` encryption with context binding and no plaintext fallback.                                                                                            |
| Account and Drive ownership     | Each request/worker rechecks its account. Session URLs are restricted to Google's resumable endpoint. Preallocated file IDs and encrypted session checkpoints are persisted before mutation; recovery reconciles those IDs instead of blindly creating another object. Completion verifies file ID, size, parent and MediaVault ownership properties. Public upload DTOs explicitly omit local worker paths, encrypted sessions and internal finalization fields. |
| Local deletion after upload     | Default policy is Never. Ask uses native confirmation; Always still requires verified remote ownership/completion and unchanged known local size/mtime. Media locks stop and drain upload users. Account disconnect, policy changes, cancellation and shutdown invalidate pending deletion work. Cloud records and thumbnails survive successful local deletion.                                                                                                  |
| Network and process diagnostics | Process stderr is retained only as a bounded in-memory tail and classified into safe error codes. Main does not return raw arguments, cookies, headers, URLs or stacks as errors. Application logs use a closed component/code/event vocabulary. Intentional UI metadata, such as the current URL, media title, local path and connected account name, remains available for normal product use.                                                                  |

The desktop does not load Lovable's editor reporting script. Its existing optional
reporting hooks have no receiver in the packaged shell. React renders page/media
titles as text; the reviewed Settings/Diagnostics consumers translate error codes
instead of displaying raw exception messages.

## Files, recovery and lifecycle

- Downloads use fixed argument arrays, `shell: false`, hidden child windows, disabled
  yt-dlp configuration/plugin discovery, explicit output templates and validated
  format selectors. The source URL follows `--`. FFmpeg/ffprobe local operations
  use the `file` protocol whitelist. DRM has no bypass path.
- Destination approval checks canonical paths against profile/application/resource
  and installation locations. Publication uses an exclusive final filename,
  verified staging journal and exact file identities. Interrupted copy/publication
  recovery does not overwrite a user's existing file. The target must support hard
  links; unsupported destinations fail before a large download.
- Library imports are limited to native-selected paths and supported regular files.
  Recursive import skips symlink directories and uses a bounded worker pool.
  Async metadata refresh merges newer cloud state and does not resurrect removed
  records. A missing cloud-backed local path releases its uniqueness key so later
  bytes at that pathname cannot become the old cloud item.
- Storage actions have fixed category roots and names. Stale cleanup preserves
  staging for every persisted resumable job, checks references again before unlink,
  ignores redirected paths, and leaves fresh thumbnails/logs alone. It is not a
  generic filesystem delete API and does not remove user media.
- SQLite uses prepared repositories, constrained schemas, immediate transactions,
  WAL and full synchronization. A pending migration of an established database
  creates a validated `VACUUM INTO` backup and retains three valid snapshots.
  Existing empty/damaged databases are not silently replaced. Native explicit
  recovery stages and validates a backup, quarantines DB/WAL/SHM, and attempts to
  restore originals if replacement fails.
- Persisted interrupted downloads/uploads recover paused or awaiting reconciliation;
  they do not silently resume transferring. Download completion commits Library,
  job and activity data together before automation sees the item.
- Close-to-tray keeps Main services alive. Explicit Exit holds queue scheduling,
  pauses/drains work, cancels OAuth/network/process operations, drains Library and
  storage, removes listeners, closes SQLite, flushes safe logs, then exits.
  Version-only child probes are now included in this drain. Native process-tree
  tests and desktop/packaged process audits check for orphaned tools.

## Diagnostics and update boundaries

Logs retain at most five 1 MiB files and 128 pending append operations. Reads are
bounded to those files and return at most 200 matching entries. Runtime parsing
discards unknown fields and malformed/oversized legacy lines. Exact BigInt file
identities prevent redirected/replaced log handles from being treated as owned.
Copy selects one sanitized record by its safe ID; it cannot copy arbitrary renderer
text. Clear only targets owned named logs.

Diagnostic export uses a native picker and creates a new `.json` file exclusively.
It reconstructs an allowlist of runtime/tool versions, safe settings, counts for
all eight download states and all eight upload states, and sanitized recent logs.
The counts come from private Main queue snapshots; unknown states fail before a
file is created. It excludes display-only paths, URLs, titles, account
identifiers, OAuth material, cookies, resumable sessions, media and database dumps.
It does not crawl the filesystem. Failure cleanup checks the exact created file
identity before unlinking. An unresolved native save picker cannot prevent shutdown
or trigger a late write after shutdown.

yt-dlp update checks/downloads require explicit actions and official stable release
endpoints. Redirects and streamed byte counts are bounded; SHA-256 and an actual
version probe precede immutable-file activation through an atomic pointer. Shared
process leases and an exclusive update lease prevent replacing an in-use tool.
The selected version is re-read rather than trusting stale cached UI state.
FFmpeg/ffprobe remain bundled tools with visible version/source information.

App updates are truthfully unconfigured in the default package. A configured public
GitHub provider must pin a Windows publisher. Background download/install,
prereleases, downgrades, differential downloads and web installers are disabled.
Metadata is limited to 2 MiB; installer streams are capped at the manifest size and
2 GiB ceiling. SHA-512, size and strict Authenticode publisher verification run
before acceptance and again before install. The constant PowerShell command uses
`-LiteralPath` and an environment-carried path, with no command interpolation.
Module loading uses fixed system module paths; unavailable verification fails
closed. Cancellation drains the verifier process tree before the operation clears.
Native tests accepted a Microsoft-signed system executable and rejected both a
wrong publisher and the unsigned local installer. A signed MediaVault release feed
was not exercised against the internet.

## Concrete findings corrected during this review cycle

| Finding                                                                                               | Correction and focused regression                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A selected filtered log older than the global newest 200 could not be copied.                         | Bounded ID lookup now precedes display truncation; regression covers 200 newer records from another component.                                                                                                                                                  |
| A burst of log writes could retain an unbounded promise queue despite disk rotation.                  | Pending append capacity is 128 with a drop policy; flood/drain tests verify bounded work.                                                                                                                                                                       |
| Failed export cleanup could unlink a replacement file; number-valued Windows file IDs lost precision. | Cleanup and log ownership use exact BigInt identities; replacement/precision-collision regressions preserve the replacement.                                                                                                                                    |
| yt-dlp's cached version could report an override that was deleted or quarantined.                     | Check/update probe the executable actually selected under the proper lease; deletion, quarantine and corruption regressions cover fallback.                                                                                                                     |
| Aborted app-update verification could finish its public promise before native verifier cleanup.       | Adapter tracks and drains the underlying action; deferred-cleanup regression covers shutdown/cancel.                                                                                                                                                            |
| Native signature verification failed for a valid signed executable in the restricted environment.     | Fixed system modules are explicitly loaded with autoload disabled; real signed, wrong-publisher and unsigned-executable tests pass.                                                                                                                             |
| Direct Settings version probes were outside Main's shutdown drain.                                    | `BinaryService.shutdown()` aborts/tracks those probes; Main awaits it. New tests hold both probe workers and tree-termination helpers open until shutdown proves it waits. The binary-focused group passed 13 tests.                                            |
| Drive chunk replacement checks compared large Windows file IDs as JavaScript numbers.                 | Handle/path identity and timestamps now use BigInt. Two regressions use distinct inode/device IDs that collide as numbers; both first failed, then passed. The Drive API/identity group passed 13 tests, including actual local chunk streaming and 401 replay. |

The last two changes also passed Electron typechecking and scoped ESLint. No
outstanding blocker was identified in the reviewed application boundaries after
these corrections. This statement does not replace the final aggregate build and
packaged acceptance gate recorded in the phase report.

## Performance and localized errors

Download progress and collection snapshots coalesce to 5 Hz; browser snapshots use
100 ms coalescing. Measured native-view geometry updates are scheduled through
`requestAnimationFrame`/`ResizeObserver`, with Main clamping accepted bounds to the
window. Upload streamed bytes update display snapshots while durable server offsets
are checkpointed separately. Streams use bounded buffers rather than whole-media
allocation. Probe output, HTTP response bodies, cookies, metadata formats, log
reads, retries and process timeouts all have explicit limits.

Database indexes cover queue status/order, media creation/path lookup, activity
ordering, Drive account/media/status lookup and local size/fingerprint lookup.
Optional duplicate detection samples at most the first, middle and last 1 MiB; it
does not hash an entire large video during import. Collection snapshots still
contain complete download/Library collections, and explicit storage/folder scans
are linear in the selected tree. No extreme-library or long-running memory
benchmark was performed; those are scaling constraints rather than measured
performance claims.

The static locale comparison found all **47 shared ErrorCode members** have
nonempty `desktop.errors` messages in EN and VI. Recursive locale key comparison
found identical **562 string keys** per language. Checked Settings/Maintenance/
Diagnostics consumers render localized codes. This does not claim a full manual
linguistic review of every sentence. Desktop smoke exercises EN/VI switching.

## Dependency and redistribution review

The coordinated `npm audit` run reported **8 moderate, 0 high and 0 critical**
findings, all propagated from `sprintf-js@1.1.3` in the development packaging chain.
The advisory identifies no patched version. See
[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).
`npm audit --omit=dev` reported zero findings, and all 19 staged runtime package
manifests were inspected: none of the eight reported packages is in that tree.
The affected builder chain uses constant format messages with network details in
structured fields; no attacker-controlled format-string path was found in that
limited review. No unverified downgrade/major override was applied.

Evidence: `artifacts/final/npm-audit.json`,
`npm-audit-production.json`, and `npm-audit-runtime-exposure.json`. A clean production
audit does not prove that native binaries or development tooling are vulnerability
free.

Bundled license texts, checksums, versions and pinned source references are recorded
in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) and
[`resources/notices/binaries.json`](../resources/notices/binaries.json). Complete
corresponding source for the standalone combined yt-dlp and Gyan FFmpeg builds has
**not** been verified; the manifest explicitly says so. Local test installers must
not be presented as verified public redistribution readiness on the strength of
homepage/source links alone. No public release was performed.

## Evidence boundaries and remaining manual checks

- Credential-free desktop/packaged smoke uses generated disposable MP4/HLS fixtures,
  real bundled tools, an isolated profile and real native SQLite. It covers browser
  isolation, session persistence/clearing, authenticated cookie use, download and
  Library workflows, process cleanup, onboarding/tray, storage, diagnostics and
  truthful disconnected Drive/update states. Evidence is in
  `artifacts/milestone-{a,b,c,d}/`; final reruns are recorded by the phase report.
- Actual local NSIS acceptance installed `0.1.0`, toggled startup registration,
  upgraded to `0.1.1`, and uninstalled while preserving profile/media hashes. A
  fresh Windows machine and physical reboot/login remain manual acceptance checks.
- Real Google consent, quota, long uploads, account switching, recovery and local
  deletion policies require the user's configured test account. Use
  [the setup guide](final-setup-and-test.md),
  [the E2E checklist](final-e2e-checklist.md), and the explicitly interactive
  `npm run test:drive:manual` helper with disposable generated media.
- A real signed MediaVault update and its public feed require publisher setup and
  manual acceptance. Current local installers are unsigned; automated tests do not
  claim to have installed a signed internet release.
- The profile intentionally stores browsing/session state and local media metadata.
  Windows user-profile permissions and OS-backed encryption are relied upon; these
  boundaries do not defend against arbitrary code already running as that OS user.
  Temporary-cookie cleanup is unlink, not physical SSD erasure, and hard crashes
  can retain a jar until next startup cleanup.
- Local file size/mtime checks and optional sampled fingerprints are not a
  cryptographic integrity guarantee. Site support, external JavaScript-runtime
  requirements and protected content remain yt-dlp/site constraints. DRM is
  unsupported. Very long selected paths may exceed external tool limits.
