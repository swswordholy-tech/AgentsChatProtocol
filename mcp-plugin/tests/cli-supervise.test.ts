import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("cli.mjs --supervise lifecycle hygiene", () => {
  test("SIGTERM interrupts a long backoff sleep immediately instead of hanging up to 30s", async () => {
    const cliPath = resolve(import.meta.dir, "../src/cli.mjs");
    // Child runs --connector with invalid RELAY_IDENTITIES so the child exits immediately,
    // putting the parent supervisor straight into a 20s backoff sleep.
    const proc = Bun.spawn([process.execPath, cliPath, "--supervise", "--connector"], {
      env: {
        ...process.env,
        RELAY_IDENTITIES: "not-json",
        AGENTCHAT_SUPERVISE_INITIAL_DELAY_MS: "20000",
        AGENTCHAT_SUPERVISE_MAX_DELAY_MS: "30000",
      },
      stdout: "ignore",
      stderr: "pipe",
    });

    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let stderrBuf = "";
    const enteredSleep = await Promise.race([
      (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return false;
          stderrBuf += decoder.decode(value, { stream: true });
          if (stderrBuf.includes("supervise: restarting after exit")) return true;
        }
      })(),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
    ]);
    expect(enteredSleep).toBe(true);

    const t0 = Date.now();
    proc.kill("SIGTERM");
    await proc.exited;
    const elapsedMs = Date.now() - t0;
    // Must exit promptly (< 2000ms), never waiting out the 20,000ms backoff sleep!
    expect(elapsedMs).toBeLessThan(2000);
  });
});
