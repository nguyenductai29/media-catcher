# MediaVault icons

`icon.svg` reproduces the existing `LogoMark` in
`src/components/app/primitives.tsx`: the cyan rounded frame, horizontal bars,
and centered play triangle. The background stays transparent.

Regenerate the committed image assets with the installed Electron runtime:

```powershell
node scripts/generate-icons.mjs
```

The hidden renderer uses an isolated temporary profile, loads only the local SVG,
and creates 16, 24, 32, 48, 64, 128, 256, and 512 pixel PNGs. No additional packages,
web requests, fonts, or image-generation service are needed.

- `icon.ico`: Windows application icon with PNG frames from 16 through 256 pixels.
- `installer.ico`: the same branding for the future Windows installer.
- `tray.png`: 32 pixel transparent tray icon.
- `icon-512.png`: high-resolution PNG source for packaging and other desktop uses.

The source of truth is the SVG. Regenerate the PNG/ICO files after changing it;
do not edit the raster outputs independently.
