// Uses the installed Electron rasterizer; no native image dependency or online assets.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
const output = join(root, "resources", "branding");
const sizes = [16, 24, 32, 48, 64, 128, 256, 512];

async function render(profile) {
  const { app, BrowserWindow } = await import("electron");
  app.setPath("userData", profile);
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width: 512,
    height: 512,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      offscreen: true,
    },
  });
  try {
    await window.loadURL(
      "data:text/html;charset=utf-8,<!doctype html><title>MediaVault icon renderer</title>",
    );
    const svg = (await readFile(join(output, "icon.svg"))).toString("base64");
    for (const size of sizes) {
      const data = await window.webContents.executeJavaScript(`(async () => {
        const image = new Image();
        image.src = ${JSON.stringify(`data:image/svg+xml;base64,${svg}`)};
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = ${size};
        canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size});
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      await writeFile(join(output, `icon-${size}.png`), Buffer.from(data, "base64"));
    }
  } finally {
    window.destroy();
    app.quit();
  }
}

async function build() {
  await mkdir(output, { recursive: true });
  await readFile(join(output, "icon.svg"));
  const scratch = await mkdtemp(join(tmpdir(), "mediavault-icons-"));
  try {
    const { default: executable } = await import("electron");
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await promisify(execFile)(executable, [scriptPath, "--render", scratch], {
      cwd: root,
      env,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const iconSizes = sizes.filter((size) => size <= 256);
    const frames = await Promise.all(
      iconSizes.map((size) => readFile(join(output, `icon-${size}.png`))),
    );
    const header = Buffer.alloc(6 + frames.length * 16);
    header.writeUInt16LE(1, 2); // Icon image type.
    header.writeUInt16LE(frames.length, 4);
    let offset = header.length;
    frames.forEach((frame, index) => {
      const entry = 6 + index * 16;
      header[entry] = header[entry + 1] = iconSizes[index] === 256 ? 0 : iconSizes[index];
      header.writeUInt16LE(1, entry + 4); // One color plane.
      header.writeUInt16LE(32, entry + 6); // RGBA, including transparency.
      header.writeUInt32LE(frame.length, entry + 8);
      header.writeUInt32LE(offset, entry + 12);
      offset += frame.length;
    });
    await writeFile(join(output, "icon.ico"), Buffer.concat([header, ...frames]));
    await copyFile(join(output, "icon.ico"), join(output, "installer.ico"));
    await copyFile(join(output, "icon-32.png"), join(output, "tray.png"));
    console.log(
      `Generated ${sizes.length} PNG sizes, app/installer ICO (16–256), and tray PNG in resources/branding.`,
    );
  } finally {
    const owned = relative(resolve(tmpdir()), resolve(scratch));
    assert.ok(
      !isAbsolute(owned) &&
        !owned.startsWith(`..${sep}`) &&
        owned !== ".." &&
        owned.startsWith("mediavault-icons-"),
    );
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (process.versions.electron && process.argv.includes("--render")) {
  const profile = process.argv[process.argv.indexOf("--render") + 1];
  assert.ok(profile && isAbsolute(profile));
  // Electron emits ready after evaluating its ESM entry. Awaiting render here
  // would make ready depend on its own completion.
  void render(profile).catch(async (error) => {
    console.error(error instanceof Error ? error.message : "Icon rendering failed");
    const { app } = await import("electron");
    app.exit(1);
  });
} else await build();
