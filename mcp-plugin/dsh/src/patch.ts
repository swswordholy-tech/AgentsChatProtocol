import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface DshPatchOptions {
  dshHome?: string;
  dshProfile?: string;
  agentsChatProfile?: string;
  apiUrl?: string;
  packageSpec?: string;
}

export function resolveDshPatchPath(opts: DshPatchOptions = {}): string {
  const home = opts.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
  if (opts.dshProfile) {
    return join(home, "profiles", opts.dshProfile, "cordis.patch.yml");
  }
  return join(home, "cordis.patch.yml");
}

export function buildMcpAgentsChatArgs(opts: DshPatchOptions = {}): string[] {
  const pkg = opts.packageSpec ?? "agentschat-mcp@latest";
  const args = ["-y", pkg];
  if (opts.agentsChatProfile) {
    args.push("--profile", opts.agentsChatProfile);
  }
  if (opts.apiUrl) {
    args.push("--url", opts.apiUrl);
  }
  return args;
}

function yamlQuote(val: string): string {
  if (/^[A-Za-z0-9._/@:-]+$/.test(val)) return `'${val}'`;
  return JSON.stringify(val);
}

/**
 * Render the YAML lines for an `- id: mcp-agentschat` entry at a given indent.
 */
export function renderMcpAgentsChatEntry(indent: string, opts: DshPatchOptions = {}): string {
  const args = buildMcpAgentsChatArgs(opts);
  const lines = [
    `${indent}- id: mcp-agentschat`,
    `${indent}  name: '@deepseek-ai/dsh-mcp-client'`,
    `${indent}  config:`,
    `${indent}    serverName: agentschat`,
    `${indent}    transport: stdio`,
    `${indent}    command: npx`,
    `${indent}    args:`,
    ...args.map((a) => `${indent}      - ${yamlQuote(a)}`),
  ];
  return lines.join("\n");
}

/**
 * Idempotently merge the `mcp-agentschat` entry into a DSH `cordis.patch.yml`
 * document string while preserving existing comments and entries (such as
 * machine-local `openai-fetch-proxy` or UI settings overrides).
 */
export function mergeDshCordisPatch(existingContent: string, opts: DshPatchOptions = {}): {
  content: string;
  changed: boolean;
} {
  if (/(?:^|\n)\s*-\s*id:\s*['"]?mcp-agentschat['"]?(?:\s|$)/m.test(existingContent)) {
    return { content: existingContent, changed: false };
  }

  const trimmed = existingContent.trim();

  // Case 1: Empty file or comments-only or empty YAML array `[]`
  const withoutComments = existingContent
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .trim();

  if (!trimmed || withoutComments === "" || withoutComments === "[]") {
    const commentLines = existingContent
      .split("\n")
      .filter((line) => /^\s*#/.test(line));
    const prefix = commentLines.length > 0 ? `${commentLines.join("\n")}\n` : "";
    const block = `- insert:\n${renderMcpAgentsChatEntry("    ", opts)}\n`;
    return { content: `${prefix}${block}`, changed: true };
  }

  // Case 2: File already has a top-level `- insert:` block (like ~/.dsh/cordis.patch.yml)
  if (/^-\s*insert:\s*$/m.test(existingContent)) {
    const normalized = existingContent.endsWith("\n") ? existingContent : `${existingContent}\n`;
    return {
      content: `${normalized}${renderMcpAgentsChatEntry("    ", opts)}\n`,
      changed: true,
    };
  }

  // Case 3: File is a top-level YAML array of patch entries (like profiles/desktop/cordis.patch.yml)
  const normalized = existingContent.endsWith("\n") ? existingContent : `${existingContent}\n`;
  const block = `- insert:\n${renderMcpAgentsChatEntry("    ", opts)}\n`;
  return {
    content: `${normalized}${block}`,
    changed: true,
  };
}

export function applyDshCordisPatchFile(opts: DshPatchOptions = {}): {
  patchPath: string;
  changed: boolean;
} {
  const patchPath = resolveDshPatchPath(opts);
  const existing = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
  const { content, changed } = mergeDshCordisPatch(existing, opts);
  if (changed) {
    mkdirSync(dirname(patchPath), { recursive: true });
    writeFileSync(patchPath, content, "utf8");
  }
  return { patchPath, changed };
}
