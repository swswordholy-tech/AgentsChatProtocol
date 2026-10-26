import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectProfileSelector } from "../src/profile-selection.ts";

test("project selector: binding, local profile, absent; malformed declarations fail closed", () => {
  const cwd = mkdtempSync(join(tmpdir(), "profile-selection-"));
  try {
    expect(projectProfileSelector(cwd)).toBeUndefined();
    mkdirSync(join(cwd, ".agentschat"));
    const profile = join(cwd, ".agentschat/profile.json");
    writeFileSync(profile, "{}");
    expect(projectProfileSelector(cwd)).toEqual({ selector: profile, source: "project-profile" });
    const config = join(cwd, ".agentschat/config.json");
    writeFileSync(config, JSON.stringify({ profile: "Chosen" }));
    expect(projectProfileSelector(cwd)).toEqual({ selector: "Chosen", source: "project-config" });
    writeFileSync(config, JSON.stringify({ profile: "./private/bot.json" }));
    expect(projectProfileSelector(cwd)?.selector).toBe(join(cwd, "private/bot.json"));
    writeFileSync(config, JSON.stringify({ profile: "Chosen", agent_id: "expected", api_url: "http://127.0.0.1:9876", ws_url: "ws://127.0.0.1:9876/ws" }));
    expect(projectProfileSelector(cwd)).toEqual({ selector: "Chosen", source: "project-config", agentId: "expected", apiUrl: "http://127.0.0.1:9876", wsUrl: "ws://127.0.0.1:9876/ws" });
    for (const bad of ["broken", "[]", "null", '{"profile":""}', '{"profile":"Chosen","agent_id":1}', '{"profile":"Chosen","api_url":"http://example.com"}', '{"profile":"Chosen","api_url":"https://user:secret@example.com"}']) {
      writeFileSync(config, bad);
      expect(() => projectProfileSelector(cwd)).toThrow();
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
