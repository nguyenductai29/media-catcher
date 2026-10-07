# Phase 3 — Google Drive

Phase 3 extends the committed Phase 1 browser and Phase 2 local workflow. It uses
the existing repositories, Result/ErrorCode IPC, SnapshotEvents, logging, routes,
shell and EN/VI locale architecture. No installer, tray or updater is added.

## Implementation map

| Area               | Files and behavior                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts          | `shared/models.ts`, `shared/ipc-types.ts`: public account/settings/upload/snapshot DTOs and safe errors; `electron/drive/models.ts`: internal path, fingerprint, encrypted session and planned ID |
| Persistence        | `electron/database/migrations.ts`, `repositories/media-repository.ts`, new `drive-upload-repository.ts`, `services/drive-settings-service.ts`                                                     |
| OAuth              | `electron/drive/secure-store.ts`, `google-auth-service.ts`: safeStorage, loopback PKCE flow, refresh and disconnect                                                                               |
| Google API         | `electron/drive/drive-transport.ts`, `google-drive-service.ts`: strict HTTPS endpoints, bounded responses, folder/filename management, metadata and streamed resumable requests                   |
| Queue              | `electron/drive/upload-types.ts`, `upload-worker.ts`, `upload-manager.ts`: durable checkpoints, concurrency, retries, pause/cancel and finalization recovery                                      |
| Coordination       | `electron/drive/drive-coordinator.ts`, `electron/main.ts`: account lifecycle, known-ID sync, automatic enqueue, deletion policy and orderly shutdown                                              |
| Desktop boundary   | `electron/preload.ts`, `electron/ipc/register-{ipc,drive-ipc,local-media-ipc}.ts`: existing sender validation and ID-only actions                                                                 |
| Local workflow     | `electron/downloads/download-manager.ts`, `electron/library/library-service.ts`: post-commit hook, availability refresh, cloud records and guarded deletion                                       |
| UI                 | Drive/Library/Settings/Activity/Downloads routes, AppShell, primitives, DriveControls, MediaThumbnail, `use-desktop-drive`, `drive-display`, EN/VI locales and desktop fixtures                   |
| Verification/setup | Adjacent repository/service/Drive tests, renderer Drive tests, `scripts/smoke-electron.mjs`, `scripts/test-drive-manual.mjs`, `.env.example`, `.gitignore`, README and Google setup guide         |

## SQLite migration v2

Migration v1 is unchanged. Transactional v2 adds local/Drive availability, file ID,
stable account ID, upload timestamp and Drive status columns to `media`. Existing
records remain local-only. An unavailable record retains its last-known path but
uses an ID-based normalized-path sentinel, allowing a new file at that pathname
to be imported without inheriting the old cloud association.

`drive_uploads` stores the upload ID/media ID/account ID, path, size/mtime,
filename/MIME, destination and remote/planned IDs, encrypted session, confirmed
bytes, progress/status/errors and timestamps. Prepared repository operations and
indexes support status recovery and media/account lookup. A partial unique index
prevents competing active/failed jobs for a media/account. Upload history remains
after a Library row is removed; Main drains/cancels associated work before removal.

The activity table is rebuilt within migration v2 solely to extend its CHECK
constraint for Drive events. Existing rows, settings and history survive. Tests
start from the original v1 schema and verify preservation and recovery.

## OAuth and credential boundary

Main opens Google's authorization endpoint in the system browser. The temporary
listener binds `127.0.0.1` on an available port and validates method, host, callback
path, origin, unique query parameters and random state. The authorization code is
exchanged with S256 PKCE. The callback expires and closes on success, cancellation
or failure. Google userinfo supplies the stable subject; email is display data.

Scopes: `https://www.googleapis.com/auth/drive.file`, `openid`, `email`, `profile`.
No service account or full-Drive scope is used. The app manages its created folder
and files. Current provider setup and source links are in
[Google Drive setup](google-drive-setup.md).

Only a public desktop client ID and optional desktop client credential are read
from Main's environment. Refresh grants are safeStorage-encrypted under
`userData/auth/google-auth.dat`; access tokens stay in Main memory. Session URLs
are encrypted in SQLite and bound to the account/upload ID. Windows uses DPAPI;
unavailable encryption and Linux `basic_text` fail closed. This does not protect
against malicious software running as the same OS user.

Serialized secure-store operations and generation/abort guards prevent a late
token response or write from restoring disconnected credentials. Refresh is
single-flight; permanent authorization failures clear the grant. Request errors
are mapped to allowlisted codes; tokens, headers, raw API JSON, OAuth codes and
session URLs are excluded from logs and IPC.

## Public IPC

Every invocation uses the original main-window/main-frame/origin check and
returns `Result<T>`. Drive methods exposed through `window.mediaVault.drive`:

- `getState()`, `getAccount()`, `connect()`, `disconnect()`, `sync()`, `listUploads()`
- `upload(mediaId)`, `pause(uploadId)`, `resume(uploadId)`, `cancel(uploadId)`, `retry(uploadId)`
- `open(mediaId)`, `onChanged(listener)` (unsubscribe callback)

Settings adds `getDrive()` and `updateDrive(settings)` with a strict schema:
concurrency 1–3 (default 2), autoUpload false, deleteLocal never/ask/automatic
(default never), chunkSizeMiB 1–64 (default 8). Chunk size is currently configurable
through the typed settings model, not a new UI control.

The renderer supplies IDs and validated settings only. Main resolves library
paths and current-account Drive IDs. Open constructs an official
`https://drive.google.com/file/d/<stored-id>/view` URL. Public upload DTOs explicitly
allowlist fields and exclude internal paths, sessions and credentials. Full
snapshots are coalesced to at most five updates per second; subscription precedes
initial snapshot loading to prevent a stale initial response overwriting events.

## Streaming and recovery

The default 8 MiB chunk is read from a validated file descriptor using at most
64 KiB buffers; entire media files and chunk-sized blobs are never sent through
IPC or saved in SQLite. Nonfinal ranges use 256 KiB multiples. File path, size and
mtime are checked before continuation and during streamed transfer.

The worker persists a preallocated Google file ID before creating a session or
sending bytes. A session is encrypted before persistence. Google-confirmed Range
offsets are saved at chunk/status checkpoints; transient sent-byte progress is a
snapshot overlay and does not replace acknowledged offsets in SQLite.

Pause aborts the request, drains the worker and retains encrypted session state.
Resume validates the file and queries Google's offset. Cancel drops the session
reference, retains the preallocated ID and never deletes a file. Retry uses that
same ID and checks for a completed remote file first. Expired sessions can be
replaced without blindly duplicating a completed file. Restored unfinished work
stays paused; startup reconciliation checks metadata without resuming bytes.

Transient network, rate-limit and 5xx failures use at most three request attempts
with abortable exponential backoff/limited Retry-After. An ambiguous chunk response
is followed by a status query before resend. A 308 acknowledging all bytes is
polled a bounded number of times; it is not itself proof of completion. Permanent
quota, permission, file-change and failed-refresh errors require user action.

Completion requires a separate metadata lookup verifying ID, size, parent and
app-owned media/upload tags. Job/media/activity updates commit together. If Google
succeeded but SQLite failed, the saved planned ID remains the recovery anchor;
metadata reconciliation finalizes the record without retransmitting the file.
Progress remains below 100% until the verified completion commits.

## Automation, deletion and account changes

The download completion callback runs after the validated media/download/activity
transaction. Upload failure cannot downgrade a completed download. Duplicate
enqueues reuse the existing job; confirmed uploads are rejected by default.
When automation is enabled while disconnected, new downloads target the last
explicitly connected account and remain paused. With no previously known account,
an account-required activity is recorded rather than inventing an association.

Never does nothing. Ask/Automatically run after committed upload completion and
verify the remote file again. Ask uses a native localized dialog and does not hold
an upload worker. Disconnect/shutdown abort pending decisions and validation.
Deletion locks the media ID, drains competing upload work, rechecks the latest
cloud record and local path/size/mtime, then unlinks only the known file. Cloud
metadata and thumbnails remain as a Drive-only item.

Manual Library removal/deletion also drains associated upload work before mutation;
cancelling the native confirmation leaves uploads untouched. Refresh preserves
cloud fields across asynchronous probing, detects missing/changed files, and avoids
reassociating a replaced pathname. Local playback/reveal are unavailable for
Drive-only records. A changed local file can retain its older cloud copy with a
visible changed status.

Disconnect blocks new starts, aborts/drains active transfers, clears credentials
and keeps local/cloud files and historical associations. Sync examines only known
IDs belonging to the current stable subject. A different account cannot resume,
open or silently replace prior-account associations. Shutdown waits for network
workers, finalization, pending automation and deletion work before closing SQLite.

## Verification record

Verified on Windows on 2026-10-07:

| Command/check                 | Result                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`           | Pass for renderer and Electron/shared contracts                                                                                                     |
| `npm run lint`                | Pass; seven existing Fast Refresh warnings                                                                                                          |
| `npm test`                    | 304 tests passed across 38 files, including Phase 1/2                                                                                               |
| `npm run test:binary-setup`   | 11 tests passed                                                                                                                                     |
| `npm run build`               | Web/SSR and desktop main/preload/renderer pass                                                                                                      |
| `npm run test:desktop`        | Pass in real Electron: credential-free Drive checks plus existing browser/download/import/playback/deletion/restart workflows                       |
| Renderer bundle boundary scan | No SQLite, safeStorage, Node filesystem/HTTPS, credential config or internal upload-session/planned-ID implementation in desktop/web public bundles |
| `git diff --check`            | Pass                                                                                                                                                |

Unit and integration tests use injected Google transport/services and generated local files;
they never require or access a Google account. The desktop smoke clears Google
configuration, verifies truthful disconnected state and exercises the real existing
browser/download/import/playback workflow in an isolated profile.

Production evidence is saved in `artifacts/desktop-smoke-production.log` and
`artifacts/desktop-drive.png`, with refreshed browser/download/Library/player
screenshots. The disconnected screen was visually inspected. No app or media-tool
processes remained after smoke. Development-origin smoke was not repeated; its
earlier artifact belongs to Phase 2. Build output retains advisory Vite/Nitro
warnings, including the desktop bundle-size warning.

Independent review fixes have regression coverage: cancellation vs reconciliation,
sent vs acknowledged byte offsets, media mutation locks, late automation vs shutdown,
credential writes vs shutdown, disconnect when SQLite fails, deletion-policy changes,
late mutating IPC, unverified progress display, and Disconnect during Sync.

`npm run test:drive:manual` is an interactive helper, not an automated pass. It
generates a tiny MP4, opens an isolated profile and provides a checklist. The user
starts OAuth and each upload/delete action. Test files/profile are retained for
inspection, and cloud fixtures require manual cleanup.

No Google client or live authorization was provided in this development session.
Real Google login, live quota and end-to-end cloud upload have therefore **not been
observed**; credential-free verification does not establish that live acceptance.

## Known limits and Phase 4

- One connected personal account and one app-owned root; folder picking, shared
  drives, Google Picker and simultaneous account UI are not implemented.
- Sync refreshes known metadata; no cloud download, broad Drive browsing, remote
  deletion or two-way synchronization is implemented.
- File identity uses size/mtime and path checks, not a full content hash. An existing
  upload remains tied to its original fingerprint; refreshing a changed file does
  not silently replace that job's bytes or an already confirmed cloud copy.
- Filename reservations are process-local; another app instance/device can create
  a same-named Drive file concurrently. Drive file IDs still prevent overwriting.
- If local deletion succeeds immediately before a SQLite failure/crash, Library
  Refresh reconciles local availability. Google completion remains durably known.
- A tiny manual fixture may finish before Pause is clicked; that does not count as
  observed live interruption recovery. Multi-gigabyte live stress tests remain open.
- Google test-project refresh-token expiry and Workspace policy may require
  reconnecting; see the setup guide. Portable configuration is environmental for
  development; distribution/credential rollout belongs with packaging work.

Phase 4 remains installer, tray/background operation, startup registration,
auto-updater and first-run wizard. No published Git history is rewritten.
Changes are left in the working tree for review; no commit or push was made.
