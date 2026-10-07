# Media tools

MediaVault uses yt-dlp for analysis and downloads, FFmpeg for media processing,
and ffprobe for validating local media. Tools run only in the Electron main process.

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

## FFmpeg and ffprobe

Run `npm run setup:ffmpeg` explicitly on Windows x64. The script uses the
[Gyan release essentials build](https://www.gyan.dev/ffmpeg/builds/), a Windows
binary distributor linked by [FFmpeg's download page](https://ffmpeg.org/download.html).
These are third-party builds, not binaries produced by the FFmpeg project.
The script resolves the release version once, downloads that pinned ZIP from
[Gyan's GitHub mirror](https://github.com/GyanD/codexffmpeg/releases) and its
published SHA-256 checksum from gyan.dev, streams and verifies the archive, then extracts only
`ffmpeg.exe` and `ffprobe.exe`. Traversal paths, symbolic links, encrypted entries,
duplicates, oversized archives and missing tools are rejected. Existing tools are
never overwritten. Staging files are removed after success or failure.

Set `MEDIAVAULT_FFMPEG_VERSION` to a numeric release such as `9.0.2` to pin setup.
For development, `MEDIAVAULT_FFMPEG_PATH` and `MEDIAVAULT_FFPROBE_PATH` may select
trusted absolute executable paths. Packaged apps ignore these overrides and use
`process.resourcesPath/bin`; development defaults to `resources/bin`. Both tools
must be colocated when yt-dlp invokes FFmpeg and ffprobe for a download. Other
platforms need their own trusted tools and development overrides; automatic setup
currently supports Windows x64 only. No global FFmpeg installation is required.

Gyan essentials builds use GPLv3 and include third-party components. Review the
upstream build's licenses and source availability before distributing an app with
these executables. The checksum checks integrity against Gyan's HTTPS metadata;
setup does not verify a publisher signature.

`npm run test:binary-setup` tests both installers without network access. After
explicit setup, `npm test` also generates a tiny local H.264/AAC video and verifies
real probing, thumbnail creation, corrupt-file rejection and binary versions.
