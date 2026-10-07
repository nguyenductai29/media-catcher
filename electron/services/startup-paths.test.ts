// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveStartupPaths, type StartupPathsOptions } from "./startup-paths";

describe("Main startup storage paths", () => {
  let directory: string;
  let options: StartupPathsOptions;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mediavault-startup-paths-"));
    const installDirectory = join(directory, "install");
    const resourcesPath = join(installDirectory, "resources");
    mkdirSync(resourcesPath, { recursive: true });
    const appPath = join(resourcesPath, "app.asar");
    writeFileSync(appPath, "asar fixture");
    options = {
      argv: [join(installDirectory, "MediaVault.exe")],
      packaged: true,
      appPath,
      resourcesPath,
      installDirectory,
      defaultUserData: join(directory, "profiles", "default"),
      defaultVideos: join(directory, "videos"),
      env: {},
    };
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("resolves missing default directories without creating or writing anything", () => {
    expect(resolveStartupPaths(options)).toEqual({
      userData: options.defaultUserData,
      videos: options.defaultVideos,
    });
    expect(existsSync(options.defaultUserData)).toBe(false);
    expect(existsSync(options.defaultVideos)).toBe(false);
  });
  it.each([false, true])("accepts explicit CLI paths with spaces when packaged=%s", (packaged) => {
    const userData = join(directory, "isolated profiles", "one"),
      videos = join(directory, "media files");
    expect(
      resolveStartupPaths({
        ...options,
        packaged,
        argv: [
          "MediaVault.exe",
          "--background",
          `--media-videos-dir=${videos}`,
          `--user-data-dir=${userData}`,
        ],
      }),
    ).toEqual({ userData, videos });
  });
  it("retains development environment fallbacks and gives CLI priority", () => {
    const env = {
      MEDIAVAULT_USER_DATA: join(directory, "env-profile"),
      MEDIAVAULT_VIDEOS_DIR: join(directory, "env-videos"),
    };
    expect(resolveStartupPaths({ ...options, packaged: false, env })).toEqual({
      userData: env.MEDIAVAULT_USER_DATA,
      videos: env.MEDIAVAULT_VIDEOS_DIR,
    });
    const userData = join(directory, "cli-profile");
    expect(
      resolveStartupPaths({
        ...options,
        packaged: false,
        env: { ...env, MEDIAVAULT_USER_DATA: "invalid fallback" },
        argv: [`--user-data-dir=${userData}`],
      }),
    ).toEqual({ userData, videos: env.MEDIAVAULT_VIDEOS_DIR });
  });
  it("ignores all environment overrides in packaged builds", () => {
    expect(
      resolveStartupPaths({
        ...options,
        env: { MEDIAVAULT_USER_DATA: options.installDirectory, MEDIAVAULT_VIDEOS_DIR: "relative" },
      }),
    ).toEqual({ userData: options.defaultUserData, videos: options.defaultVideos });
  });
  it.each(["user-data-dir", "media-videos-dir"])(
    "rejects duplicate, empty and missing-value --%s switches",
    (name) => {
      const valid = `--${name}=${join(directory, "selected")}`;
      for (const argv of [
        [valid, valid],
        [valid, `--${name}`],
        [`--${name}`],
        [`--${name}=`],
        [`--${name}`, join(directory, "selected")],
      ])
        expect(() => resolveStartupPaths({ ...options, argv })).toThrow(/^startupFailed$/);
    },
  );
  it.each(["relative", "", "C:relative", "/root-relative", "\\root-relative", "C:\\bad\npath"])(
    "rejects non-explicit or invalid Windows destinations: %j",
    (path) => {
      if (process.platform !== "win32" && path.startsWith("/")) return;
      expect(() => resolveStartupPaths({ ...options, argv: [`--user-data-dir=${path}`] })).toThrow(
        /^startupFailed$/,
      );
    },
  );
  it("rejects invalid selected development environment values instead of falling back", () => {
    expect(() =>
      resolveStartupPaths({
        ...options,
        packaged: false,
        env: { MEDIAVAULT_USER_DATA: "relative" },
      }),
    ).toThrow(/^startupFailed$/);
  });
  it("rejects protected installation roots and their descendants for either destination", () => {
    for (const root of [options.installDirectory, options.resourcesPath, options.appPath])
      for (const destination of [root, join(root, "missing", "data")])
        for (const name of ["user-data-dir", "media-videos-dir"])
          expect(() =>
            resolveStartupPaths({ ...options, argv: [`--${name}=${destination}`] }),
          ).toThrow(/^startupFailed$/);
  });
  it("does not confuse prefix siblings with installation descendants", () => {
    const userData = `${options.installDirectory}-data`;
    expect(
      resolveStartupPaths({ ...options, argv: [`--user-data-dir=${userData}`] }).userData,
    ).toBe(userData);
  });
  it("protects separate development app, resources and executable directories independently", () => {
    const roots = {
      appPath: join(directory, "source"),
      resourcesPath: join(directory, "assets"),
      installDirectory: join(directory, "runtime"),
    };
    for (const root of Object.values(roots)) mkdirSync(root);
    for (const root of Object.values(roots))
      expect(() =>
        resolveStartupPaths({
          ...options,
          ...roots,
          packaged: false,
          argv: [`--user-data-dir=${join(root, "profile")}`],
        }),
      ).toThrow(/^startupFailed$/);
  });
  it.skipIf(process.platform !== "win32")(
    "blocks case aliases and device namespaces on Windows",
    () => {
      for (const path of [
        join(options.installDirectory.toUpperCase(), "profile"),
        "\\\\?\\C:\\profile",
        "\\\\.\\C:\\profile",
      ])
        expect(() =>
          resolveStartupPaths({ ...options, argv: [`--user-data-dir=${path}`] }),
        ).toThrow(/^startupFailed$/);
    },
  );
  it("rejects a missing destination reached through an installation junction", () => {
    const alias = join(directory, "external-alias");
    symlinkSync(options.installDirectory, alias, "junction");
    for (const path of [alias, join(alias, "new", "profile")])
      expect(() => resolveStartupPaths({ ...options, argv: [`--user-data-dir=${path}`] })).toThrow(
        /^startupFailed$/,
      );
  });
  it("returns the canonical destination through a safe existing ancestor", () => {
    const outside = join(directory, "outside"),
      alias = join(directory, "safe-alias");
    mkdirSync(outside);
    symlinkSync(outside, alias, "junction");
    expect(
      resolveStartupPaths({
        ...options,
        argv: [`--user-data-dir=${join(alias, "new", "profile")}`],
      }).userData,
    ).toBe(join(outside, "new", "profile"));
  });
  it("rejects a dangling junction and a file used as a destination or ancestor", () => {
    const dangling = join(directory, "dangling"),
      file = join(directory, "file");
    symlinkSync(join(directory, "missing-target"), dangling, "junction");
    writeFileSync(file, "keep");
    for (const path of [dangling, join(dangling, "profile"), file, join(file, "profile")])
      expect(() => resolveStartupPaths({ ...options, argv: [`--user-data-dir=${path}`] })).toThrow(
        /^startupFailed$/,
      );
  });
  it("rejects unsafe defaults and derived MediaVault video storage inside installation", () => {
    expect(() =>
      resolveStartupPaths({ ...options, defaultUserData: options.resourcesPath }),
    ).toThrow(/^startupFailed$/);
    const videos = join(directory, "portable-parent"),
      installDirectory = join(videos, "MediaVault");
    mkdirSync(installDirectory, { recursive: true });
    expect(() =>
      resolveStartupPaths({ ...options, installDirectory, argv: [`--media-videos-dir=${videos}`] }),
    ).toThrow(/^startupFailed$/);
  });
  it("rejects a safe videos parent whose MediaVault child redirects to installation", () => {
    mkdirSync(options.defaultVideos);
    symlinkSync(options.installDirectory, join(options.defaultVideos, "MediaVault"), "junction");
    expect(() => resolveStartupPaths(options)).toThrow(/^startupFailed$/);
  });
});
