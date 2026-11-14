import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
  if (opts.dshProfile !== undefined) {
    const profile = opts.dshProfile.trim();
    if (!profile || !/^[A-Za-z0-9._-]+$/.test(profile) || profile === "." || profile === "..") {
      throw new Error("Invalid DSH profile name");
    }
    return join(home, "profiles", profile, "cordis.patch.yml");
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

  // Case 2: File already has a top-level `- insert:` block (e.g. ~/.dsh/cordis.patch.yml).
  // Splice inside THAT `- insert:` block (preserving its child indent and stopping before
  // any subsequent top-level `- replace:` / `- delete:` block so multi-block files stay valid YAML).
  const normalizedLines = existingContent.replace(/\r\n/g, "\n").split("\n");
  const insertLineIdx = normalizedLines.findIndex((line) => /^-\s*insert:\s*(?:#.*)?$/.test(line));
  if (insertLineIdx >= 0) {
    let detectedIndent: string | null = null;
    let lastBodyLineIdx = insertLineIdx;
    for (let i = insertLineIdx + 1; i < normalizedLines.length; i++) {
      const line = normalizedLines[i]!;
      if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
      if (/^\S/.test(line)) break;
      const itemMatch = line.match(/^([ \t]+)-\s+/);
      if (itemMatch && detectedIndent === null) {
        detectedIndent = itemMatch[1]!;
      }
      lastBodyLineIdx = i;
    }
    const entryLines = renderMcpAgentsChatEntry(detectedIndent ?? "    ", opts).split("\n");
    normalizedLines.splice(lastBodyLineIdx + 1, 0, ...entryLines);
    const merged = normalizedLines.join("\n");
    return {
      content: merged.endsWith("\n") ? merged : `${merged}\n`,
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

let dshPatchTmpSeq = 0;

export function applyDshCordisPatchFile(opts: DshPatchOptions = {}): {
  patchPath: string;
  changed: boolean;
} {
  const patchPath = resolveDshPatchPath(opts);
  const existed = existsSync(patchPath);
  const existing = existed ? readFileSync(patchPath, "utf8") : "";
  const { content, changed } = mergeDshCordisPatch(existing, opts);
  if (changed) {
    mkdirSync(dirname(patchPath), { recursive: true });
    let mode = 0o600;
    if (existed) {
      try {
        mode = statSync(patchPath).mode & 0o777;
      } catch {}
    }
    const tmp = `${patchPath}.${process.pid}.${Date.now()}.${++dshPatchTmpSeq}.tmp`;
    try {
      writeFileSync(tmp, content, { encoding: "utf8", mode });
      renameSync(tmp, patchPath);
      if (process.platform !== "win32") {
        try {
          chmodSync(patchPath, mode);
        } catch {}
      }
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {}
      throw err;
    }
  }
  return { patchPath, changed };
}
