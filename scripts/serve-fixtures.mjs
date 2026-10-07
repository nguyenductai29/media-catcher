import { createInterface } from "node:readline";
import { startFixtureServer } from "./fixture-server.mjs";

const help = `Serve previously generated MediaVault fixtures on 127.0.0.1 only.
Usage: npm run fixtures:serve -- --directory RUN_DIRECTORY [--port 8765]
       [--throttle-kib 128] [--interrupt-after-kib 256]
Default port: a free ephemeral port. The exact URL is printed after validation.
Only manifest-listed, checksum-verified regular media files are served.
Routes: /, /video-10s, /video-60s, /clip-10s.mp4, /clip-60s.mp4,
/hls-video, /hls/index.m3u8, /login, /protected-video, /protected.mp4, /logout.
Optional generated assets: /dash-video, /dash/index.mpd, /video-large, /large.mp4.
Terminal commands: offline, online, throttle KIB_PER_SECOND, interrupt KIB,
normal (restore full speed/no interruption), status, help, quit.
0 disables throttle/interruption. Interruption applies to every media response
until changed; offline also disconnects active responses. No HTTP control API.
Cookies are local test sessions only; server restart requires logging in again.
Ctrl+C stops owned streams/connections. Generated files are always retained.`;
const args = process.argv.slice(2);
if (args.includes("--help")) console.log(help);
else {
  let server;
  let terminal;
  try {
    const options = {};
    const seen = new Set();
    for (let i = 0; i < args.length; i++) {
      const name = args[i];
      const value = args[++i];
      if (seen.has(name) || !value || value.startsWith("--"))
        throw new Error("Invalid fixture server options; use --help.");
      seen.add(name);
      if (name === "--directory") options.directory = value;
      else if (
        ["--port", "--throttle-kib", "--interrupt-after-kib"].includes(name) &&
        /^\d+$/.test(value)
      )
        options[
          {
            "--port": "port",
            "--throttle-kib": "throttleKiB",
            "--interrupt-after-kib": "interruptAfterKiB",
          }[name]
        ] = Number(value);
      else throw new Error("Unknown fixture server option; use --help.");
    }
    if (!options.directory)
      throw new Error("--directory must name a completed generated fixture run.");
    server = await startFixtureServer(options);
    console.log(`Local generated-media fixtures: ${server.origin}/`);
    console.log(`Test login: ${server.origin}/login → ${server.origin}/protected-video`);
    console.log(
      "Type help for local network controls. No Google account or external media is used.",
    );
    terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY),
    });
    const stop = () => terminal.close();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (process.stdin.isTTY) {
      terminal.setPrompt("fixtures> ");
      terminal.prompt();
    }
    try {
      for await (const line of terminal) {
        const [command, argument, extra] = line.trim().toLowerCase().split(/\s+/);
        try {
          if (extra) throw new Error();
          if (command === "quit" || command === "exit") break;
          if (command === "help" || !command) console.log(help);
          else if (command === "status") console.log(JSON.stringify(server.status()));
          else if (command === "offline" || command === "online")
            server.configure({ offline: command === "offline" });
          else if (command === "normal")
            server.configure({ offline: false, throttleKiB: 0, interruptAfterKiB: 0 });
          else if (["throttle", "interrupt"].includes(command) && /^\d+$/.test(argument ?? ""))
            server.configure({
              [command === "throttle" ? "throttleKiB" : "interruptAfterKiB"]: Number(argument),
            });
          else throw new Error();
        } catch {
          console.log("Invalid command or value. Type help for supported controls.");
        }
        if (process.stdin.isTTY) terminal.prompt();
      }
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } catch {
    console.error(
      "Fixture server could not start. Check the directory/manifest, port, and options (--help).",
    );
    process.exitCode = 1;
  } finally {
    terminal?.close();
    await server?.close();
  }
}
