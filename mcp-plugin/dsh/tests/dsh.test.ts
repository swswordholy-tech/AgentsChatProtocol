import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  applyDshCordisPatchFile,
  buildMcpAgentsChatArgs,
  mergeDshCordisPatch,
  resolveDshPatchPath,
} from "../src/patch.ts";
import { loadDshConfig, safeDshConfig } from "../src/cli.ts";

const ROOT = resolve(import.meta.dir, "../..");

describe("DeepSeek Harness (dsh) integration", () => {
  test("package.json declares dsh.bundle.patch and ships cordis.patch.yml", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.dsh?.bundle?.patch).toBe("./cordis.patch.yml");
    expect(pkg.files).toContain("cordis.patch.yml");
    expect(pkg.files).toContain("dsh/");
    expect(pkg.files).toContain("dist/dsh.js");

    const bundlePatch = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
    expect(bundlePatch).toContain("id: mcp-agentschat");
    expect(bundlePatch).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(bundlePatch).toContain("serverName: agentschat");
  });

  test("mergeDshCordisPatch handles empty and [] patch files", () => {
    const emptyRes = mergeDshCordisPatch("");
    expect(emptyRes.changed).toBe(true);
    expect(emptyRes.content).toContain("- insert:");
    expect(emptyRes.content).toContain("- id: mcp-agentschat");
    expect(emptyRes.content).toContain("name: '@deepseek-ai/dsh-mcp-client'");

    const arrayRes = mergeDshCordisPatch("# comment\n[]\n", {
      agentsChatProfile: "DSH_Bot",
      apiUrl: "https://agents-chat.com",
    });
    expect(arrayRes.changed).toBe(true);
    expect(arrayRes.content).toContain("# comment");
    expect(arrayRes.content).not.toContain("[]");
    expect(arrayRes.content).toContain("- '--profile'");
    expect(arrayRes.content).toContain("- 'DSH_Bot'");
    expect(arrayRes.content).toContain("- '--url'");
    expect(arrayRes.content).toContain("- 'https://agents-chat.com'");
  });

  test("mergeDshCordisPatch preserves existing - insert: rows and is idempotent", () => {
    const existing = [
      "# Machine-local DSH patch layer",
      "- insert:",
      "    - id: openai-fetch-proxy",
      "      name: 'file:///Users/test/.dsh/plugins/openai-proxy/index.js'",
      "",
    ].join("\n");

    const first = mergeDshCordisPatch(existing, { agentsChatProfile: "Jack" });
    expect(first.changed).toBe(true);
    expect(first.content).toContain("id: openai-fetch-proxy");
    expect(first.content).toContain("id: mcp-agentschat");
    expect(first.content).toContain("- 'Jack'");

    const second = mergeDshCordisPatch(first.content, { agentsChatProfile: "Jack" });
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  test("applyDshCordisPatchFile writes to profile or home path", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-patch-test-"));
    try {
      const homePatch = resolveDshPatchPath({ dshHome: dir });
      expect(homePatch).toBe(join(dir, "cordis.patch.yml"));

      const res1 = applyDshCordisPatchFile({ dshHome: dir, dshProfile: "desktop", agentsChatProfile: "DshDesktop" });
      expect(res1.changed).toBe(true);
      expect(res1.patchPath).toBe(join(dir, "profiles", "desktop", "cordis.patch.yml"));
      expect(readFileSync(res1.patchPath, "utf8")).toContain("DshDesktop");

      const res2 = applyDshCordisPatchFile({ dshHome: dir, dshProfile: "desktop", agentsChatProfile: "DshDesktop" });
      expect(res2.changed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadDshConfig reads profile file and redacts token in safeDshConfig", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-cfg-test-"));
    try {
      const profilePath = join(dir, "dsh.json");
      writeFileSync(
        profilePath,
        JSON.stringify({ agentId: "dsh-agent-1", token: "ac_secret_token_123456" }),
        "utf8",
      );
      const cfg = loadDshConfig({}, profilePath);
      expect(cfg.agentId).toBe("dsh-agent-1");
      expect(cfg.token).toBe("ac_secret_token_123456");
      const safe = safeDshConfig(cfg);
      expect(safe.agentId).toBe("dsh-agent-1");
      expect(String(safe.token)).not.toContain("secret_token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("buildMcpAgentsChatArgs constructs expected CLI flags", () => {
    expect(buildMcpAgentsChatArgs()).toEqual(["-y", "agentschat-mcp@latest"]);
    expect(
      buildMcpAgentsChatArgs({ agentsChatProfile: "MyDsh", apiUrl: "https://agents-chat.com" }),
    ).toEqual(["-y", "agentschat-mcp@latest", "--profile", "MyDsh", "--url", "https://agents-chat.com"]);
  });
});
