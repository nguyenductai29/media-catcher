// @vitest-environment node
import { describe, expect, it } from "vitest";
import { runManagedProcess } from "./process-runner";

const defaults = { timeout: 5_000, maxStdout: 64, maxStderr: 64 };
describe("managed process boundary", () => {
  it("classifies full-disk errors without exposing diagnostic text", async () => {
    for (const message of [
      "ENOSPC: private path",
      "No space left on device",
      "There is not enough space on the disk",
    ]) {
      await expect(
        runManagedProcess(
          process.execPath,
          ["-e", "process.stderr.write(process.argv[1]);process.exit(1)", message],
          defaults,
        ),
      ).rejects.toThrow(/^insufficientSpace$/);
    }
  });
  it("captures bounded metadata without exposing diagnostic output", async () => {
    await expect(
      runManagedProcess(process.execPath, ["-e", "process.stdout.write('metadata')"], defaults),
    ).resolves.toBe("metadata");
    await expect(
      runManagedProcess(
        process.execPath,
        ["-e", "process.stderr.write('private token');process.exit(1)"],
        { ...defaults, failureCode: "probeFailed" },
      ),
    ).rejects.toThrow(/^probeFailed$/);
  });
  it("streams unlimited progress with bounded lines and a stderr tail", async () => {
    const lines: string[] = [];
    const output = await runManagedProcess(
      process.execPath,
      [
        "-e",
        "for(let n=0;n<1000;n++){process.stdout.write('progress '+n+'\\r\\n');process.stderr.write('diagnostic'.repeat(10));}process.stdout.write('end')",
      ],
      { ...defaults, onStdoutLine: (line) => lines.push(line) },
    );
    expect(output).toBe("");
    expect(lines).toHaveLength(1001);
    expect(lines[0]).toBe("progress 0");
    expect(lines.at(-1)).toBe("end");
  });
  it("rejects oversized captured output and oversized progress lines", async () => {
    for (const onStdoutLine of [undefined, () => undefined]) {
      await expect(
        runManagedProcess(
          process.execPath,
          ["-e", "process.stdout.write('x'.repeat(1000));setInterval(()=>{},1000)"],
          { ...defaults, ...(onStdoutLine ? { onStdoutLine } : {}) },
        ),
      ).rejects.toThrow(/^downloadFailed$/);
    }
  });
  it("decodes split UTF-8 and never invokes callbacks after cancellation", async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    const result = runManagedProcess(
      process.execPath,
      [
        "-e",
        "const b=Buffer.from('Việt\\n');process.stdout.write(b.subarray(0,3));setTimeout(()=>process.stdout.write(b.subarray(3)),10);setInterval(()=>process.stdout.write('late\\n'),500)",
      ],
      {
        ...defaults,
        signal: controller.signal,
        onStdoutLine(line) {
          lines.push(line);
          controller.abort();
        },
      },
    );
    await expect(result).rejects.toThrow(/^cancelled$/);
    expect(lines).toEqual(["Việt"]);
  });
  it("uses safe timeout and spawn errors", async () => {
    await expect(
      runManagedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        ...defaults,
        timeout: 30,
        timeoutCode: "probeFailed",
      }),
    ).rejects.toThrow(/^probeFailed$/);
    await expect(runManagedProcess("missing-mediavault-executable", [], defaults)).rejects.toThrow(
      /^binaryMissing$/,
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      runManagedProcess(process.execPath, [], { ...defaults, signal: controller.signal }),
    ).rejects.toThrow(/^cancelled$/);
  });
});
