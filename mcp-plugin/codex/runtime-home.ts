import { existsSync, mkdirSync, readdirSync, accessSync, constants, lstatSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import type { CodexHomeMode } from "./config.ts";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";

function executablePath(bin: string): string | undefined {
  const candidates = isAbsolute(bin) || bin.includes("/") ? [resolve(bin)] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(dir => join(dir, bin));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } catch { /* Try the next PATH entry. */ }
  }
}

/** Inspect metadata only; never follow a runtime-state link into another home. */
function assertIndependentTree(home: string, allowedAuthOrigin?: string, codexExecutable?: string) {
  if (lstatSync(home).isSymbolicLink()) throw new Error("Independent Codex home must not be a symlink");
  const inspect = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), info = lstatSync(path);
      if (info.isSymbolicLink()) {
        if (dir === home && name === "auth.json" && allowedAuthOrigin && resolve(home, readlinkSync(path)) === allowedAuthOrigin) continue;
        // Official Codex creates these executable aliases and SIGKILL can leave
        // them behind. Permit only the known shape and this launcher's exact binary.
        const local = relative(home, path).split(sep).join("/");
        if (codexExecutable && /^tmp\/arg0\/codex-arg0[A-Za-z0-9_-]+\/(apply_patch|applypatch|codex-execve-wrapper|codex-linux-sandbox)$/.test(local)) {
          try { if (realpathSync(path) === codexExecutable) continue; } catch { /* Broken alias: fail closed. */ }
        }
        throw new Error("Independent Codex home must not link configuration or runtime state");
      }
      if (info.isDirectory()) inspect(path);
    }
  };
  inspect(home);
}

/** Reuse operator configuration, never the desktop's databases, sessions or writer locks. */
export function prepareRuntimeHome(stateDir: string, source = process.env.CODEX_HOME || join(homedir(), ".codex"), mode: CodexHomeMode = "linked", codexBin = "codex") {
  if (mode !== "linked" && mode !== "isolated" && mode !== "auth-only") throw new Error("Invalid Codex home mode");
  // Isolated mode deliberately never inspects, copies or links source configuration.
  // Authentication must be set up independently by the operator, with permission.
  if (mode === "isolated") {
    const home = join(stateDir, "codex-home-isolated");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    assertIndependentTree(home, undefined, executablePath(codexBin));
    return { home: realpathSync(home) };
  }
  if (mode === "auth-only") {
    const legacyHome = realpathSync(source);
    const origin = join(legacyHome, "auth.json");
    if (!lstatSync(origin).isFile()) throw new Error("auth-only requires an existing regular auth.json; authorize its use explicitly");
    const home = join(stateDir, "codex-home-auth-only");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (lstatSync(home).isSymbolicLink() || realpathSync(home) === legacyHome) throw new Error("auth-only home must be independent");
    // A reused directory must not smuggle in unrelated configuration or plugins.
    for (const name of ["config.toml", "AGENTS.md", "rules", "plugins", "hooks.json"]) {
      try { lstatSync(join(home, name)); } catch (e: any) { if (e.code === "ENOENT") continue; throw e; }
      throw new Error("auth-only home contains unexpected configuration; use a fresh state root");
    }
    const skills = join(home, "skills");
    if (existsSync(skills) && (!lstatSync(skills).isDirectory() || readdirSync(skills).some(name => name !== ".system")))
      throw new Error("auth-only home contains unexpected custom skills");
    assertIndependentTree(home, origin, executablePath(codexBin));
    const target = join(home, "auth.json");
    try {
      if (!lstatSync(target).isSymbolicLink() || resolve(home, readlinkSync(target)) !== origin) throw new Error("Unexpected auth-only login binding");
    } catch (e: any) { if (e.code !== "ENOENT") throw e; symlinkSync(origin, target); }
    assertIndependentTree(home, origin, executablePath(codexBin));
    return { home: realpathSync(home) };
  }
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
