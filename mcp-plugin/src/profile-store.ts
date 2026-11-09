/**
 * Atomic, permission-safe write of the agent profile.
 *
 * Extracted from the side-effecting server entrypoint so it can be unit-tested: the
 * property that matters here (the key is never world-readable, even mid-write) is only
 * observable if you can call this directly and interrupt it.
 *
 * The profile holds a live agent key, so 0600 is a security control. Two traps:
 *  - `writeFileSync`'s `mode` applies ONLY when the file is created. A .tmp left behind by
 *    an earlier crash keeps its own permissions, and `renameSync` preserves the source's
 *    mode — so a stale 0644 .tmp yields a 0644 profile. Unlinking it first makes 0600 true
 *    *by construction*: the key is never on disk world-readable, not even in the window
 *    between rename and chmod.
 *  - `chmodSync` used to be the sole enforcement point, and its failure was swallowed by a
 *    bare `catch {}` — the key could sit world-readable with nothing said. Never swallow
 *    it, and verify the result instead of assuming it took.
 */
import { existsSync, writeFileSync, renameSync, chmodSync, unlinkSync, statSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

/** Where diagnostics go. Injectable so tests can assert on them. */
export type Warn = (message: string) => void;

const defaultWarn: Warn = (m) => process.stderr.write(m);

export function safeWriteProfile(path: string, data: unknown, warn: Warn = defaultWarn): void {
  const tmp = path + ".tmp";

  // Residue from an earlier crash would keep its own (possibly 0644) permissions.
  try {
    if (existsSync(tmp)) unlinkSync(tmp);
  } catch (e) {
    warn(`[agentchat] WARNING: stale ${tmp} could not be removed: ${e}\n`);
  }

  // Created fresh → `mode` actually applies, so the key is 0600 from the instant it exists.
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);

  try {
    chmodSync(path, 0o600);
  } catch (e) {
    warn(`[agentchat] WARNING: could not chmod ${path} to 0600: ${e}\n`);
  }

  try {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) {
      warn(
        `[agentchat] WARNING: ${path} is mode ${mode.toString(8)}, expected 600 — it holds your agent key. Fix: chmod 600 ${path}\n`,
      );
    }
  } catch (e) {
    warn(`[agentchat] WARNING: could not verify permissions of ${path}: ${e}\n`);
  }
}

export interface DefaultProfileCollision {
  collidingName: string;
  collidingPath: string;
  reason: "agent_id" | "display_name";
}

const NON_PROFILE_JSON_FILES = new Set([
  "session-binds.json",
  "agy-binds.json",
  "grok-binds.json",
  "grok-binds-meta.json",
  "grok-binds.meta.json",
  "identity-guard.json",
  "dsh.json",
  "config.json",
]);

/**
 * Enforce that `profile.json` never duplicates another named `<Name>.json` profile
 * (by `agent_id` or `display_name`). A duplicate `profile.json` creates an ambiguous
 * shadow alias that causes unconfigured/default boots to collide with a bound named
 * identity.
 */
export function findDefaultProfileCollision(
  configDir: string,
  defaultProfilePath: string,
): DefaultProfileCollision | null {
  if (!defaultProfilePath || !existsSync(defaultProfilePath)) return null;
  let defParsed: { agent_id?: unknown; display_name?: unknown; token?: unknown };
  try {
    defParsed = JSON.parse(readFileSync(defaultProfilePath, "utf8"));
  } catch {
    return null;
  }
  if (!defParsed || typeof defParsed !== "object" || Array.isArray(defParsed)) return null;
  const defAgentId = typeof defParsed.agent_id === "string" ? defParsed.agent_id.trim() : "";
  const defDisplayName =
    typeof defParsed.display_name === "string" ? defParsed.display_name.trim().toLowerCase() : "";
  if (!defAgentId && !defDisplayName) return null;

  const resolvedDefault = resolve(defaultProfilePath);
  for (const dir of [join(configDir, "profiles"), configDir]) {
    if (!existsSync(dir)) continue;
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const file of files) {
      if (NON_PROFILE_JSON_FILES.has(file)) continue;
      const candidatePath = join(dir, file);
      if (resolve(candidatePath) === resolvedDefault) continue;
      const baseName = file.replace(/\.json$/, "");
      if (baseName.toLowerCase() === "profile") continue;

      let candidate: { agent_id?: unknown; display_name?: unknown; token?: unknown };
      try {
        candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
      } catch {
        continue;
      }
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const candAgentId = typeof candidate.agent_id === "string" ? candidate.agent_id.trim() : "";
      const candToken = typeof candidate.token === "string" ? candidate.token.trim() : "";
      if (!candAgentId || !candToken) continue;

      if (defAgentId && candAgentId === defAgentId) {
        return { collidingName: baseName, collidingPath: candidatePath, reason: "agent_id" };
      }
      const candDisplayName =
        typeof candidate.display_name === "string" ? candidate.display_name.trim().toLowerCase() : "";
      if (
        defDisplayName &&
        (candDisplayName === defDisplayName || baseName.toLowerCase() === defDisplayName)
      ) {
        return { collidingName: baseName, collidingPath: candidatePath, reason: "display_name" };
      }
    }
  }
  return null;
}
