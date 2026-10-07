# Google Drive setup

MediaVault Phase 3 connects one personal Google account through the system
browser. OAuth, encrypted credentials, Drive requests and local-file streams run
in Electron Main. The web/Lovable preview does not sign in or upload files.

## Create a Google Cloud project and desktop client

1. Open [Google Cloud Console](https://console.cloud.google.com/), select the
   project menu, and create a project or select your existing MediaVault project.
2. Open **APIs & Services → Library**, find **Google Drive API**, and enable it for
   that project.
3. Open **Google Auth Platform**. If prompted, choose **Get started** and complete
   the app information and contact email.
4. Under **Branding**, enter your app name, support email and developer contact
   information. Use your own project details; do not copy another app's branding.
5. Under **Audience**, choose **External** for a personal Google account. Keep the
   project in **Testing** while developing and add your Google account under
   **Test users**. An organization-only app can use Internal if its administrator
   permits it.
6. Under **Data Access**, configure these scopes:

   - `https://www.googleapis.com/auth/drive.file`
   - `openid`
   - `https://www.googleapis.com/auth/userinfo.email` (the OAuth `email` scope)
   - `https://www.googleapis.com/auth/userinfo.profile` (the OAuth `profile` scope)

7. Under **Clients**, choose **Create client → Desktop app**, give the client a
   name, and create it. Copy its client ID. Do not choose Web application or a
   service account. A desktop client uses an HTTP loopback callback on an available
   local port; you do not need a hosted callback or custom URL scheme.

Google documents the current [consent-screen setup](https://developers.google.com/workspace/guides/configure-oauth-consent)
and [desktop credential creation](https://developers.google.com/workspace/guides/create-credentials#desktop-app).
Projects in Testing can require reconnecting when refresh tokens expire; Google's
[token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration)
explain the seven-day testing limit and other revocation conditions.

## Configure and start MediaVault

In PowerShell, set the variables in the same terminal used to start Electron:

```powershell
$env:GOOGLE_CLIENT_ID = 'YOUR_DESKTOP_CLIENT_ID.apps.googleusercontent.com'
# Set this only if your desktop client's token exchange requires it:
$env:GOOGLE_CLIENT_SECRET = 'YOUR_DESKTOP_CLIENT_CREDENTIAL'
npm run electron:dev
```

Alternatively, copy `.env.example` to `.env.local`, replace its placeholders, and
load it explicitly with the existing development entry point:

```powershell
node --env-file=.env.local scripts/electron-dev.mjs
```

`npm run electron:dev` does not automatically load a dotenv file for Electron
Main. Never prefix these variables with `VITE_`, which would make them available
to renderer code. The checked-in example contains placeholders only; local env
files and downloaded client-credential JSON are ignored by Git.

A desktop client ID is public configuration. An optional desktop client secret
cannot be kept confidential inside a distributed application and is not the
security boundary. PKCE, random state, the loopback listener and OS-backed token
storage protect the flow. Do not supply service-account keys, browser cookies,
access tokens or refresh tokens through these variables.

Open **Google Drive** or the Drive section in **Settings**, select **Connect**,
and complete Google's consent screen in the system browser. Return to MediaVault
after authorization. No Google credentials are needed for normal unit tests or
the desktop smoke test. Real account verification is an explicit user action.

## Permissions and account identity

`drive.file` lets MediaVault manage files it creates or files explicitly shared
with the app. Phase 3 creates and manages its own MediaVault folder and uploads;
it does not request full Drive access, use Google Picker, or enumerate your
entire Drive. See [Google's scope definitions](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

The identity scopes provide a display name, email and stable Google subject ID.
The subject binds saved upload jobs, folders and completed metadata to an account;
email alone is not treated as identity. Reconnecting a different account must not
resume another account's sessions or silently reassociate its completed files.
Google describes the [OpenID Connect identity fields](https://developers.google.com/identity/openid-connect/openid-connect).

## Credential and session storage

Refresh credentials are encrypted under the app's user-data directory, normally
`%APPDATA%\MediaVault\auth\google-auth.dat`. Access tokens remain in Main memory.
Resumable session URLs are encrypted before SQLite persistence, with their account
and upload ID bound into the encrypted value. Neither tokens nor session URLs
appear in renderer DTOs, activity records, or technical logs.

Electron `safeStorage` uses Windows DPAPI. This protects stored credentials from
other OS users, not malicious applications running as the same Windows user.
MediaVault refuses persistent authorization if secure storage is unavailable;
Linux's `basic_text` fallback is also rejected. There is no plaintext fallback.
See [Electron's storage security model](https://www.electronjs.org/docs/latest/api/safe-storage).

Disconnect pauses upload work, clears cached tokens and removes saved credentials.
It leaves local files, library records and completed Drive files intact. Google
account permissions can also be removed from your Google Account settings.

## Uploads, recovery and deletion

The root folder is **My Drive / MediaVault**. Its saved ID and app-owned metadata
identify it; a matching display name alone does not establish ownership. Sync
refreshes account quota and known managed IDs rather than scanning all Drive data.

Uploads use streamed chunks, normally 8 MiB, in multiples of 256 KiB except for
the last chunk. On resume, MediaVault validates the local file's size and
modification time, asks Google for its acknowledged offset, and continues there.
An expired session can be replaced. Pause retains encrypted resumable state;
Cancel abandons the session reference without deleting local or cloud files.

A Drive file ID is allocated and saved before upload initiation. Recovery checks
that ID before creating another session, including when Google finished an upload
but the local database commit was interrupted. Reusing the ID prevents accidental
duplicate creation. See Google's [resumable upload and pre-generated ID guidance](https://developers.google.com/workspace/drive/api/guides/manage-uploads).

Automatic upload starts only after a validated download is committed to the
library. Local deletion defaults to **Never**. **Ask me** and **Automatically**
apply only after Google confirms the upload, a separate metadata request verifies
the remote file, and the database transaction succeeds. A removed local file
leaves a Drive-only library record. Upload progress reaching 100% alone never
authorizes deletion.

## Troubleshooting and scope

- **Not configured:** set the desktop client ID in Electron's environment and
  restart the app.
- **Access denied or app not available:** check the selected project, Audience
  test-user list, requested scopes and any Workspace administrator restrictions.
- **Authorization expired:** reconnect; refresh grants can expire or be revoked.
- **Secure storage unavailable:** repair the OS credential store. Do not enable
  plaintext storage to work around the error.
- **File changed:** refresh Library to inspect current availability. An existing
  upload stays tied to its original size/mtime; restore the original bytes or
  import the changed media as a new Library item. A confirmed cloud copy is not
  silently replaced.
- **Quota or permission error:** resolve the account/storage issue before retrying.

This phase does not implement shared drives, multiple simultaneous accounts,
Drive downloads, full two-way synchronization, tray behavior, installer, startup
registration, updater or first-run wizard.

For an optional live check, build with `npm run build:desktop`, then run
`npm run test:drive:manual` in an interactive terminal containing your OAuth
configuration. To load `.env.local`, use
`node --env-file=.env.local scripts/test-drive-manual.mjs`. The helper generates a
tiny video and opens an isolated profile; follow its checklist and use the app UI
to authorize, upload, and choose deletion actions. Nothing uploads automatically
when the helper starts. Keep the generated profile for restart checks, disconnect
before removing it, and clean up any uploaded test copies in Google Drive yourself.
