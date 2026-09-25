import { existsSync, mkdirSync, lstatSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Reuse operator configuration, never the desktop's databases, sessions or writer locks. */
export function prepareRuntimeHome(stateDir: string, source = process.env.CODEX_HOME || join(homedir(), ".codex")) {
  const legacyHome = existsSync(source) ? realpathSync(source) : resolve(source);
  const home = join(stateDir, "codex-home");
  mkdirSync(home, {recursive:true, mode:0o700});
  if (realpathSync(home) === legacyHome) throw new Error("Bot runtime home must differ from desktop Codex home");
  for (const name of ["config.toml", "auth.json", "AGENTS.md", "skills", "rules", "plugins", "hooks.json", "models_cache.json"]) {
    const origin = join(legacyHome, name), target = join(home, name);
    if (!existsSync(origin)) continue;
    let current;
    try { current = lstatSync(target); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    if (current) {
      if (!current.isSymbolicLink() || resolve(home, readlinkSync(target)) !== origin)
        throw new Error(`Unexpected bot runtime configuration: ${name}`);
    } else symlinkSync(origin, target);
  }
  return {home, legacyHome};
}
