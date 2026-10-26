import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface ProjectProfileSelection {
  selector: string;
  source: "project-config" | "project-profile";
  agentId?: string;
  apiUrl?: string;
  wsUrl?: string;
}

/** Read only this project's binding. Never scan parents or choose a sibling bot. */
export function projectProfileSelector(cwd: string): ProjectProfileSelection | undefined {
  const config = join(cwd, ".agentschat/config.json");
  let doc: any = {};
  if (existsSync(config)) {
    try { doc = JSON.parse(readFileSync(config, "utf8")); }
    catch { throw new Error("Invalid project .agentschat/config.json; repair it before choosing an identity"); }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("Invalid project identity configuration");
    for (const field of ["profile", "agent_id", "api_url", "ws_url"]) {
      if (doc[field] !== undefined && (typeof doc[field] !== "string" || !doc[field].trim())) throw new Error(`Invalid project ${field}`);
    }
    for (const [field, protocols] of [["api_url", ["https:", "http:"]], ["ws_url", ["wss:", "ws:"]]] as const) {
      if (doc[field] === undefined) continue;
      let url: URL;
      try { url = new URL(doc[field]); } catch { throw new Error(`Invalid project ${field}`); }
      if (!(protocols as readonly string[]).includes(url.protocol) || url.username || url.password || url.search || url.hash ||
          (!url.protocol.endsWith("s:") && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
        throw new Error(`Invalid project ${field}: require TLS (except loopback) and no credentials/query`);
    }
  }
  const settings = {
    ...(doc.agent_id !== undefined ? { agentId: doc.agent_id as string } : {}),
    ...(doc.api_url !== undefined ? { apiUrl: doc.api_url as string } : {}),
    ...(doc.ws_url !== undefined ? { wsUrl: doc.ws_url as string } : {}),
  };
  if (doc.profile !== undefined) {
    const value = doc.profile as string;
    return { selector: !isAbsolute(value) && !value.startsWith("~/") && value.includes("/") ? resolve(cwd, value) : value, source: "project-config", ...settings };
  }
  const profile = join(cwd, ".agentschat/profile.json");
  if (existsSync(profile)) return { selector: profile, source: "project-profile", ...settings };
  // A declared agent/server scope must never silently disappear into a global identity.
  if (Object.keys(settings).length) throw new Error("Project identity/server settings require a profile binding");
}
