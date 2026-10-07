# Phase two: local downloads and library

Build on committed Phase 1 (65d240e), preserving the Lovable layout and sandboxed
typed bridge. No Drive, installer, tray, updater or authentication export.

## Implementation sequence

1. **A — Persistence:** shared models, versioned transactional SQLite migrations,
   download/media/settings/activity repositories; recover unfinished jobs as paused.
2. **B — Binaries:** explicit checksum-verified FFmpeg/ffprobe setup, discovery,
   bounded probe/thumbnail processes and a streaming cancellable process runner.
3. **C — Engine:** validated yt-dlp argument arrays, structured progress, queue with
   concurrency 1–5, pause/resume/cancel/retry, disk checks, safe output publication.
4. **D — Download UI:** extend existing trusted IPC/preload, detection download
   dialog, real downloads and status counts, persisted preferences.
5. **E — Library:** probe before completion, automatic insertion and events,
   selected-file/folder import, playback by opaque ID, separate remove/delete.
6. **F — Integration:** activity, binary settings, safe shutdown, real local media
   Electron smoke, documentation and all requested verification commands.

## Boundaries and decisions

- Main owns workers, database, filesystem access and selected native directories.
  Renderer submits a detected candidate ID and constrained options, never shell
  strings. Subscriptions send complete metadata snapshots at most five times/sec.
- Browser preferences remain in the existing JSON service to preserve proven
  browser/session behavior. Download settings and activity live in SQLite.
- Pause terminates the process tree and preserves job-scoped partial files. Resume
  queues the same job with yt-dlp `--continue`; server support determines resumption.
- A job completes only after a real file passes ffprobe, is published without
  overwriting existing files, and its media/job records are persisted together.
- Restart never starts saved jobs automatically. Failures cannot block the queue.
- Local playback resolves known media IDs through a restricted app protocol;
  renderer-provided filesystem paths cannot be opened, deleted or served.
- Filename handling covers Windows reserved names, control characters, traversal
  and length. Existing files receive a numbered suffix instead of being replaced.
- Cookie transfer is disabled in this phase. Authenticated downloads may fail.

## Verification ledger

- A complete: better-sqlite3 13.0.3 bundled Node-API prebuild tested in host Node
  22.23.3 and Electron 44.6.0 / Node 24.21.0, with no native rebuild. Schema v1,
  prepared repositories and recovery/preferences checks pass.
- B complete: explicit verified FFmpeg/ffprobe installation; real probe, thumbnail
  and local HTTP yt-dlp download checks pass. Streaming runner handles bounded
  diagnostics, cancellation, timeouts and disk-full errors.
- C complete: concurrency, failure isolation, same-job pause/resume/retry,
  shutdown persistence, filename confinement, collision-safe publication and disk
  reserve. Same-volume publication uses an exclusive hard link; other volumes use
  exclusive native copy. Only completed job staging directories are cleaned.
- D/E complete: existing UI integration, native IPC, controlled playback,
  library import/removal and activity. Independent backend and renderer reviews
  resolved queue/retry, shutdown, import-race and file-validation regressions.
- F complete: real production and development Electron smoke tests pass,
  including explicit byte-range playback. All requested verification commands
  pass with the results recorded below.

Ruling: work in the user's existing clean checkout without commits or history
changes. Repository implementation and binary work use disjoint files after
shared contracts are established; UI integration starts after core queue tests.

### Final command results (2026-10-07, Windows x64)

| Command                                 | Result                                                                |
| --------------------------------------- | --------------------------------------------------------------------- |
| `npm run typecheck`                     | Pass: renderer/shared and Electron TypeScript                         |
| `npm run lint`                          | Pass: 0 errors; 7 existing Fast Refresh export warnings               |
| `npm test`                              | Pass: 169 tests in 26 files, including real local media/process tests |
| `npm run test:binary-setup`             | Pass: 11 checksum, extraction and overwrite-protection tests          |
| `npm run build`                         | Pass: Lovable web/SSR, static desktop renderer and main/preload       |
| `npm run test:desktop`                  | Pass: production Electron with local HTTP fixtures                    |
| `node scripts/smoke-electron.mjs --dev` | Pass: same workflow under the Vite development origin                 |

Builds retain nonblocking Vite/Nitro configuration and desktop chunk-size warnings.
The final renderer bundles contain no SQLite or Node child-process modules.
No yt-dlp, FFmpeg or ffprobe processes remained after the desktop tests.

### Tested workflows

- Generate a real H.264/AAC fixture with FFmpeg; detect and analyze it in Browser,
  select a native destination in the Download dialog, download with yt-dlp,
  remux MP4 to MKV, probe the final file, generate a thumbnail, and verify both
  SQLite records and live Library UI without restarting.
- Download a generated HLS manifest and local segments; verify the resulting
  codecs, dimensions, duration and Library record.
- Observe real progress, pause, resume, cancel and retry the same job. Cancel an
  active Exit prompt, then confirm Exit, relaunch into a paused state, explicitly
  resume and verify a nonzero HTTP Range request uses the saved partial file.
- Import a native-selected file without copying it, skip a duplicate path, scan
  only the selected folder with/without subfolders, refresh, remove a Library
  record while preserving its file, and check Cancel/Delete confirmation paths.
- Play real local media through an opaque ID URL, receive HTTP 206 partial
  content, and observe decoded video metadata/frames. Unit tests also verify
  invalid ranges, bounded streaming and a file disappearing before stream setup.
- Clear completed downloads while retaining Library records/files. Verify
  persisted preferences and activity; retain Phase 1 browser navigation,
  detection, analysis, EN/VI controls, cookie persistence, data clearing and
  sandbox/IPC/session checks. Queue tests verify concurrency two, failure
  isolation, crash recovery and atomic completion rollback.

Tests use local fixtures; no external media website is required. Smoke tests
stub only native picker/confirmation responses at the OS boundary. Actual file,
process, probe, download, database and playback operations execute normally.
Open Folder is checked at the validated IPC-to-shell boundary without launching
Explorer during automated tests. Forced-crash recovery is unit-tested; the
desktop restart scenario exercises graceful active-download shutdown.

Ignored local evidence: `artifacts/phase-two-{typecheck,lint,test,binary-setup,build}.log`,
`artifacts/desktop-smoke-{production,development}.log`, and
`artifacts/desktop-{smoke,browser,downloads,library,player}.png`.

## Files and ownership

| Area                      | Implementation                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Contracts                 | `shared/models.ts`, `shared/ipc-types.ts`, `shared/filenames.ts`                                                        |
| Persistence               | `electron/database/{database,migrations}.ts`, `electron/repositories/*`                                                 |
| Download engine           | `electron/downloads/{download-manager,download-worker,download-progress,download-files,ytdlp-service}.ts`               |
| Media tools               | `electron/services/{binary-service,process-runner,ffmpeg-service}.ts`, `scripts/setup-ffmpeg.mjs`                       |
| Local library             | `electron/library/library-service.ts`                                                                                   |
| Native boundary           | `electron/{main,preload}.ts`, `electron/ipc/*`, `electron/services/{app-protocol,media-stream}.ts`                      |
| Preferences/activity/logs | `electron/services/{download-settings-service,activity-service,local-logger,native-i18n,snapshot-events}.ts`            |
| Renderer                  | Existing Browser, Downloads, Library, Activity, Settings and AppShell; new download/player dialogs and collection hooks |
| Validation                | Repository/service/queue/IPC/React tests and `scripts/smoke-electron.mjs`                                               |

## Database schema

`mediavault.db` is a main-process SQLite connection in Electron `userData`.
Migration version 1 is recorded with `PRAGMA user_version`; all pending DDL and
version changes use one transaction. Unsupported newer schemas fail without
resetting user data. WAL, full synchronous commits, prepared values and foreign
keys are enabled.

| Table           | Stored data and constraints                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `downloads`     | Source/page URL, title, format/quality/container, destination/output, numeric progress, status/timestamps/error, retry count and linked media ID |
| `media`         | Canonical path plus unique normalized path, source/download link, title, probe metadata, thumbnail, size and modification time                   |
| `settings`      | Typed JSON preferences by key, update time; download preferences and native-dialog language                                                      |
| `activity_logs` | Typed event, sanitized title, timestamp, optional job/media ID and safe error code                                                               |

Removing completed downloads preserves media (`ON DELETE SET NULL`). Removing
media clears its linked job ID reference. Completing a job inserts its media,
updates its status and records activity atomically. Startup converts every saved
queued/analyzing/downloading/processing job to paused without starting workers.

## Typed bridge additions

Request methods retain `Promise<Result<T>>`, fixed IPC channels and trusted
main-frame sender checks. Event subscriptions return an unsubscribe function.
There is no SQL, Node import or generic filesystem operation in React.

- `downloads`: `list`, `add`, `chooseDirectory`, `pause`, `resume`, `cancel`,
  `retry`, `pauseAll`, `resumeAll`, `clearCompleted`, `openFolder`, `play`, `onChanged`.
- `library`: `list`, `addFile`, `addFolder`, `refresh`, `remove`, `deleteFile`,
  `openFolder`, `play`, `openExternal`, `onChanged`.
- `activity`: `list`, `onChanged`.
- `settings`: `getDownloads`, `updateDownloads`, `setLanguage` in addition to
  the unchanged browser settings operations.
- `binaries.getStatus`: separate ready/missing/invalid states and versions for
  yt-dlp, FFmpeg and ffprobe; the Phase 1 `status` method remains compatible.

Downloads accept a current detected candidate ID and constrained options. Native
dialogs approve directories/import paths; delete/open/play take known record IDs.
`mediavault://media/<id>/video` and `/thumbnail` require the trusted renderer's
Electron-provided initiator origin and resolve through known records. Main serves
byte ranges with explicit 206/416 responses and bounded 64 KiB stream queues;
whole media files are never buffered. Remote pages have a different session with
no handler.

## Practical limits and Phase 3

- Browser cookies are not transferred to yt-dlp. Login-restricted media may fail;
  no automatic Chrome/Edge cookie export or DRM circumvention is implemented.
- Pause is process termination plus continuation, not OS suspension. Servers may
  restart a transfer; partials remain until success. Explicit cancellation never
  inserts a library record. A publication finishing during cancellation is retained
  for retry; an in-flight cross-volume native copy must finish before shutdown.
- MP4/MKV remux can fail for incompatible codecs; no automatic full video encode
  is attempted. Audio mode chooses its original audio container. Chromium preview
  support differs from ffprobe validity; the default-player action is explicit.
- Local imports use path/size/mtime, not whole-file hashes. Changed/missing files
  are not silently deleted from the library; refresh re-probes changed files.
- Binary setup is explicit and currently FFmpeg setup targets Windows x64. Future
  distribution must include the tools and satisfy their redistribution licenses.
- Drive/OAuth/upload/sync, tray, updater, first-run wizard and installer remain
  future work. Existing prototype controls for those actions are disabled.

## Changed files

All paths below are relative to the repository root. Generated builds, binaries,
temporary profiles and smoke screenshots are ignored by Git.

```text
desktop/index.html
docs/desktop-phase-two.md
electron/database/database.test.ts
electron/database/database.ts
electron/database/migrations.ts
electron/downloads/download-files.test.ts
electron/downloads/download-files.ts
electron/downloads/download-manager.test.ts
electron/downloads/download-manager.ts
electron/downloads/download-progress.test.ts
electron/downloads/download-progress.ts
electron/downloads/download-worker.test.ts
electron/downloads/download-worker.ts
electron/downloads/ytdlp-service.ts
electron/ipc/local-media-ipc.test.ts
electron/ipc/register-ipc.ts
electron/ipc/register-local-media-ipc.ts
electron/library/library-service.test.ts
electron/library/library-service.ts
electron/main.ts
electron/preload.ts
electron/repositories/activity-repository.ts
electron/repositories/download-repository.ts
electron/repositories/media-repository.ts
electron/repositories/repositories.test.ts
electron/repositories/settings-repository.ts
electron/services/activity-service.ts
electron/services/app-protocol.test.ts
electron/services/app-protocol.ts
electron/services/binary-service.test.ts
electron/services/binary-service.ts
electron/services/download-settings-service.test.ts
electron/services/download-settings-service.ts
electron/services/ffmpeg-integration.test.ts
electron/services/ffmpeg-service.test.ts
electron/services/ffmpeg-service.ts
electron/services/local-logger.ts
electron/services/media-stream.test.ts
electron/services/media-stream.ts
electron/services/native-i18n.ts
electron/services/process-runner.test.ts
electron/services/process-runner.ts
electron/services/setup-ffmpeg.test.mjs
electron/services/snapshot-events.ts
package-lock.json
package.json
README.md
resources/bin/README.md
scripts/build-electron.mjs
scripts/setup-ffmpeg.mjs
scripts/smoke-electron.mjs
shared/filenames.ts
shared/ipc-types.ts
shared/models.ts
src/components/app/AppShell.tsx
src/components/app/DownloadDialog.tsx
src/components/app/MediaPlayerDialog.tsx
src/components/app/primitives.tsx
src/components/ui/sheet.tsx
src/hooks/use-desktop-collections.ts
src/lib/i18n.tsx
src/lib/media-display.ts
src/locales/en.json
src/locales/vi.json
src/routes/about.tsx
src/routes/activity.tsx
src/routes/downloads.tsx
src/routes/drive.tsx
src/routes/index.tsx
src/routes/library.tsx
src/routes/settings.tsx
src/test/desktop-browser.test.tsx
src/test/desktop-collections.test.tsx
src/test/desktop-download-dialog.test.tsx
src/test/desktop-fixture.ts
src/test/desktop-settings.test.tsx
src/test/media-display.test.ts
tsconfig.electron.json
vitest.config.ts
```
