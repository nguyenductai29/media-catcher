# yt-dlp executable

This milestone uses yt-dlp only to analyze page metadata and media formats.
Media downloads and ffmpeg are not included.

Run `npm run setup:ytdlp` explicitly from the repository root. The setup script
downloads the latest stable standalone executable from the
[official yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases), pins that
release for both downloads, verifies its SHA-256 checksum against the release's
`SHA2-256SUMS`, and installs it atomically here. It refuses to replace an existing
file. To update, explicitly remove your existing executable and run setup again.
The executable and partial downloads are ignored by Git.

Windows uses `resources/bin/yt-dlp.exe`; macOS and Linux use
`resources/bin/yt-dlp`. Setup supports Windows x64/x86/ARM64, macOS x64/ARM64,
and glibc Linux x64/ARM64. Packaged apps resolve the same `bin` directory under
Electron's resources path. Packaging must include the correct platform binary.

To select a release, set `MEDIAVAULT_YTDLP_VERSION` to its date tag before setup.
For development only, an existing trusted executable can be selected by setting
`MEDIAVAULT_YTDLP_PATH` to its absolute path; packaged apps ignore this override.
No setup, update, cookie export, or browser-cookie access runs automatically.

Analysis disables yt-dlp configuration, plugins and filesystem caching. It limits
process duration and captured output. Some sites require authentication or
additional JavaScript support that this milestone does not configure; these
produce a localized analysis error. DRM-protected formats are never offered.

Official standalone builds include dependencies with their own licenses; see
[yt-dlp release licensing](https://github.com/yt-dlp/yt-dlp#licensing) before
redistributing them. SHA-256 verifies release-file integrity; this setup does not
perform GPG signature verification.
