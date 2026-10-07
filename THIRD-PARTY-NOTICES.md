# Third-party software in MediaVault

MediaVault packages the following independent command-line programs without modifying
their executable contents. Their licenses and notices apply to those programs and
their bundled components. This document does not grant a new license to MediaVault.

| Program                                   | Packaged Windows x64 version | License                                                                              |
| ----------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| yt-dlp standalone executable              | 2026.08.19                   | GPL version 3 or later for the combined executable; yt-dlp's own source is Unlicense |
| FFmpeg and ffprobe, Gyan essentials build | 9.0.2                        | GPL version 3 or later                                                               |
| better-sqlite3                            | 13.0.3                       | MIT; SQLite is public domain                                                         |
| node-addon-api                            | 8.9.2                        | MIT                                                                                  |
| electron-updater                          | 6.8.9                        | MIT                                                                                  |

Installed notices are in `resources/notices/` beside `resources/bin/`. The
`binaries.json` manifest records exact executable sizes, SHA-256 checksums, download
URLs, and source references. Packaging fails if the bundled files differ from that
manifest. Executables run as separate child processes; they are not linked into
MediaVault's JavaScript or native SQLite module.

## yt-dlp

Project: <https://github.com/yt-dlp/yt-dlp>

Exact release: <https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19>

Source archive: <https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.tar.gz>

Build scripts: <https://github.com/yt-dlp/yt-dlp/tree/2026.08.19/bundle>

The standalone Windows executable includes Python and third-party components.
Upstream explicitly licenses this combined executable under GPL version 3 or later;
it is incorrect to describe the executable as only Unlicense. The unmodified
`yt-dlp-LICENSE.txt` and `yt-dlp-THIRD-PARTY-LICENSES.txt` shipped here are from the
2026.08.19 tag. The latter includes component notices and original project links,
including the Python, cryptographic, networking, and media metadata libraries.
Upstream's source availability contact is documented in that file; it is an
upstream statement, not a substitute for a MediaVault distributor's obligations.

## FFmpeg and ffprobe

Project: <https://ffmpeg.org/>

Build distributor: <https://www.gyan.dev/ffmpeg/builds/>

Exact build: <https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2>

FFmpeg source commit identified by that build:
<https://github.com/FFmpeg/FFmpeg/tree/946fcce07b>

Matching FFmpeg source archive:
<https://github.com/FFmpeg/FFmpeg/archive/946fcce07b.tar.gz>

These are Gyan's static essentials builds, configured with `--enable-gpl`,
`--enable-version3`, and `--enable-static`. Their own `-L` output identifies GPL
version 3 or later. `FFmpeg-COPYING-GPL-3.0.txt` and `FFmpeg-LICENSE.md` are unmodified
copies from the identified FFmpeg source commit. FFmpeg's licensing overview is at
<https://ffmpeg.org/legal.html>. Gyan's build page lists included libraries; that
list alone does not identify their exact source revisions or all build inputs.

## Source availability before public distribution

This repository currently produces local test installers. **A complete corresponding
source package has not been verified for either standalone binary distribution.**
The manifest states `completeCorrespondingSourceVerified: false` explicitly.

In particular, the FFmpeg source commit above covers FFmpeg itself, not necessarily
the exact versions, patches, configuration, and build scripts of every statically
linked library in Gyan's executables. The yt-dlp source archive does not by itself
contain all sources for the Python runtime and compiled third-party dependencies
bundled in the standalone executable. Those exact inputs must be obtained and
retained, with the applicable component notices, before asserting redistribution
readiness.

GPL version 3 section 6 requires corresponding source when conveying object code.
For a downloadable release, section 6(d) permits a separate source server when clear
directions accompany the binary and equivalent source access remains available.
A project homepage link or this notice file alone does not satisfy that obligation.
Publish the verified corresponding source access information beside any future
public installer download; no release is uploaded automatically by this project.

## Electron, SQLite, and JavaScript dependencies

Electron's `LICENSE` and `LICENSES.chromium.html` remain in the application
installation directory. They cover Electron and its Chromium/Node components.
The packaged SQLite module and node-addon-api retain their upstream license files
in `app.asar` / `app.asar.unpacked`; accessible copies are included in
`resources/notices/`. Frontend dependency licenses are collected separately in
`resources/notices/npm/` during package preparation, including font licenses. This
directory can include additional production dependencies that build tools bundle
or optimize away; including their notices does not mean they run in the installer.

`npm-supplements.json` identifies upstream license texts absent from several npm
tarballs: Embla Carousel 8.6.0, Victory Vendor 36.9.2, and react-remove-scroll-bar
2.3.8. The latter's npm metadata declares MIT; its full license text comes from the
pinned upstream commit recorded there because that package's published `gitHead`
and version tag were unavailable. Vendored D3 notices are copied from Victory's
`lib-vendor` directory in addition to its own MIT license.
