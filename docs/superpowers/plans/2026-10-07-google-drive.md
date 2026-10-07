# Google Drive Phase 3 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the bounded service tasks and integration review. The user has explicitly authorized implementation; proceed in A–H order without another design approval.

**Goal:** Upload validated Library files to Google Drive with secure OAuth, resumable streamed transfers, durable recovery and safe optional local deletion.

**Architecture:** Extend existing main-owned SQLite repositories, typed IPC and SnapshotEvents. Main owns credentials and upload sessions; renderer receives explicit public DTOs. A Drive coordinator connects auth/API/queue to download completion, Library and shutdown.

**Tech Stack:** Existing Electron/TypeScript/React/better-sqlite3; native safeStorage, Node streams/HTTPS, Google OAuth desktop client and Drive API v3.

**Spec:** User's Phase 3 attachment dated 2026-10-07; implementation and verification report in `docs/desktop-phase-three.md`.

## Global constraints

- Preserve committed Phase 1/2 and migration v1 exactly; append migration v2.
- Preserve Lovable layout, shared Result/ErrorCode, trusted sender checks, sandbox and EN/VI locale files.
- No credentials or session capabilities in shared DTOs, renderer, plaintext persistence or logs.
- Default upload concurrency 2, range 1–3; default chunk 8 MiB; auto-upload off; deletion Never.
- Never read whole media into RAM; stream bounded chunks from validated records.
- No installer, tray, updater, startup agent, wizard, shared drives, Picker, cloud downloads or two-way sync.
- No commits, history rewrites or real user-file uploads during automated tests.

## Review focus

- Final cloud request succeeds but its response/local transaction is lost: preallocate and persist a Google file ID before upload, then reconcile metadata without creating a duplicate (D/G tests).
- Disconnect, account switch or shutdown races a token response/queue enqueue: generation/abort guards and queue holds prevent late persistence or wrong-account work (B/D tests).
- Local file changes while upload runs or deletion confirmation is pending: revalidate size, mtime, canonical path and record identity before each transfer/deletion (C/G tests).
- Resumable 308, missing Range, expired sessions, network failures and redirects: authoritative offset query, bounded retries, exact trusted endpoints and no blind chunk retry (C/D tests).
- A removed local file's pathname is reused: unavailable records retain last-known path but release normalized-path uniqueness; cloud metadata never attaches silently to new bytes (A/G tests).

## A — Persistence and contracts

Files: `shared/{models,ipc-types}.ts`, `electron/drive/models.ts`, `electron/database/migrations.ts`, `electron/repositories/{media,drive-upload}-repository.ts`, `electron/services/drive-settings-service.ts` and adjacent tests.

Interfaces: public DriveAccount/DriveUpload/DriveSettings/DriveSnapshot; internal StoredDriveUpload adds localPath, modifiedAt, attempts, encrypted session and plannedFileId. Repository list/get/save/findActive/recoverInterrupted; settings get/update.

- [x] Add migration tests preserving v1 rows/settings/activity, interrupted recovery, active-job uniqueness and unavailable-path reuse; prove failures before implementation.
- [x] Append v2 with drive_uploads and media availability/account/file metadata; rebuild only the activity CHECK-constrained table while preserving history.
- [x] Implement prepared repositories and strict persisted preferences; keep defaults compatible with Phase 2 records.
- [x] Run focused database/repository/settings tests; 41 tests across 5 files pass.

## B — OAuth and secure storage

Files: `electron/drive/{secure-store,google-auth-service}.ts`, adjacent tests, `.env.example`, `.gitignore`, `docs/google-drive-setup.md`.

Interfaces: SecureStore read/write/remove/seal/unseal; GoogleAuthService initialize/getAccount/connect/disconnect/getAccessToken/shutdown with account events. Only Drive API uses getAccessToken internally.

- [x] Test state/PKCE/callback validation, listener cleanup, encrypted persistence, refresh single-flight, invalid_grant and disconnect races.
- [x] Implement safeStorage encryption with no plaintext fallback and context-bound encrypted upload sessions.
- [x] Implement random-port loopback OAuth in system browser with state + S256 PKCE, Google userinfo stable subject and memory-only access tokens.
- [x] Document desktop client setup and drive.file + openid/email/profile scopes using current primary Google documentation; run focused tests.

## C — Google Drive API primitives

Files: `electron/drive/{google-drive-service,drive-transport}.ts` and adjacent tests.

Interfaces: getQuota, ensureRootFolder(existingId?), generateFileId, getFile(id), startResumable, queryResumable, uploadChunk; state is incomplete(offset), complete(metadata) or expired. DriveRequestError carries safe code/retryability only.

- [x] Test folder reuse, ID generation, quota, metadata, session endpoint validation, byte ranges and streamed bodies against injected HTTP.
- [x] Implement exact HTTPS endpoints with redirects rejected, bounded JSON responses, token refresh once after 401 and safe error mapping.
- [x] Stream chunks with original size/mtime validation, 256 KiB-compatible sizing and authoritative server offsets; preserve sessions for retry.
- [x] Resolve filename collisions inside the managed destination with numbered suffixes and reservations for simultaneous jobs; test existing and concurrently allocated names.
- [x] Run focused API/transport tests without Google credentials.

## D — Upload engine

Files: `electron/drive/{upload-worker,upload-manager}.ts` and tests.

Interfaces: worker execute(job, checkpoint, progress, signal) returns verified metadata; manager add(mediaId), list/get, pause/resume/cancel/retry, pauseAll/shutdown/settingsChanged/reconcile.

- [x] Test concurrency 2, failure isolation, pause/cancel, persisted resume, expired sessions, account mismatch, file mutation and duplicate enqueues.
- [x] Persist planned Google file ID before creating a resumable session; encrypt sessions and query remote offset on every continuation.
- [x] Retry transient network/429/5xx failures at most three attempts with abortable exponential backoff and offset query before resend.
- [x] Complete only after files.get verifies ID, media/job ownership and byte size; persist job/media/activity in one transaction.
- [x] Run focused worker/queue recovery tests, including failed completion transaction and already-complete remote file.

## E — Main integration and trusted IPC

Files: `electron/drive/drive-coordinator.ts`, `electron/ipc/register-drive-ipc.ts`, existing register-ipc/preload/main, shared contracts and boundary tests.

- [x] Test trusted-frame enforcement, IDs/settings schemas and DTO allowlist excluding credentials/session/internal paths.
- [x] Wire public drive getState/getAccount/connect/disconnect/sync/listUploads/upload/pause/resume/cancel/retry/open/onChanged and settings getDrive/updateDrive.
- [x] Bind Open in Drive to stored current-account IDs and a constructed official URL; stop/drain work before disconnect or shutdown.
- [x] Extend close confirmation to trigger for either active downloads or uploads, using the exact combined EN/VI message.
- [x] Run IPC tests and integrated typecheck after the stable contracts are wired.

## F — Existing UI integration

Files: existing Drive/Library/Settings/Activity/Downloads routes, AppShell, collection hooks, locale files, desktop fixtures/tests.

- [x] Subscribe before initial snapshot; preserve settings edits across progress updates.
- [x] Render real account/quota/root, upload tabs/actions/progress, cross-account state and Drive-only Library guards.
- [x] Persist settings; default off/Never, concurrency 1–3. Add exact EN/VI confirmation and error strings.
- [x] Test disconnected state, finalizing vs completed, actions using only IDs, cross-account and Drive-only safety, locale parity and old UI regression suite.

## G — Automation and recovery

Files: existing DownloadManager/LibraryService, coordinator/manager and tests.

- [x] Invoke automatic enqueue only after successful download transaction; upload failure cannot change completed download state.
- [x] Enforce one active upload per media/account and refuse duplicate verified uploads or overwriting another account's metadata.
- [x] Implement Never/Ask/Automatically after verified remote file and committed cloud metadata; Ask cannot hold the worker slot.
- [x] Revalidate before deletion, retain Drive-only record, retain metadata on disconnect and refresh only known current-account files.
- [x] Test post-upload deletion safety, changed-file confirmation race, remote success/local failure reconciliation and missing local file refresh.

## H — Verification and documentation

Files: `scripts/smoke-electron.mjs`, README, `docs/{google-drive-setup,desktop-phase-three}.md` and optional manual verification helper.

- [x] Keep Electron smoke credential-free; assert real disconnected Drive page and existing local download workflow.
- [x] Run all requested checks: typecheck, lint, test, test:binary-setup, build, test:desktop.
- [x] Independently review security/recovery/deletion boundaries and resolve findings with regressions.
- [x] Record precise tested scope, live-Google verification availability, changed files, migration/API/storage/scopes and Phase 4 work. Never claim a live Google upload unless actually authorized and observed.
