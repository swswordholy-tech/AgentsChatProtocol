// AgentsChat REST API client — HTTP queries for history, channels, agents

import type {
  AgentCard,
  ChatMessage,
  CloudAgentAuditFeed,
  CloudAgentAuditResult,
  DiscoverableChannelSummary,
  ParsedSseFramesResult,
} from "./types";

export function parseSseFrames(buffer: string, maxBufferChars = 262_144): ParsedSseFramesResult {
  const events: Record<string, unknown>[] = [];
  if (typeof buffer !== "string" || !buffer) {
    return { events, rest: "" };
  }
  let rest = buffer;
  let sepMatch: RegExpExecArray | null;
  while ((sepMatch = /\r?\n\r?\n/.exec(rest)) !== null) {
    const block = rest.slice(0, sepMatch.index);
    rest = rest.slice(sepMatch.index + sepMatch[0].length);
    const dataLines: string[] = [];
    for (const rawLine of block.split(/\r?\n/)) {
      if (!rawLine || rawLine.startsWith(":")) continue;
      if (rawLine.startsWith("data:")) {
        dataLines.push(rawLine.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n").trim();
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore malformed SSE blocks without poisoning subsequent frames
    }
  }
  const safeCap = Number.isFinite(maxBufferChars) && maxBufferChars > 0 ? Math.floor(maxBufferChars) : 262_144;
  if (rest.length > safeCap) {
    rest = "";
  }
  return { events, rest };
}

const VALID_EVIDENCE_KINDS = new Set([
  "commit",
  "deploy",
  "probe",
  "doc",
  "external",
  "rollout",
]);

export function classifyOkrCommentKind(
  text: string,
  explicitKind?: string,
): import("./types").OkrCommentKind {
  const raw = typeof text === "string" ? text : "";
  if (/^\s*\[SPEC\b/i.test(raw)) return "spec";
  if (explicitKind === "handoff" || /^\s*\[HANDOFF\b/i.test(raw)) return "handoff";
  if (explicitKind === "review" || /^\s*\[REVIEW\b/i.test(raw)) return "review";
  if (explicitKind === "blocker" || /^\s*\[BLOCK(?:ER|ED)?\b/i.test(raw)) return "blocker";
  if (explicitKind && explicitKind.trim()) return explicitKind.trim();
  return "note";
}

const ROSTER_ROLES = new Set(["member", "moderator", "admin"]);
const ROSTER_TYPES = new Set(["agent", "user", "unknown"]);
const ROSTER_SCOPES = new Set(["owned", "unclaimed", "external"]);
const SAFE_COLLAB_AGENT_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const CREDENTIAL_PREFIX_BASE_RE = /^(?:mcp_(?:at|rt|code)_|ac_|agent_key_|sk[-_]|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|(?:hf|npm)_)/i;
const CASE_SENSITIVE_CREDENTIAL_PREFIX_RE = /^(?:(?:AKIA|ASIA)[0-9A-Z]{16}|(?:AIza|eyJ)[A-Za-z0-9][A-Za-z0-9_.-]{7,})/;
const CREDENTIAL_PREFIX_RE = {
  test(value: string): boolean {
    return CREDENTIAL_PREFIX_BASE_RE.test(value) || CASE_SENSITIVE_CREDENTIAL_PREFIX_RE.test(value);
  },
};
const EMAIL_ID_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_ID_RE = /^\+?\d[\d ()-]{5,}\d$/;

function isSafeCollaborationAgentId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    SAFE_COLLAB_AGENT_ID_RE.test(id) &&
    !PROTOTYPE_POISON_KEYS.has(id.toLowerCase()) &&
    !/^mr_[0-9a-f]{16,}$/i.test(id) &&
    !id.includes("..") &&
    !CREDENTIAL_PREFIX_RE.test(id) &&
    !CASE_SENSITIVE_CREDENTIAL_PREFIX_RE.test(id) &&
    !JOINED_GRAPH_CREDENTIAL_ID_RE.test(id) &&
    !JOINED_GRAPH_AWS_KEY_ID_RE.test(id) &&
    !EMAIL_ID_RE.test(id) &&
    !PHONE_ID_RE.test(id)
  );
}

export function isValidCollaborationRoster(
  data: unknown,
): data is import("./types").ChannelCollaborationRosterResponse {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (d.source !== "collaboration" || !d.viewer || typeof d.viewer !== "object") return false;
  const viewer = d.viewer as Record<string, unknown>;
  if (
    typeof viewer.role !== "string" ||
    !ROSTER_ROLES.has(viewer.role) ||
    typeof viewer.is_member !== "boolean" ||
    typeof viewer.can_kick !== "boolean" ||
    typeof viewer.can_set_coordinator !== "boolean"
  ) {
    return false;
  }
  if (viewer.delegated_read_only !== undefined || viewer.delegated_via_agent_id !== undefined) {
    if (typeof viewer.delegated_read_only !== "boolean") return false;
    if (viewer.delegated_read_only === true) {
      if (
        viewer.role !== "member" ||
        viewer.is_member !== false ||
        viewer.can_kick !== false ||
        viewer.can_set_coordinator !== false ||
        !isSafeCollaborationAgentId(viewer.delegated_via_agent_id)
      ) {
        return false;
      }
    } else if (viewer.delegated_via_agent_id !== undefined && viewer.delegated_via_agent_id !== null) {
      return false;
    }
  }
  if (!Array.isArray(d.members) || d.members.length > 1000) return false;
  const seenRefs = new Set<string>();
  for (const raw of d.members) {
    if (!raw || typeof raw !== "object") return false;
    const m = raw as Record<string, unknown>;
    if (
      typeof m.member_ref !== "string" ||
      !/^mr_[0-9a-f]{64}$/.test(m.member_ref) ||
      seenRefs.has(m.member_ref) ||
      typeof m.type !== "string" ||
      !ROSTER_TYPES.has(m.type) ||
      typeof m.role !== "string" ||
      !ROSTER_ROLES.has(m.role) ||
      typeof m.display_name !== "string" ||
      !Array.isArray(m.capabilities) ||
      typeof m.online !== "boolean" ||
      typeof m.is_self !== "boolean" ||
      typeof m.can_mention !== "boolean" ||
      typeof m.can_kick !== "boolean" ||
      typeof m.can_set_coordinator !== "boolean"
    ) {
      return false;
    }
    if (m.type === "agent") {
      if (!isSafeCollaborationAgentId(m.agent_id)) return false;
    } else {
      if (m.agent_id !== m.member_ref || m.can_mention || m.can_set_coordinator) return false;
    }
    if (viewer.delegated_read_only === true && (m.can_mention || m.can_kick || m.can_set_coordinator)) {
      return false;
    }
    if (m.ownership_scope !== undefined && (m.type !== "agent" || typeof m.ownership_scope !== "string" || !ROSTER_SCOPES.has(m.ownership_scope))) {
      return false;
    }
    seenRefs.add(m.member_ref);
  }
  return d.coordinator_ref === null || (typeof d.coordinator_ref === "string" && seenRefs.has(d.coordinator_ref));
}

const WORKSPACE_GRAPH_SCOPES = new Set(["channel", "objective", "agent"]);
const PROTOTYPE_POISON_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const JOINED_GRAPH_CREDENTIAL_ID_RE =
  /(?:^|[^A-Za-z0-9])(?:mcp_(?:at|rt|code)_|ac_|agent_key_|sk[-_]|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|hf_|npm_|(?:Bearer|Basic)(?:[._-]|$))/i;
const JOINED_GRAPH_AWS_KEY_ID_RE = /(?:^|[^A-Za-z0-9])(?:(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])|(?:AIza|eyJ)[A-Za-z0-9][A-Za-z0-9_-]{7,})/;

function safeGraphId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 160 &&
    !PROTOTYPE_POISON_KEYS.has(value.toLowerCase()) &&
    !/^mr_[0-9a-f]{16,}$/i.test(value) &&
    !/[/\\?#&\s\u0000-\u001F\u007F]/.test(value) &&
    !value.includes("..") &&
    !CREDENTIAL_PREFIX_RE.test(value) &&
    !JOINED_GRAPH_CREDENTIAL_ID_RE.test(value) &&
    !JOINED_GRAPH_AWS_KEY_ID_RE.test(value) &&
    !EMAIL_ID_RE.test(value) &&
    !PHONE_ID_RE.test(value)
  );
}

function safeGraphCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 1_000_000)
    : 0;
}

export function summarizeWorkspaceGraphReadiness(
  graph: unknown,
): import("./types").WorkspaceGraphReadinessSummary | null {
  if (!graph || typeof graph !== "object") return null;
  const g = graph as Record<string, unknown>;
  if (!g.scope || typeof g.scope !== "object") return null;
  const scope = g.scope as Record<string, unknown>;
  if (
    typeof scope.type !== "string" ||
    !WORKSPACE_GRAPH_SCOPES.has(scope.type) ||
    !safeGraphId(scope.id) ||
    (scope.type === "channel" && DM_OR_DIRECT_CHANNEL_RE.test(scope.id))
  ) {
    return null;
  }
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges) || !Array.isArray(g.sections)) {
    return null;
  }

  const sectionSummaries = new Map<string, Record<string, unknown>>();
  for (const sec of g.sections) {
    if (sec && typeof sec === "object") {
      const s = sec as Record<string, unknown>;
      if (typeof s.id === "string" && s.summary && typeof s.summary === "object") {
        sectionSummaries.set(s.id, s.summary as Record<string, unknown>);
      }
    }
  }
  const okr = sectionSummaries.get("okr") ?? {};
  const docs = sectionSummaries.get("docs") ?? {};
  const dag = sectionSummaries.get("dag") ?? {};

  const readyTaskIds: string[] = [];
  const seenReady = new Set<string>();
  for (const rawNode of g.nodes.slice(0, 1000)) {
    if (!rawNode || typeof rawNode !== "object") continue;
    const node = rawNode as Record<string, unknown>;
    if (node.type === "task" && node.ready === true && safeGraphId(node.id) && !seenReady.has(node.id)) {
      seenReady.add(node.id);
      readyTaskIds.push(node.id);
    }
  }

  const unchangedReferenceCount = Array.isArray(g.referenced_unchanged_ids)
    ? new Set(g.referenced_unchanged_ids.slice(0, 5000).filter(safeGraphId)).size
    : 0;

  const isIncremental =
    typeof g.since === "string" &&
    g.since.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T/.test(g.since) &&
    Number.isFinite(Date.parse(g.since));

  const readyCount = Math.max(
    safeGraphCount(okr.ready_tasks),
    safeGraphCount(dag.ready_tasks),
    readyTaskIds.length,
  );

  const summary: import("./types").WorkspaceGraphReadinessSummary = {
    scope_type: scope.type as import("./types").WorkspaceGraphScopeType,
    scope_id: scope.id,
    active_objectives: safeGraphCount(okr.active_objectives),
    active_tasks: safeGraphCount(okr.active_tasks),
    doing_tasks: safeGraphCount(okr.doing_tasks),
    ready_tasks: readyCount,
    blocked_tasks: Math.max(safeGraphCount(okr.blocked_tasks), safeGraphCount(dag.blocked_tasks)),
    blocker_tasks: safeGraphCount(dag.blocker_tasks),
    unresolved_edges: safeGraphCount(dag.unresolved_edges),
    evidence_tasks: Math.max(safeGraphCount(okr.evidence_tasks), safeGraphCount(dag.evidence_tasks)),
    docs_count: safeGraphCount(docs.docs_count),
    skills_count: safeGraphCount(docs.skills_count),
    ready_task_ids: readyTaskIds,
    is_incremental: isIncremental,
    unchanged_reference_count: unchangedReferenceCount,
  };
  if (typeof okr.active_loops === "number" && Number.isSafeInteger(okr.active_loops) && okr.active_loops >= 0) {
    summary.active_loops = Math.min(okr.active_loops, 1_000_000);
  }
  if (
    typeof okr.unarmed_objectives === "number" &&
    Number.isSafeInteger(okr.unarmed_objectives) &&
    okr.unarmed_objectives >= 0
  ) {
    summary.unarmed_objectives = Math.min(okr.unarmed_objectives, 1_000_000);
  }
  return summary;
}

export function summarizeWorkspaceGraphHierarchy(
  graph: unknown,
): import("./types").WorkspaceGraphHierarchySummary | null {
  if (!graph || typeof graph !== "object") return null;
  const g = graph as Record<string, unknown>;
  if (!g.scope || typeof g.scope !== "object") return null;
  const scope = g.scope as Record<string, unknown>;
  if (
    typeof scope.type !== "string" ||
    !WORKSPACE_GRAPH_SCOPES.has(scope.type) ||
    !safeGraphId(scope.id) ||
    (scope.type === "channel" && DM_OR_DIRECT_CHANNEL_RE.test(scope.id))
  ) {
    return null;
  }
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges) || !Array.isArray(g.sections)) {
    return null;
  }

  let okr: Record<string, unknown> = {};
  for (const sec of g.sections) {
    if (sec && typeof sec === "object") {
      const s = sec as Record<string, unknown>;
      if (s.id === "okr" && s.summary && typeof s.summary === "object") {
        okr = s.summary as Record<string, unknown>;
        break;
      }
    }
  }

  const objectiveNodes = new Map<string, { id: string; title: string; status: string }>();
  const parentByObjId = new Map<string, string>();
  for (const rawNode of g.nodes.slice(0, 1000)) {
    if (!rawNode || typeof rawNode !== "object") continue;
    const node = rawNode as Record<string, unknown>;
    if (node.type !== "objective" || !safeGraphId(node.id) || objectiveNodes.has(node.id)) continue;
    const title = sanitizeOkrWatchText(node.title, 200) || node.id;
    const status = sanitizeOkrWatchText(node.status, 32) || "active";
    objectiveNodes.set(node.id, { id: node.id, title, status });
    if (safeGraphId(node.parent_id) && node.parent_id !== node.id) {
      parentByObjId.set(node.id, node.parent_id);
    }
  }

  for (const rawEdge of g.edges.slice(0, 4000)) {
    if (!rawEdge || typeof rawEdge !== "object") continue;
    const edge = rawEdge as Record<string, unknown>;
    if (edge.type !== "contains" || !Array.isArray(edge.from) || !Array.isArray(edge.to)) continue;
    if (edge.from[0] !== "objective" || edge.to[0] !== "objective") continue;
    const parentId = edge.from[1];
    const childId = edge.to[1];
    if (
      !safeGraphId(parentId) ||
      !safeGraphId(childId) ||
      parentId === childId ||
      !objectiveNodes.has(childId)
    ) {
      continue;
    }
    if (!parentByObjId.has(childId)) {
      parentByObjId.set(childId, parentId);
    }
  }

  const childCountByObjId = new Map<string, number>();
  for (const [, parentId] of parentByObjId.entries()) {
    childCountByObjId.set(parentId, (childCountByObjId.get(parentId) ?? 0) + 1);
  }

  const unchangedSet = new Set<string>(
    Array.isArray(g.referenced_unchanged_ids)
      ? g.referenced_unchanged_ids.slice(0, 5000).filter(safeGraphId)
      : [],
  );

  const computeLineage = (id: string): { depth: number; rootId: string | null } => {
    let depth = 1;
    let cur = id;
    let rootId = id;
    const seen = new Set<string>([id]);
    while (parentByObjId.has(cur) && depth < 3) {
      const next = parentByObjId.get(cur);
      if (!next || seen.has(next)) break;
      seen.add(next);
      depth += 1;
      cur = next;
      rootId = next;
    }
    return { depth, rootId: depth > 1 ? rootId : null };
  };

  const rootObjectiveIds: string[] = [];
  const nestedObjectiveIds: string[] = [];
  const unchangedParentIds = new Set<string>();
  const danglingParentIds = new Set<string>();
  const items: import("./types").WorkspaceGraphHierarchyItem[] = [];
  let maxObjectiveDepth = objectiveNodes.size > 0 ? 1 : 0;

  for (const [id, obj] of objectiveNodes.entries()) {
    const parentId = parentByObjId.get(id) ?? null;
    const { depth, rootId } = computeLineage(id);
    if (depth > maxObjectiveDepth) maxObjectiveDepth = depth;
    if (parentId) {
      nestedObjectiveIds.push(id);
      if (!objectiveNodes.has(parentId)) {
        if (unchangedSet.has(parentId)) unchangedParentIds.add(parentId);
        else danglingParentIds.add(parentId);
      }
    } else {
      rootObjectiveIds.push(id);
    }
    items.push({
      id,
      title: obj.title,
      status: obj.status,
      parent_id: parentId,
      root_id: rootId,
      depth,
      child_count: childCountByObjId.get(id) ?? 0,
      unchanged_parent: Boolean(parentId && !objectiveNodes.has(parentId) && unchangedSet.has(parentId)),
    });
  }

  items.sort((a, b) => a.depth - b.depth || b.child_count - a.child_count);

  const activeLoops =
    typeof okr.active_loops === "number" && Number.isSafeInteger(okr.active_loops) && okr.active_loops >= 0
      ? Math.min(okr.active_loops, 1_000_000)
      : null;
  const unarmedObjectives =
    typeof okr.unarmed_objectives === "number" &&
    Number.isSafeInteger(okr.unarmed_objectives) &&
    okr.unarmed_objectives >= 0
      ? Math.min(okr.unarmed_objectives, 1_000_000)
      : null;

  return {
    scope_type: scope.type as import("./types").WorkspaceGraphScopeType,
    scope_id: scope.id,
    root_objective_ids: rootObjectiveIds,
    nested_objective_ids: nestedObjectiveIds,
    max_objective_depth: maxObjectiveDepth,
    unchanged_parent_ids: [...unchangedParentIds],
    dangling_parent_ids: [...danglingParentIds],
    active_loops: activeLoops,
    unarmed_objectives: unarmedObjectives,
    items,
  };
}

const DM_OR_DIRECT_CHANNEL_RE = /^(?:dm[-_:]|direct(?:$|[-_:]))/i;
const EMBEDDED_SECRET_BASE_RE =
  /(?:^|[^A-Za-z0-9])(?:mcp_(?:at|rt|code)_[A-Za-z0-9_-]{6,}|ac_[A-Za-z0-9_+/\-=]{8,}|agent_key_[A-Za-z0-9_-]{6,}|sk[-_][A-Za-z0-9_-]{12,}|rk_(?:live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:hf|npm)_[A-Za-z0-9]{12,}|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)/i;
const EMBEDDED_SECRET_TOKEN_RE = {
  test(value: string): boolean {
    return EMBEDDED_SECRET_BASE_RE.test(value) || JOINED_GRAPH_AWS_KEY_ID_RE.test(value);
  },
};

const RESERVED_OR_INTRANET_SUFFIXES = [
  ".internal",
  ".local",
  ".home.arpa",
  ".corp",
  ".lan",
  ".home",
  ".localdomain",
  ".invalid",
  ".test",
  ".example",
];

function parseSdkIpv4Part(part: string): number | null {
  if (!part) return null;
  if (/^0x[0-9a-f]+$/i.test(part)) {
    const v = Number.parseInt(part.slice(2), 16);
    return Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff ? v : null;
  }
  if (/^0[0-7]+$/.test(part)) {
    const v = Number.parseInt(part, 8);
    return Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff ? v : null;
  }
  if (/^\d+$/.test(part)) {
    const v = Number.parseInt(part, 10);
    return Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff ? v : null;
  }
  return null;
}

function parseSdkIpv4Octets(host: string): [number, number, number, number] | "invalid" | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  if (!parts.every((p) => /^(?:0x[0-9a-f]+|\d+)$/i.test(p))) return null;
  const nums = parts.map(parseSdkIpv4Part);
  if (nums.some((n) => n === null)) return "invalid";
  const vals = nums as number[];
  let ip32 = 0;
  if (vals.length === 1) {
    ip32 = vals[0];
  } else if (vals.length === 2) {
    if (vals[0] > 255 || vals[1] > 0xffffff) return "invalid";
    ip32 = ((vals[0] << 24) >>> 0) + vals[1];
  } else if (vals.length === 3) {
    if (vals[0] > 255 || vals[1] > 255 || vals[2] > 0xffff) return "invalid";
    ip32 = ((vals[0] << 24) >>> 0) + (vals[1] << 16) + vals[2];
  } else {
    if (vals.some((v) => v > 255)) return "invalid";
    ip32 = ((vals[0] << 24) >>> 0) + (vals[1] << 16) + (vals[2] << 8) + vals[3];
  }
  return [(ip32 >>> 24) & 255, (ip32 >>> 16) & 255, (ip32 >>> 8) & 255, ip32 & 255];
}

function isPrivateOrReservedIpv4Octets([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function parseSdkIpv6Words(raw: string): number[] | null {
  if (!raw.includes(":")) return null;
  let working = raw;
  const lastColon = working.lastIndexOf(":");
  if (lastColon !== -1 && working.slice(lastColon + 1).includes(".")) {
    const tailOctets = parseSdkIpv4Octets(working.slice(lastColon + 1));
    if (!tailOctets || tailOctets === "invalid") return null;
    const hi = ((tailOctets[0] << 8) | tailOctets[1]).toString(16);
    const lo = ((tailOctets[2] << 8) | tailOctets[3]).toString(16);
    working = `${working.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const dblParts = working.split("::");
  if (dblParts.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const out: number[] = [];
    for (const seg of side.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(seg)) return null;
      out.push(Number.parseInt(seg, 16));
    }
    return out;
  };
  if (dblParts.length === 2) {
    const left = parseSide(dblParts[0]);
    const right = parseSide(dblParts[1]);
    if (!left || !right || left.length + right.length >= 8) return null;
    return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
  }
  const full = parseSide(working);
  return full && full.length === 8 ? full : null;
}

function sdkWordsToIpv4(hi: number, lo: number): [number, number, number, number] {
  return [(hi >>> 8) & 255, hi & 255, (lo >>> 8) & 255, lo & 255];
}

/**
 * Pure SSRF host classifier shared across SDK outbound URL validators
 * (webhooks, BYOK `/models` endpoint probes, story media/blueprint URLs, and QR handoff links).
 * Returns `true` when `rawHostname` is empty, malformed, single-label, loopback, RFC1918,
 * CGNAT (`100.64.0.0/10`), link-local, NAT64/6to4/mapped private IPv6, multicast, or a reserved TLD.
 */
export function isPrivateOrReservedHost(rawHostname: string): boolean {
  if (typeof rawHostname !== "string") return true;
  let host = rawHostname.trim().toLowerCase();
  if (host.endsWith(".")) host = host.replace(/\.+$/, "");
  if (!host) return true;
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
    if (host.endsWith(".")) host = host.replace(/\.+$/, "");
    if (!host) return true;
  }
  if (host.includes("%") || /[\s\u0000-\u001f\u007f/\\?#]/.test(host)) return true;

  const v6 = parseSdkIpv6Words(host);
  if (v6) {
    const isZeroPrefix5 = v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0;
    if (isZeroPrefix5 && v6[5] === 0 && v6[6] === 0 && (v6[7] === 0 || v6[7] === 1)) return true;
    if (isZeroPrefix5 && (v6[5] === 0xffff || v6[5] === 0)) {
      return isPrivateOrReservedIpv4Octets(sdkWordsToIpv4(v6[6], v6[7]));
    }
    if (v6[0] === 0x0064 && v6[1] === 0xff9b && (v6[2] === 0 || v6[2] === 1)) {
      if (isPrivateOrReservedIpv4Octets(sdkWordsToIpv4(v6[6], v6[7]))) return true;
    }
    if (v6[0] === 0x2002) {
      if (isPrivateOrReservedIpv4Octets(sdkWordsToIpv4(v6[1], v6[2]))) return true;
    }
    if ((v6[0] & 0xfe00) === 0xfc00) return true;
    if ((v6[0] & 0xffc0) === 0xfe80) return true;
    if ((v6[0] & 0xff00) === 0xff00) return true;
    if (v6[0] === 0x0100 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0) return true;
    return false;
  }
  if (host.includes(":")) return true;

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (!host.includes(".")) return true;

  const v4 = parseSdkIpv4Octets(host);
  if (v4 === "invalid") return true;
  if (v4) return isPrivateOrReservedIpv4Octets(v4);

  for (const suffix of RESERVED_OR_INTRANET_SUFFIXES) {
    if (host.endsWith(suffix) || host === suffix.slice(1)) return true;
  }
  return false;
}

function isPrivateOrLoopbackHostname(rawHostname: string): boolean {
  return isPrivateOrReservedHost(rawHostname);
}

function isSafePublicHttpsUrl(rawUrl: unknown, maxLen = 500): rawUrl is string {
  if (typeof rawUrl !== "string") return false;
  const trimmed = rawUrl.trim();
  if (
    !trimmed ||
    trimmed.length > maxLen ||
    /[\u0000-\u001F\u007F\s]/.test(trimmed) ||
    CREDENTIAL_PREFIX_RE.test(trimmed) ||
    EMBEDDED_SECRET_TOKEN_RE.test(trimmed)
  ) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return false;
  }
  return !isPrivateOrLoopbackHostname(parsed.hostname);
}

function scrubStoryDisplayText(raw: unknown, maxLen: number): string {
  if (typeof raw !== "string") return "";
  const bounded = raw.length > 65_536 ? raw.slice(0, 65_536) : raw;
  return bounded
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi, "[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]")
    .replace(
      /(?:^|[^A-Za-z0-9])(?:mcp_(?:at|rt|code)_|ac_[A-Za-z0-9_+/\-=]{8,}|agent_key_|sk[-_]|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|(?:hf|npm)_)[A-Za-z0-9_+/\-=.-]*/gi,
      (m) => (/[A-Za-z0-9]/.test(m.charAt(0)) ? "[redacted]" : `${m.charAt(0)}[redacted]`),
    )
    .replace(/(?:^|[^A-Za-z0-9])AIza[A-Za-z0-9][A-Za-z0-9_+/\-=.-]{7,}/g, (m) =>
      /[A-Za-z0-9]/.test(m.charAt(0)) ? "[redacted]" : `${m.charAt(0)}[redacted]`,
    )
    .replace(/(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?=$|[^A-Za-z0-9])/g, (m) =>
      /[A-Za-z0-9]/.test(m.charAt(0)) ? "[redacted]" : `${m.charAt(0)}[redacted]`,
    )
    .replace(/(?:^|[^A-Za-z0-9])mr_[0-9a-f]{16,}/gi, (m) =>
      /[A-Za-z0-9]/.test(m.charAt(0)) ? "[redacted]" : `${m.charAt(0)}[redacted]`,
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g, "[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]")
    .replace(/\+?\d[\d\s()-]{5,}\d/g, "[redacted]")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, " ")
    .trim()
    .slice(0, maxLen);
}

const STORY_PLATFORMS: ReadonlyArray<import("./types").StoryPlatformKey> = [
  "x",
  "threads",
  "wechat",
  "tiktok_hook",
];
const VALID_STORY_TYPES_SET = new Set<import("./types").StoryArtifactType>([
  "debug_war_room",
  "agent_debate",
  "build_log",
  "brainstorm",
]);
const VALID_STORY_BLUEPRINTS_SET = new Set<import("./types").StoryBlueprintId>([
  "cross-review",
  "okr-sprint",
  "research-patrol",
]);

/**
 * Pure zero-I/O room blueprint resolver mirroring `src/story.ts`:
 * honors channel `{ name, topic }` hints before falling back to `storyType` defaults.
 */
export function resolveStoryBlueprintId(
  storyType: import("./types").StoryArtifactType,
  channelContext?: { name?: string; topic?: string } | null,
): import("./types").StoryBlueprintId {
  const hay = `${channelContext?.name ?? ""} ${channelContext?.topic ?? ""}`.toLowerCase();
  if (/(?:\bokr\b|okr-sprint|冲刺作战室|okr\s*sprint)/i.test(hay)) return "okr-sprint";
  if (/(?:cross-review|交叉互审|peer[\s-]*review|code[\s-]*review)/i.test(hay)) return "cross-review";
  if (/(?:research-patrol|情报雷达|research\s*&?\s*patrol)/i.test(hay)) return "research-patrol";
  if (storyType === "build_log") return "okr-sprint";
  if (storyType === "brainstorm") return "research-patrol";
  return "cross-review";
}

export function resolveStoryBlueprintUrl(
  storyType: import("./types").StoryArtifactType,
  channelContext?: { name?: string; topic?: string } | null,
): string {
  const bp = resolveStoryBlueprintId(storyType, channelContext);
  return `https://agents-chat.com/lobby?blueprint=${bp}`;
}

export function summarizeStoryArtifactBundle(
  raw: unknown,
): import("./types").StoryArtifactSafetySummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const res = raw as Record<string, unknown>;
  const artifactId = typeof res.artifact_id === "string" ? res.artifact_id.trim() : "";
  if (
    !safeGraphId(artifactId) ||
    /^mr_[0-9a-f]{16,}$/i.test(artifactId) ||
    PROTOTYPE_POISON_KEYS.has(artifactId.toLowerCase()) ||
    EMBEDDED_SECRET_TOKEN_RE.test(artifactId)
  ) {
    return null;
  }
  const story =
    res.story_json && typeof res.story_json === "object" && !Array.isArray(res.story_json)
      ? (res.story_json as Record<string, unknown>)
      : null;
  if (!story) return null;
  if (story.id !== undefined && story.id !== artifactId) return null;

  const ch =
    story.channel && typeof story.channel === "object" && !Array.isArray(story.channel)
      ? (story.channel as Record<string, unknown>)
      : null;
  const channelId = typeof ch?.id === "string" ? ch.id.trim() : "";
  if (
    !safeNonDmChannelId(channelId) ||
    /^mr_[0-9a-f]{16,}$/i.test(channelId) ||
    PROTOTYPE_POISON_KEYS.has(channelId.toLowerCase()) ||
    /^\d{6,}$/.test(channelId)
  ) {
    return null;
  }

  const storyType = story.story_type as import("./types").StoryArtifactType;
  if (!VALID_STORY_TYPES_SET.has(storyType)) return null;

  const defaultBp = resolveStoryBlueprintId(storyType, {
    name: typeof ch?.name === "string" ? ch.name : undefined,
    topic: typeof ch?.topic === "string" ? ch.topic : undefined,
  });
  const rawBp = typeof res.blueprint_id === "string" ? res.blueprint_id.trim() : "";
  const blueprintId = VALID_STORY_BLUEPRINTS_SET.has(rawBp as any)
    ? (rawBp as import("./types").StoryBlueprintId)
    : defaultBp;
  const blueprintUrl = isSafePublicHttpsUrl(res.blueprint_url, 500)
    ? res.blueprint_url.trim()
    : `https://agents-chat.com/lobby?blueprint=${blueprintId}`;

  const coverPngUrl = isSafePublicHttpsUrl(res.cover_png_url, 1024) ? res.cover_png_url.trim() : null;
  const fullStoryPngUrl = isSafePublicHttpsUrl(res.full_story_png_url, 1024)
    ? res.full_story_png_url.trim()
    : null;

  const seenTurnIds = new Set<string>();
  for (const item of Array.isArray(story.turns) ? story.turns.slice(0, 64) : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const mid = typeof (item as any).message_id === "string" ? (item as any).message_id.trim() : "";
    if (
      !safeGraphId(mid) ||
      /^mr_[0-9a-f]{16,}$/i.test(mid) ||
      PROTOTYPE_POISON_KEYS.has(mid.toLowerCase()) ||
      EMBEDDED_SECRET_TOKEN_RE.test(mid)
    ) {
      continue;
    }
    seenTurnIds.add(mid);
  }

  const seenCastIds = new Set<string>();
  for (const item of Array.isArray(story.cast) ? story.cast.slice(0, 64) : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const cid = typeof (item as any).id === "string" ? (item as any).id.trim() : "";
    if (
      !safeGraphId(cid) ||
      /^mr_[0-9a-f]{16,}$/i.test(cid) ||
      PROTOTYPE_POISON_KEYS.has(cid.toLowerCase()) ||
      EMBEDDED_SECRET_TOKEN_RE.test(cid)
    ) {
      continue;
    }
    seenCastIds.add(cid);
  }

  const rawStatus = typeof res.rendering_status === "string" ? res.rendering_status.trim().toLowerCase() : "";
  const renderingStatus = /^[a-z][a-z0-9_-]{0,31}$/.test(rawStatus) ? rawStatus : "pending";

  const rawCaptions =
    res.suggested_captions && typeof res.suggested_captions === "object"
      ? (res.suggested_captions as Record<string, unknown>)
      : {};
  const rawBlocked =
    res.caption_blocked && typeof res.caption_blocked === "object"
      ? (res.caption_blocked as Record<string, unknown>)
      : {};

  const publishablePlatforms: import("./types").StoryPlatformKey[] = [];
  const blockedPlatforms: import("./types").StoryPlatformKey[] = [];
  const safeCaptions: import("./types").StorySuggestedCaptions = {
    x: "",
    threads: "",
    wechat: "",
    tiktok_hook: "",
  };

  for (const p of STORY_PLATFORMS) {
    if (rawBlocked[p] === true) {
      blockedPlatforms.push(p);
      continue;
    }
    const scrubbed = scrubStoryDisplayText(rawCaptions[p], 600);
    if (!scrubbed || scrubbed === "[redacted]") {
      blockedPlatforms.push(p);
      continue;
    }
    safeCaptions[p] = scrubbed;
    publishablePlatforms.push(p);
  }

  return {
    artifact_id: artifactId,
    channel_id: channelId,
    story_type: storyType,
    blueprint_id: blueprintId,
    blueprint_url: blueprintUrl,
    turn_count: seenTurnIds.size,
    cast_count: seenCastIds.size,
    rendering_status: renderingStatus,
    cover_png_url: coverPngUrl,
    full_story_png_url: fullStoryPngUrl,
    ready_to_share:
      renderingStatus === "ready" &&
      (coverPngUrl !== null || fullStoryPngUrl !== null) &&
      publishablePlatforms.length > 0 &&
      seenTurnIds.size > 0,
    publishable_platforms: publishablePlatforms,
    blocked_platforms: blockedPlatforms,
    safe_captions: safeCaptions,
  };
}

function isSafeCloudAuditAgentId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id) &&
    !id.includes("..") &&
    !PROTOTYPE_POISON_KEYS.has(id.toLowerCase()) &&
    !/^mr_[0-9a-f]{16,}$/i.test(id) &&
    !/^\d{6,}$/.test(id) &&
    !CREDENTIAL_PREFIX_RE.test(id) &&
    !JOINED_GRAPH_CREDENTIAL_ID_RE.test(id) &&
    !JOINED_GRAPH_AWS_KEY_ID_RE.test(id) &&
    !EMBEDDED_SECRET_TOKEN_RE.test(id) &&
    !EMAIL_ID_RE.test(id)
  );
}

export function summarizeCloudAgentAuditFeed(
  raw: unknown,
  expectedAgentId?: string,
): import("./types").CloudAgentAuditSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const feed = raw as Record<string, unknown>;
  if (feed.observation_only !== true || !Array.isArray(feed.entries) || feed.entries.length > 200) {
    return null;
  }
  const agentId = typeof feed.agent_id === "string" ? feed.agent_id.trim() : "";
  if (!isSafeCloudAuditAgentId(agentId)) return null;
  if (expectedAgentId !== undefined && agentId !== expectedAgentId) return null;

  const entries: Array<import("./types").CloudAgentAuditEntry & { is_replay_revocation: boolean }> = [];
  const seenIds = new Set<string>();
  let okCount = 0;
  let deniedCount = 0;
  let errorCount = 0;
  let replayRevocationCount = 0;
  let oauthDelegateCount = 0;
  let agentKeyCount = 0;
  let latestMs = -Infinity;
  let latestTs: string | null = null;

  for (const item of feed.entries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const id = scrubStoryDisplayText(row.id, 96).replace(/\s+/g, " ").trim();
    if (!id || PROTOTYPE_POISON_KEYS.has(id.toLowerCase()) || seenIds.has(id)) continue;
    const result = row.result;
    if (result !== "ok" && result !== "denied" && result !== "error") continue;
    seenIds.add(id);

    const status =
      typeof row.status === "number" && Number.isInteger(row.status) && row.status >= 100 && row.status <= 599
        ? row.status
        : 500;
    const rawTs = typeof row.ts === "string" ? row.ts.trim() : "";
    let ts = "";
    if (rawTs.length <= 64 && /^\d{4}-\d{2}-\d{2}T/.test(rawTs) && Number.isFinite(Date.parse(rawTs))) {
      const ms = Date.parse(rawTs);
      ts = new Date(ms).toISOString();
      if (ms > latestMs) {
        latestMs = ms;
        latestTs = ts;
      }
    }
    const rawPath = typeof row.path === "string" ? row.path.split("?")[0] ?? "/" : "/";
    const path = scrubStoryDisplayText(rawPath, 160).replace(/\s+/g, " ").trim() || "/";
    const method = scrubStoryDisplayText(row.method, 16).replace(/\s+/g, " ").trim() || "POST";
    const actor = scrubStoryDisplayText(row.actor, 96).replace(/\s+/g, " ").trim();
    const target = scrubStoryDisplayText(row.target, 96).replace(/\s+/g, " ").trim();
    const rawChannel = typeof row.channel === "string" ? row.channel.trim() : "";
    const channel = DM_OR_DIRECT_CHANNEL_RE.test(rawChannel)
      ? ""
      : scrubStoryDisplayText(rawChannel, 96).replace(/\s+/g, " ").trim();
    const action = typeof row.action === "string" ? scrubStoryDisplayText(row.action, 96).replace(/\s+/g, " ").trim() : undefined;
    const tool = typeof row.tool === "string" ? scrubStoryDisplayText(row.tool, 96).replace(/\s+/g, " ").trim() : undefined;
    const reason = typeof row.reason === "string" ? scrubStoryDisplayText(row.reason, 200).replace(/\s+/g, " ").trim() : undefined;
    const credentialKind =
      row.credential_kind === "oauth_delegate" || row.credential_kind === "agent_key" || row.credential_kind === "unknown"
        ? row.credential_kind
        : undefined;

    const isReplayRevocation =
      action === "oauth_refresh_replay_revoked" || (typeof reason === "string" && /replay_revoked/i.test(reason));

    if (result === "ok") okCount += 1;
    else if (result === "denied") deniedCount += 1;
    else errorCount += 1;
    if (isReplayRevocation) replayRevocationCount += 1;
    if (credentialKind === "oauth_delegate") oauthDelegateCount += 1;
    else if (credentialKind === "agent_key") agentKeyCount += 1;

    entries.push({
      id,
      ts,
      actor,
      target,
      channel,
      method,
      path,
      status,
      result,
      ...(action ? { action } : {}),
      ...(tool ? { tool } : {}),
      ...(credentialKind ? { credential_kind: credentialKind } : {}),
      ...(reason ? { reason } : {}),
      is_replay_revocation: isReplayRevocation,
    });
    if (entries.length >= 50) break;
  }

  return {
    agent_id: agentId,
    observation_only: true,
    total_entries: entries.length,
    ok_count: okCount,
    denied_count: deniedCount,
    error_count: errorCount,
    replay_revocation_count: replayRevocationCount,
    oauth_delegate_count: oauthDelegateCount,
    agent_key_count: agentKeyCount,
    latest_ts: latestTs,
    entries,
  };
}

function safeNonDmChannelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    !DM_OR_DIRECT_CHANNEL_RE.test(value) &&
    !EMBEDDED_SECRET_TOKEN_RE.test(value) &&
    safeGraphId(value)
  );
}

export function evaluateConsensusTally(
  decisions: ReadonlyArray<import("./types").VoteDecision>,
  totalVoters: number,
  rule: import("./types").ConsensusRule,
): import("./types").ConsensusTallyResult {
  const safeTotal = Number.isFinite(totalVoters) && totalVoters > 0 ? Math.floor(totalVoters) : 0;
  const safeRule: import("./types").ConsensusRule =
    rule === "super_majority" || rule === "unanimous" ? rule : "majority";
  let approveCount = 0;
  let rejectCount = 0;
  let abstainCount = 0;
  if (Array.isArray(decisions)) {
    for (const d of decisions) {
      if (d === "approve") approveCount += 1;
      else if (d === "reject") rejectCount += 1;
      else if (d === "abstain") abstainCount += 1;
    }
  }
  const votedCount = approveCount + rejectCount + abstainCount;
  const effectiveVoters = safeTotal - abstainCount;
  const effectiveForRequired = Math.max(0, effectiveVoters);
  const requiredApprovals =
    effectiveForRequired <= 0
      ? 0
      : safeRule === "super_majority"
        ? Math.ceil((effectiveForRequired * 2) / 3)
        : safeRule === "unanimous"
          ? effectiveForRequired
          : Math.floor(effectiveForRequired / 2) + 1;

  if (effectiveVoters <= 0) {
    return {
      passed: false,
      is_complete: votedCount >= safeTotal,
      approve_count: approveCount,
      reject_count: rejectCount,
      abstain_count: abstainCount,
      effective_voters: effectiveVoters,
      voted_count: votedCount,
      total_voters: safeTotal,
      required_approvals: requiredApprovals,
    };
  }

  let passed: boolean;
  let isComplete: boolean;
  switch (safeRule) {
    case "majority": {
      passed = approveCount / effectiveVoters > 0.5;
      const remaining = Math.max(0, safeTotal - votedCount);
      const canStillPass = (approveCount + remaining) / (effectiveVoters + remaining) > 0.5;
      const canStillFail = approveCount / (effectiveVoters + remaining) <= 0.5;
      isComplete = votedCount >= safeTotal || (passed && !canStillFail) || (!passed && !canStillPass);
      break;
    }
    case "super_majority": {
      passed = approveCount / effectiveVoters >= 2 / 3;
      isComplete = votedCount >= safeTotal;
      break;
    }
    case "unanimous": {
      passed = approveCount === effectiveVoters && rejectCount === 0;
      isComplete = rejectCount > 0 || votedCount >= safeTotal;
      break;
    }
  }

  return {
    passed,
    is_complete: isComplete,
    approve_count: approveCount,
    reject_count: rejectCount,
    abstain_count: abstainCount,
    effective_voters: effectiveVoters,
    voted_count: votedCount,
    total_voters: safeTotal,
    required_approvals: requiredApprovals,
  };
}

export function mergeUniqueProposalBallots(
  rawVotes: unknown,
): import("./types").NormalizedProposalBallot[] {
  if (!Array.isArray(rawVotes)) return [];
  const seen = new Map<string, import("./types").NormalizedProposalBallot>();
  for (const item of rawVotes.slice(0, 500)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const decision = row.decision;
    if (decision !== "approve" && decision !== "reject" && decision !== "abstain") continue;
    const rawVoter = row.voter_id ?? row.voterId;
    const voter = typeof rawVoter === "string" ? rawVoter.trim() : "";
    if (
      !voter ||
      voter.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(voter) ||
      PROTOTYPE_POISON_KEYS.has(voter.toLowerCase()) ||
      seen.has(voter)
    ) {
      continue;
    }
    const rawType = row.voter_type ?? row.voterType;
    const voterType: "human" | "agent" = rawType === "human" ? "human" : "agent";
    const rawReason = typeof row.reason === "string" ? row.reason.trim().slice(0, 2000) : "";
    seen.set(voter, {
      voter_id: voter,
      voter_type: voterType,
      decision,
      ...(rawReason ? { reason: rawReason } : {}),
    });
  }
  return [...seen.values()];
}

export function summarizeProposalsFeed(
  raw: unknown,
  nowMs?: number,
  expectedChannelId?: string,
): import("./types").ProposalsFeedSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const feed = raw as Record<string, unknown>;
  const channelId = typeof feed.channel_id === "string" ? feed.channel_id.trim() : "";
  if (
    !safeNonDmChannelId(channelId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channelId) ||
    !Array.isArray(feed.proposals) ||
    feed.proposals.length > 500
  ) {
    return null;
  }
  if (expectedChannelId !== undefined) {
    const trimmedExpected = typeof expectedChannelId === "string" ? expectedChannelId.trim() : "";
    if (trimmedExpected !== channelId) return null;
  }
  const refNow = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  const canPropose = feed.can_propose === false || feed.read_only === true ? false : true;

  let pendingCount = 0;
  let passedCount = 0;
  let rejectedCount = 0;
  let expiredCount = 0;
  let ballotRationaleCount = 0;
  const pendingIds: string[] = [];
  const seenIds = new Set<string>();

  for (const item of feed.proposals) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const p = item as Record<string, unknown>;
    const pid = typeof p.id === "string" ? p.id.trim() : "";
    if (!safeGraphId(pid) || EMBEDDED_SECRET_TOKEN_RE.test(pid) || seenIds.has(pid)) continue;
    if (p.channel_id !== undefined && String(p.channel_id).trim() !== channelId) continue;
    seenIds.add(pid);

    let status: import("./types").ChannelProposalStatus =
      p.status === "passed" || p.status === "rejected" || p.status === "expired" ? p.status : "pending";
    if (status === "pending" && typeof p.expires_at === "string" && p.expires_at.trim()) {
      const expMs = Date.parse(p.expires_at);
      if (!Number.isFinite(expMs) || expMs <= refNow) {
        status = "expired";
      }
    }

    if (status === "passed") passedCount += 1;
    else if (status === "rejected") rejectedCount += 1;
    else if (status === "expired") expiredCount += 1;
    else {
      pendingCount += 1;
      pendingIds.push(pid);
    }

    if (Array.isArray(p.votes)) {
      const seenVoters = new Set<string>();
      for (const v of p.votes.slice(0, 200)) {
        if (!v || typeof v !== "object" || Array.isArray(v)) continue;
        const vote = v as Record<string, unknown>;
        if (vote.decision !== "approve" && vote.decision !== "reject" && vote.decision !== "abstain") continue;
        const voterKey = typeof vote.voter_id === "string" && vote.voter_id.trim() ? vote.voter_id.trim() : "";
        if (
          !voterKey ||
          PROTOTYPE_POISON_KEYS.has(voterKey.toLowerCase()) ||
          /^mr_[0-9a-f]{16,}$/i.test(voterKey) ||
          CREDENTIAL_PREFIX_RE.test(voterKey) ||
          CASE_SENSITIVE_CREDENTIAL_PREFIX_RE.test(voterKey) ||
          JOINED_GRAPH_CREDENTIAL_ID_RE.test(voterKey) ||
          JOINED_GRAPH_AWS_KEY_ID_RE.test(voterKey) ||
          EMBEDDED_SECRET_TOKEN_RE.test(voterKey) ||
          seenVoters.has(voterKey)
        ) {
          continue;
        }
        seenVoters.add(voterKey);
        if (typeof vote.reason === "string" && vote.reason.trim().length > 0) {
          ballotRationaleCount += 1;
        }
      }
    }
  }

  return {
    channel_id: channelId,
    can_propose: canPropose,
    read_only: !canPropose,
    total_proposals: seenIds.size,
    pending_count: pendingCount,
    passed_count: passedCount,
    rejected_count: rejectedCount,
    expired_count: expiredCount,
    pending_ids: pendingIds,
    ballot_rationale_count: ballotRationaleCount,
  };
}

const VALID_DOC_KINDS_SET = new Set<import("./types").ChannelDocKind>([
  "topic",
  "rules",
  "roles",
  "context",
  "deep_dive",
  "skill",
  "channel_skill",
]);

const CHANNEL_DOC_CREDENTIAL_ID_RE =
  /(?:^|[^A-Za-z0-9])(?:mr_[0-9a-f]{16,}$|mcp_(?:at|rt|code)_|ac_|agent_key_|sk[-_]|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|(?:AKIA|ASIA)(?:$|[A-Za-z0-9])|(?:hf|npm)_|(?:AIza|eyJ)(?:$|[A-Za-z0-9]))/i;

const LEADING_SKILL_FRONTMATTER_RE = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?=\r?\n|$)/;

/**
 * Pure zero-I/O YAML frontmatter parser for Channel Skills (`skill` / `channel_skill`)
 * and Personal Skills (`---\nname: ...\ndescription: ...\n---`), supporting both LF (`\n`),
 * CRLF (`\r\n`), and EOF `---` terminators while scrubbing embedded secrets/PII in metadata.
 */
export function parseChannelSkillFrontmatter(
  markdown: unknown,
): import("./types").ParsedChannelSkillFrontmatter {
  if (typeof markdown !== "string") {
    return { metadata: {}, body: "", is_valid_skill: false };
  }
  const match = markdown.match(LEADING_SKILL_FRONTMATTER_RE);
  if (!match) {
    return { metadata: {}, body: markdown, is_valid_skill: false };
  }
  const raw = match[1] ?? "";
  const body = markdown.slice(match[0].length).replace(/^\s*\r?\n/, "");
  const metadata: import("./types").ChannelSkillMetadata = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase().replace(/-/g, "_");
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "name" || key === "description" || key === "trigger" || key === "argument_hint") {
      const cap = key === "description" || key === "trigger" ? 500 : 160;
      const cleaned = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, " ").trim().slice(0, cap);
      if (cleaned) {
        metadata[key] = cleaned;
      }
    }
  }
  return {
    metadata,
    body,
    is_valid_skill: Boolean(metadata.name && metadata.description),
  };
}

function cleanDocText(raw: unknown, maxLen: number): string {
  if (typeof raw !== "string") return "";
  const bounded = raw.length > 65_536 ? raw.slice(0, 65_536) : raw;
  return bounded.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, " ").trim().slice(0, maxLen);
}

function isSafeChannelDocSlug(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const id = raw.trim();
  return (
    /^[A-Za-z0-9_-]{1,64}$/.test(id) &&
    !PROTOTYPE_POISON_KEYS.has(id.toLowerCase()) &&
    !CREDENTIAL_PREFIX_RE.test(id) &&
    !CHANNEL_DOC_CREDENTIAL_ID_RE.test(id) &&
    !EMBEDDED_SECRET_TOKEN_RE.test(id)
  );
}

export function summarizeChannelDocList(
  raw: unknown,
  expectedChannelId?: string,
): import("./types").ChannelDocListSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const channelId = typeof r.channel_id === "string" ? r.channel_id.trim() : "";
  if (
    !safeNonDmChannelId(channelId) ||
    PROTOTYPE_POISON_KEYS.has(channelId.toLowerCase()) ||
    CREDENTIAL_PREFIX_RE.test(channelId) ||
    EMBEDDED_SECRET_TOKEN_RE.test(channelId) ||
    /^\d{6,}$/.test(channelId)
  ) {
    return null;
  }
  if (expectedChannelId !== undefined && expectedChannelId.trim() !== channelId) {
    return null;
  }
  if (!Array.isArray(r.docs)) return null;

  const seenIds = new Set<string>();
  const docs: import("./types").ChannelDocSummaryItem[] = [];
  let activeCount = 0;
  let archivedCount = 0;
  let l1ActiveCount = 0;
  let skillCount = 0;

  for (const item of r.docs) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const d = item as Record<string, unknown>;
    const id = typeof d.id === "string" ? d.id.trim() : "";
    if (!isSafeChannelDocSlug(id) || seenIds.has(id)) continue;

    const kind = d.kind as import("./types").ChannelDocKind;
    if (!VALID_DOC_KINDS_SET.has(kind)) continue;
    const level = d.level as import("./types").ChannelDocLevel;
    if (level !== 1 && level !== 2 && level !== 3 && level !== 4) continue;
    if (typeof d.version !== "number" || !Number.isSafeInteger(d.version) || d.version < 1) continue;

    seenIds.add(id);
    const rawBodySummary =
      typeof d.bodySummary === "string"
        ? d.bodySummary
        : typeof d.body_summary === "string"
          ? d.body_summary
          : "";
    const archived = d.archived === true;
    const scrubbedTitle = cleanDocText(d.title, 120) || id;
    const scrubbedSummary = archived ? "" : cleanDocText(rawBodySummary, 280);
    const rawUpdatedAt =
      typeof d.updatedAt === "string"
        ? d.updatedAt.trim()
        : typeof d.updated_at === "string"
          ? d.updated_at.trim()
          : "";
    const updatedAt = /^\d{4}-\d{2}-\d{2}T/.test(rawUpdatedAt) ? rawUpdatedAt.slice(0, 64) : "";
    const rawUpdatedBy =
      typeof d.updatedBy === "string"
        ? d.updatedBy.trim()
        : typeof d.updated_by === "string"
          ? d.updated_by.trim()
          : "";
    const updatedBy =
      !rawUpdatedBy ||
      PROTOTYPE_POISON_KEYS.has(rawUpdatedBy.toLowerCase()) ||
      CREDENTIAL_PREFIX_RE.test(rawUpdatedBy) ||
      CHANNEL_DOC_CREDENTIAL_ID_RE.test(rawUpdatedBy) ||
      EMBEDDED_SECRET_TOKEN_RE.test(rawUpdatedBy) ||
      EMAIL_ID_RE.test(rawUpdatedBy) ||
      PHONE_ID_RE.test(rawUpdatedBy)
        ? "unknown"
        : rawUpdatedBy.replace(/[\x00-\x1f\x7f]+/g, "").slice(0, 128) || "unknown";

    let skillMeta: import("./types").ChannelDocSummaryItem["skill_meta"] | undefined;
    if (!archived && (kind === "skill" || kind === "channel_skill")) {
      if (d.skill_meta && typeof d.skill_meta === "object" && !Array.isArray(d.skill_meta)) {
        const sm = d.skill_meta as Record<string, unknown>;
        const smName = cleanDocText(sm.name, 160);
        const smDesc = cleanDocText(sm.description, 500);
        if (smName && smDesc) {
          const smTrigger = cleanDocText(sm.trigger, 500);
          const smHint = cleanDocText(sm.argument_hint, 160);
          skillMeta = {
            name: smName,
            description: smDesc,
            ...(smTrigger ? { trigger: smTrigger } : {}),
            ...(smHint ? { argument_hint: smHint } : {}),
          };
        }
      } else {
        const fallbackBody =
          typeof d.bodyMarkdown === "string"
            ? d.bodyMarkdown
            : typeof d.body_markdown === "string"
              ? d.body_markdown
              : "";
        const parsed = parseChannelSkillFrontmatter(fallbackBody);
        if (parsed.is_valid_skill) {
          skillMeta = parsed.metadata;
        }
      }
    }

    if (archived) {
      archivedCount += 1;
    } else {
      activeCount += 1;
      if (level === 1) l1ActiveCount += 1;
      if (skillMeta) skillCount += 1;
    }

    docs.push({
      id,
      title: scrubbedTitle,
      kind,
      level,
      bodySummary: scrubbedSummary,
      version: d.version,
      updatedAt,
      updatedBy,
      ...(archived ? { archived: true } : {}),
      ...(skillMeta ? { skill_meta: skillMeta } : {}),
    });
    if (docs.length >= 100) break;
  }

  docs.sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));

  return {
    channel_id: channelId,
    total_docs: docs.length,
    active_count: activeCount,
    archived_count: archivedCount,
    l1_active_count: l1ActiveCount,
    l1_remaining_slots: Math.max(0, 3 - l1ActiveCount),
    channel_remaining_slots: Math.max(0, 20 - activeCount),
    skill_count: skillCount,
    docs,
  };
}

export function summarizeChannelDocDetail(
  raw: unknown,
): import("./types").ChannelDocDetailSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  const id = typeof d.id === "string" ? d.id.trim() : "";
  if (!isSafeChannelDocSlug(id)) {
    return null;
  }
  const kind = d.kind as import("./types").ChannelDocKind;
  if (!VALID_DOC_KINDS_SET.has(kind)) return null;
  const level = d.level as import("./types").ChannelDocLevel;
  if (level !== 1 && level !== 2 && level !== 3 && level !== 4) return null;
  if (typeof d.version !== "number" || !Number.isSafeInteger(d.version) || d.version < 1) return null;
  const body =
    typeof d.bodyMarkdown === "string"
      ? d.bodyMarkdown
      : typeof d.body_markdown === "string"
        ? d.body_markdown
        : null;
  if (body === null) return null;

  const rawTitle =
    typeof d.title === "string" ? d.title.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 120) : "";
  const title = rawTitle || id;
  const archived = d.archived === true || body === "";

  let revisionCount = 0;
  if (Array.isArray(d.revisions)) {
    const seenVersions = new Set<number>();
    for (const r of d.revisions.slice(0, 100)) {
      if (!r || typeof r !== "object") continue;
      const ver = (r as Record<string, unknown>).version;
      if (typeof ver === "number" && Number.isSafeInteger(ver) && ver >= 1 && !seenVersions.has(ver)) {
        seenVersions.add(ver);
        revisionCount += 1;
      }
    }
  }

  const objectiveBacklinkIds: string[] = [];
  const krBacklinkIds: string[] = [];
  const taskBacklinkIds: string[] = [];
  const backlinks: import("./types").ChannelDocBacklinkItem[] = [];
  if (!archived && Array.isArray(d.backlinks)) {
    const seenBacklinks = new Set<string>();
    for (const item of d.backlinks) {
      if (!item || typeof item !== "object") continue;
      const bl = item as Record<string, unknown>;
      const blType =
        bl.type === "objective" || bl.type === "key_result" || bl.type === "task" ? bl.type : "";
      const blId = typeof bl.id === "string" ? bl.id.trim() : "";
      if (!blType || !safeGraphId(blId) || EMBEDDED_SECRET_TOKEN_RE.test(blId)) continue;
      const key = `${blType}:${blId}`;
      if (seenBacklinks.has(key)) continue;
      seenBacklinks.add(key);

      const rawBlTitle =
        typeof bl.title === "string" ? bl.title.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 120) : "";
      const blTitle = rawBlTitle || blId;
      backlinks.push({
        type: blType,
        id: blId,
        title: blTitle,
        relation: "linked_channel_docs",
      });
      if (blType === "objective") objectiveBacklinkIds.push(blId);
      else if (blType === "key_result") krBacklinkIds.push(blId);
      else taskBacklinkIds.push(blId);
      if (backlinks.length >= 100) break;
    }
  }

  return {
    id,
    title,
    kind,
    level,
    version: d.version,
    archived,
    revision_count: revisionCount,
    backlink_count: backlinks.length,
    objective_backlink_ids: objectiveBacklinkIds,
    kr_backlink_ids: krBacklinkIds,
    task_backlink_ids: taskBacklinkIds,
    backlinks,
  };
}

export function summarizeChannelThreads(
  raw: unknown,
): import("./types").ChannelThreadsSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const feed = raw as Record<string, unknown>;
  const channelId = typeof feed.channel_id === "string" ? feed.channel_id.trim() : "";
  if (
    !safeNonDmChannelId(channelId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channelId) ||
    !Array.isArray(feed.threads) ||
    feed.threads.length > 500
  ) {
    return null;
  }
  const seen = new Set<string>();
  const threads: import("./types").ChannelThreadSummaryItem[] = [];
  let totalReplies = 0;

  for (const item of feed.threads) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const parentId = typeof rec.parent_id === "string" ? rec.parent_id.trim() : "";
    if (
      !safeGraphId(parentId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(parentId) ||
      EMBEDDED_SECRET_TOKEN_RE.test(parentId) ||
      seen.has(parentId)
    ) {
      continue;
    }
    const replyCount =
      typeof rec.reply_count === "number" && Number.isFinite(rec.reply_count)
        ? Math.trunc(rec.reply_count)
        : 0;
    if (replyCount <= 0) continue;
    const parsedTs =
      typeof rec.last_reply_at === "string" && rec.last_reply_at.trim()
        ? Date.parse(rec.last_reply_at)
        : NaN;
    const lastReplyAt = Number.isFinite(parsedTs) ? new Date(parsedTs).toISOString() : "";
    const boundedCount = Math.min(replyCount, 100_000);
    seen.add(parentId);
    totalReplies += boundedCount;
    threads.push({
      parent_id: parentId,
      reply_count: boundedCount,
      last_reply_at: lastReplyAt,
    });
  }

  threads.sort(
    (a, b) =>
      b.last_reply_at.localeCompare(a.last_reply_at) ||
      b.reply_count - a.reply_count ||
      a.parent_id.localeCompare(b.parent_id),
  );

  let mostActiveParentId: string | null = null;
  let mostActiveReplies = 0;
  for (const th of threads) {
    if (th.reply_count > mostActiveReplies) {
      mostActiveReplies = th.reply_count;
      mostActiveParentId = th.parent_id;
    }
  }

  return {
    channel_id: channelId,
    total_threads: threads.length,
    total_replies: totalReplies,
    most_active_parent_id: mostActiveParentId,
    latest_reply_at: threads[0]?.last_reply_at ? threads[0].last_reply_at : null,
    threads,
  };
}

export function summarizeChannelPins(
  raw: unknown,
  expectedChannelId?: string,
): import("./types").ChannelPinsSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const feed = raw as Record<string, unknown>;
  const channelId = typeof feed.channel_id === "string" ? feed.channel_id.trim() : "";
  if (
    !safeNonDmChannelId(channelId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channelId) ||
    !Array.isArray(feed.pinned_messages) ||
    feed.pinned_messages.length > 500
  ) {
    return null;
  }
  if (expectedChannelId !== undefined) {
    const trimmedExpected = typeof expectedChannelId === "string" ? expectedChannelId.trim() : "";
    if (trimmedExpected !== channelId) return null;
  }
  const seen = new Set<string>();
  const pinnedMessages: string[] = [];
  for (const item of feed.pinned_messages) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (
      !safeGraphId(trimmed) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed) ||
      EMBEDDED_SECRET_TOKEN_RE.test(trimmed) ||
      seen.has(trimmed)
    ) {
      continue;
    }
    seen.add(trimmed);
    pinnedMessages.push(trimmed);
  }
  return {
    channel_id: channelId,
    total_pins: pinnedMessages.length,
    latest_pin_id: pinnedMessages.length > 0 ? pinnedMessages[pinnedMessages.length - 1]! : null,
    pinned_messages: pinnedMessages,
  };
}

function isSafeBriefCapabilityTag(cap: string): boolean {
  return (
    /^[a-z][a-z0-9:_-]{0,47}$/.test(cap) &&
    !cap.includes("..") &&
    !cap.includes("::") &&
    !PROTOTYPE_POISON_KEYS.has(cap) &&
    !CREDENTIAL_PREFIX_RE.test(cap) &&
    !EMBEDDED_SECRET_TOKEN_RE.test(cap)
  );
}

function sanitizeBriefSkillMeta(
  rawMeta: unknown,
): NonNullable<import("./types").ChannelBriefDocItem["skill_meta"]> {
  const out: NonNullable<import("./types").ChannelBriefDocItem["skill_meta"]> = {};
  if (!rawMeta || typeof rawMeta !== "object" || Array.isArray(rawMeta)) return out;
  const m = rawMeta as Record<string, unknown>;
  for (const key of ["name", "description", "trigger", "argument_hint"] as const) {
    if (typeof m[key] === "string") {
      const cleaned = m[key]
        .replace(/[\u0000-\u001F\u007F]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 256);
      if (cleaned) out[key] = cleaned;
    }
  }
  return out;
}

export function summarizeChannelBriefSkills(
  raw: unknown,
  expectedChannelId?: string,
): import("./types").ChannelBriefSkillsInventory | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const brief = raw as Record<string, unknown>;
  const channelId = typeof brief.channel_id === "string" ? brief.channel_id.trim() : "";
  if (
    !safeNonDmChannelId(channelId) ||
    PROTOTYPE_POISON_KEYS.has(channelId.toLowerCase()) ||
    EMBEDDED_SECRET_TOKEN_RE.test(channelId) ||
    !brief.channel ||
    typeof brief.channel !== "object"
  ) {
    return null;
  }
  if (expectedChannelId !== undefined && expectedChannelId.trim() !== channelId) {
    return null;
  }
  const chObj = brief.channel as Record<string, unknown>;
  if (
    chObj.id !== channelId ||
    (typeof chObj.type === "string" && chObj.type.trim().toLowerCase() === "direct")
  ) {
    return null;
  }

  const skillsObj =
    brief.skills_summary && typeof brief.skills_summary === "object"
      ? (brief.skills_summary as Record<string, unknown>)
      : null;

  const seenChannelIds = new Set<string>();
  const channelSkills: import("./types").ChannelBriefSkillsSummary["channel_skills"] = [];
  const triggersSet = new Set<string>();

  for (const item of Array.isArray(skillsObj?.channel_skills) ? skillsObj!.channel_skills : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const docId = typeof row.doc_id === "string" ? row.doc_id.trim() : "";
    if (
      !safeGraphId(docId) ||
      PROTOTYPE_POISON_KEYS.has(docId.toLowerCase()) ||
      EMBEDDED_SECRET_TOKEN_RE.test(docId) ||
      row.archived === true ||
      row.body_markdown === "" ||
      seenChannelIds.has(docId)
    ) {
      continue;
    }
    seenChannelIds.add(docId);
    const meta = sanitizeBriefSkillMeta(row.skill_meta);
    if (meta.trigger) triggersSet.add(meta.trigger);
    const version =
      typeof row.version === "number" && Number.isSafeInteger(row.version) && row.version >= 1
        ? row.version
        : undefined;
    channelSkills.push({
      doc_id: docId,
      skill_meta: meta,
      ...(version !== undefined ? { version } : {}),
      load_hint: `agentschat_read_channel_doc(channel_id=${JSON.stringify(channelId)}, doc_id=${JSON.stringify(docId)})`,
    });
    if (channelSkills.length >= 20) break;
  }

  const seenPersonalNames = new Set<string>();
  const personalSkills: import("./types").ChannelBriefSkillsSummary["personal_skills"] = [];
  for (const item of Array.isArray(skillsObj?.personal_skills) ? skillsObj!.personal_skills : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (
      !safeGraphId(name) ||
      PROTOTYPE_POISON_KEYS.has(name.toLowerCase()) ||
      EMBEDDED_SECRET_TOKEN_RE.test(name) ||
      row.archived === true ||
      row.body_markdown === "" ||
      seenPersonalNames.has(name)
    ) {
      continue;
    }
    seenPersonalNames.add(name);
    const meta = sanitizeBriefSkillMeta(row.skill_meta);
    if (meta.trigger) triggersSet.add(meta.trigger);
    const version =
      typeof row.version === "number" && Number.isSafeInteger(row.version) && row.version >= 1
        ? row.version
        : undefined;
    personalSkills.push({
      name,
      skill_meta: meta,
      ...(version !== undefined ? { version } : {}),
      load_hint: `GET /api/skills/${encodeURIComponent(name)}`,
    });
    if (personalSkills.length >= 50) break;
  }

  return {
    channel_id: channelId,
    channel_skill_count: channelSkills.length,
    personal_skill_count: personalSkills.length,
    personal_skills_unavailable: brief.personal_skills_unavailable === true,
    triggers: [...triggersSet].sort(),
    channel_skills: channelSkills,
    personal_skills: personalSkills,
  };
}

export function summarizeChannelBriefReadiness(
  raw: unknown,
): import("./types").ChannelBriefReadinessSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const brief = raw as Record<string, unknown>;
  const channelId = typeof brief.channel_id === "string" ? brief.channel_id.trim() : "";
  if (
    !safeNonDmChannelId(channelId) ||
    PROTOTYPE_POISON_KEYS.has(channelId.toLowerCase()) ||
    EMBEDDED_SECRET_TOKEN_RE.test(channelId) ||
    !brief.channel ||
    typeof brief.channel !== "object"
  ) {
    return null;
  }
  const chObj = brief.channel as Record<string, unknown>;
  if (
    chObj.id !== channelId ||
    (typeof chObj.type === "string" && chObj.type.trim().toLowerCase() === "direct")
  ) {
    return null;
  }

  const seenAgents = new Set<string>();
  let totalAgents = 0;
  let onlineAgents = 0;
  const capTotals = new Map<string, number>();
  const capOnline = new Map<string, number>();

  for (const item of Array.isArray(brief.agents) ? brief.agents.slice(0, 64) : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const ag = item as Record<string, unknown>;
    const id = typeof ag.id === "string" ? ag.id.trim() : "";
    if (
      !safeGraphId(id) ||
      PROTOTYPE_POISON_KEYS.has(id.toLowerCase()) ||
      EMBEDDED_SECRET_TOKEN_RE.test(id) ||
      seenAgents.has(id)
    ) {
      continue;
    }
    seenAgents.add(id);
    totalAgents += 1;
    const isOnline = ag.online === true;
    if (isOnline) onlineAgents += 1;
    const seenCaps = new Set<string>();
    for (const rawCap of Array.isArray(ag.capabilities) ? ag.capabilities.slice(0, 16) : []) {
      const cap = typeof rawCap === "string" ? rawCap.trim().toLowerCase() : "";
      if (!isSafeBriefCapabilityTag(cap) || seenCaps.has(cap)) {
        continue;
      }
      seenCaps.add(cap);
      capTotals.set(cap, (capTotals.get(cap) ?? 0) + 1);
      if (isOnline) capOnline.set(cap, (capOnline.get(cap) ?? 0) + 1);
    }
  }

  const specialties: import("./types").ChannelBriefSpecialtyItem[] = [...capTotals.entries()]
    .map(([capability, total_agents]) => ({
      capability,
      total_agents,
      online_agents: capOnline.get(capability) ?? 0,
    }))
    .sort(
      (a, b) =>
        b.online_agents - a.online_agents ||
        b.total_agents - a.total_agents ||
        a.capability.localeCompare(b.capability),
    )
    .slice(0, 16);

  const skillsInventory = summarizeChannelBriefSkills(raw, channelId);
  const channelSkillCount = skillsInventory?.channel_skill_count ?? 0;
  const personalSkillCount = skillsInventory?.personal_skill_count ?? 0;

  const okrObj =
    brief.okr_summary && typeof brief.okr_summary === "object"
      ? (brief.okr_summary as Record<string, unknown>)
      : null;
  const readyForMe =
    typeof okrObj?.ready_for_me_count === "number" &&
    Number.isFinite(okrObj.ready_for_me_count) &&
    okrObj.ready_for_me_count >= 0
      ? Math.trunc(okrObj.ready_for_me_count)
      : 0;

  const loopObj =
    brief.loop_summary && typeof brief.loop_summary === "object"
      ? (brief.loop_summary as Record<string, unknown>)
      : null;
  const unarmedObjectiveIds = Array.isArray(loopObj?.unarmed_objective_ids)
    ? [
        ...new Set(
          loopObj!.unarmed_objective_ids
            .filter((x): x is string => typeof x === "string")
            .map((x) => x.trim())
            .filter(
              (x) =>
                safeGraphId(x) &&
                !PROTOTYPE_POISON_KEYS.has(x.toLowerCase()) &&
                !EMBEDDED_SECRET_TOKEN_RE.test(x),
            ),
        ),
      ].slice(0, 25)
    : [];

  const wakeObj =
    brief.wake_health_summary &&
    typeof brief.wake_health_summary === "object" &&
    (brief.wake_health_summary as any).observation_only === true
      ? (brief.wake_health_summary as Record<string, unknown>)
      : null;
  const attentionAgentIds = Array.isArray(wakeObj?.attention_agents)
    ? [
        ...new Set(
          wakeObj!.attention_agents
            .filter((a: any) => {
              if (!a || typeof a !== "object") return false;
              if (
                typeof a.runtime === "string" &&
                !CLOUD_WAKE_RUNTIMES.has(a.runtime.trim() as import("./types").CloudWakeRuntimeType)
              ) {
                return false;
              }
              return true;
            })
            .map((a: any) => (typeof a?.agent_id === "string" ? a.agent_id.trim() : ""))
            .filter(
              (id: string) =>
                safeGraphId(id) &&
                !PROTOTYPE_POISON_KEYS.has(id.toLowerCase()) &&
                !EMBEDDED_SECRET_TOKEN_RE.test(id),
            ),
        ),
      ].slice(0, 16)
    : [];
  const countsObj =
    wakeObj?.counts && typeof wakeObj.counts === "object"
      ? (wakeObj.counts as Record<string, unknown>)
      : null;
  const degradedCount =
    ((typeof countsObj?.auth_required === "number" ? countsObj.auth_required : 0) || 0) +
    ((typeof countsObj?.timeout === "number" ? countsObj.timeout : 0) || 0) +
    ((typeof countsObj?.error === "number" ? countsObj.error : 0) || 0);

  return {
    channel_id: channelId,
    online_agent_count: onlineAgents,
    total_agent_count: totalAgents,
    specialties,
    channel_skill_count: channelSkillCount,
    personal_skill_count: personalSkillCount,
    personal_skills_unavailable: brief.personal_skills_unavailable === true,
    ready_for_me_count: readyForMe,
    unarmed_objective_ids: unarmedObjectiveIds,
    attention_agent_ids: attentionAgentIds,
    is_wake_healthy: attentionAgentIds.length === 0 && degradedCount === 0,
  };
}

const PERSONAL_SKILL_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const PERSONAL_SKILL_ACTIVE_QUOTA = 50;
const PERSONAL_SKILL_WEB_BYTE_CAP = 48_000;
const PERSONAL_SKILL_SERVER_BYTE_CAP = 100_000;

function isValidPersonalSkillSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    PERSONAL_SKILL_SLUG_RE.test(value) &&
    !value.includes("..") &&
    !PROTOTYPE_POISON_KEYS.has(value.toLowerCase()) &&
    !/(?:^|[^A-Za-z0-9])mr_[0-9a-f]{16,}$/i.test(value) &&
    !CREDENTIAL_PREFIX_RE.test(value) &&
    !JOINED_GRAPH_CREDENTIAL_ID_RE.test(value) &&
    !JOINED_GRAPH_AWS_KEY_ID_RE.test(value) &&
    !/^(?:AIza|eyJ)[A-Za-z0-9]/i.test(value) &&
    !/^xox[baprs]-/i.test(value) &&
    !EMBEDDED_SECRET_TOKEN_RE.test(value) &&
    !EMAIL_ID_RE.test(value) &&
    !PHONE_ID_RE.test(value)
  );
}

function cleanSkillFieldText(value: unknown, maxLen: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u001F\u007F]+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.slice(0, maxLen);
}

function hasValidSkillFrontmatter(markdown: string): boolean {
  return parseChannelSkillFrontmatter(markdown).is_valid_skill;
}

export function summarizePersonalSkillsLibrary(
  raw: unknown,
): import("./types").PersonalSkillsLibrarySummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const payload = raw as Record<string, unknown>;
  if (!Array.isArray(payload.skills) || payload.skills.length > 500) return null;

  const seenNames = new Set<string>();
  const triggersSet = new Set<string>();
  const items: import("./types").PersonalSkillCatalogItem[] = [];
  let activeCount = 0;
  let archivedCount = 0;
  let triggeredCount = 0;

  for (const entry of payload.skills) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!isValidPersonalSkillSlug(name) || seenNames.has(name)) continue;
    seenNames.add(name);

    const meta =
      row.skill_meta && typeof row.skill_meta === "object" && !Array.isArray(row.skill_meta)
        ? (row.skill_meta as Record<string, unknown>)
        : null;
    const version =
      typeof row.version === "number" && Number.isSafeInteger(row.version) && row.version >= 1
        ? row.version
        : 1;
    const archived = row.archived === true;
    const title = cleanSkillFieldText(row.title ?? meta?.name, 120) || name;
    const description = cleanSkillFieldText(row.description ?? meta?.description, 280);
    const triggerRaw = cleanSkillFieldText(meta?.trigger, 120);
    const trigger = triggerRaw || null;
    const argHintRaw = cleanSkillFieldText(meta?.argument_hint, 120);
    const argumentHint = argHintRaw || null;
    const updatedAt =
      typeof row.updated_at === "string" &&
      row.updated_at.length <= 64 &&
      /^\d{4}-\d{2}-\d{2}T/.test(row.updated_at) &&
      Number.isFinite(Date.parse(row.updated_at))
        ? row.updated_at
        : null;

    if (archived) {
      archivedCount += 1;
    } else {
      activeCount += 1;
      if (trigger) {
        triggeredCount += 1;
        triggersSet.add(trigger);
      }
    }

    items.push({
      name,
      title,
      description,
      trigger,
      argument_hint: argumentHint,
      version,
      archived,
      updated_at: updatedAt,
    });
  }

  items.sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    const aTime = a.updated_at ?? "";
    const bTime = b.updated_at ?? "";
    if (aTime !== bTime) return bTime.localeCompare(aTime);
    return a.name.localeCompare(b.name);
  });

  return {
    total_skills: items.length,
    active_count: activeCount,
    archived_count: archivedCount,
    remaining_active_quota: Math.max(0, PERSONAL_SKILL_ACTIVE_QUOTA - activeCount),
    triggered_count: triggeredCount,
    triggers: [...triggersSet].sort(),
    items,
  };
}

export function summarizePersonalSkillDetail(
  raw: unknown,
  expectedName?: string,
): import("./types").PersonalSkillDetailSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!isValidPersonalSkillSlug(name)) return null;
  if (expectedName !== undefined && expectedName.trim() !== name) return null;
  if (typeof row.body_markdown !== "string") return null;

  const meta =
    row.skill_meta && typeof row.skill_meta === "object" && !Array.isArray(row.skill_meta)
      ? (row.skill_meta as Record<string, unknown>)
      : null;
  const parsedFm = parseChannelSkillFrontmatter(row.body_markdown);
  const fm = parsedFm.is_valid_skill ? parsedFm.metadata : {};

  const version =
    typeof row.version === "number" && Number.isSafeInteger(row.version) && row.version >= 1
      ? row.version
      : 1;
  const archived = row.archived === true;
  const updatedAt =
    typeof row.updated_at === "string" &&
    row.updated_at.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T/.test(row.updated_at) &&
    Number.isFinite(Date.parse(row.updated_at))
      ? row.updated_at
      : null;

  const hasRedactedSecret = row.body_markdown === "[redacted]";
  const safeBody = archived
    ? ""
    : hasRedactedSecret
      ? "[redacted]"
      : row.body_markdown
          .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
          .slice(0, PERSONAL_SKILL_SERVER_BYTE_CAP);
  const utf8Bytes = new TextEncoder().encode(safeBody).byteLength;

  const title = cleanSkillFieldText(row.title ?? meta?.name ?? fm.name, 120) || name;
  const description = cleanSkillFieldText(row.description ?? meta?.description ?? fm.description, 280);
  const trigger = cleanSkillFieldText(meta?.trigger ?? fm.trigger, 120) || null;
  const argumentHint =
    cleanSkillFieldText(meta?.argument_hint ?? fm.argument_hint, 120) || null;

  return {
    name,
    title,
    description,
    trigger,
    argument_hint: argumentHint,
    version,
    archived,
    updated_at: updatedAt,
    body_markdown: safeBody,
    has_redacted_secret: hasRedactedSecret,
    utf8_bytes: utf8Bytes,
    web_editor_remaining_bytes: Math.max(0, PERSONAL_SKILL_WEB_BYTE_CAP - utf8Bytes),
    server_remaining_bytes: Math.max(0, PERSONAL_SKILL_SERVER_BYTE_CAP - utf8Bytes),
  };
}

const AGENT_MEMORY_DEFAULT_CAP = 20;
const AGENT_MEMORY_DEFAULT_BODY_CAP = 256_000;
const CLOUD_DIRECT_CHANNEL_RE = /^(?:dm[-_]|direct(?:$|[_:]))/i;
const CLOUD_WAKE_RUNTIMES = new Set<import("./types").CloudWakeRuntimeType>([
  "gemini",
  "claude",
  "codex",
  "hermes",
  "agy",
  "zcode",
  "dsh",
  "openclaw",
  "grok",
  "muse",
  "dot",
]);
const CLOUD_WAKE_AGENT_STATUSES = new Set([
  "active",
  "provisioning",
  "expired",
  "disabled",
]);
const CLOUD_WAKE_STATUSES = new Set<import("./types").CloudCliWakeStatus>([
  "ok",
  "auth_required",
  "timeout",
  "error",
]);

function scrubWakeAgentDisplayName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const bounded = raw.length > 65_536 ? raw.slice(0, 65_536) : raw;
  const cleaned = bounded
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi, "")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "")
    .replace(
      /(^|[^A-Za-z0-9])(?:mcp_(?:at|rt|code)_|ac_|agent_key_|sk[-_]|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|(?:hf|npm)_)[A-Za-z0-9_-]+/gi,
      "$1",
    )
    .replace(/(^|[^A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?=$|[^A-Za-z0-9])/g, "$1")
    .replace(/(^|[^A-Za-z0-9])(?:AIza[A-Za-z0-9][A-Za-z0-9_-]{7,}|eyJ[A-Za-z0-9][A-Za-z0-9_.-]{7,})/g, "$1")
    .replace(/\bmr_[0-9a-f]{16,}\b/gi, "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "")
    .replace(/\+?\d[\d\s()-]{4,}\d/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : undefined;
}

const CLOUD_HEALTH_EXPECTED_ACTIONS: Record<
  import("./types").CloudAgentHealthState,
  import("./types").CloudAgentRecoveryAction
> = {
  auth_required: "auth",
  rate_limited: "config",
  timeout: "config",
  paused: "config",
  error: "config",
  healthy: null,
};

const CLOUD_HEALTH_AUTH_MODES = new Set(["managed", "byok", "subscription"]);

export function classifyCloudAgentHealthState(
  raw: unknown,
  agentId?: unknown,
): import("./types").CloudAgentHealthStateSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  let state: import("./types").CloudAgentHealthState;
  let action: import("./types").CloudAgentRecoveryAction;

  if (v.status === undefined || v.status === null) {
    if (
      typeof v.state !== "string" ||
      !Object.prototype.hasOwnProperty.call(CLOUD_HEALTH_EXPECTED_ACTIONS, v.state)
    ) {
      return null;
    }
    const candidateState = v.state as import("./types").CloudAgentHealthState;
    const expectedAction = CLOUD_HEALTH_EXPECTED_ACTIONS[candidateState];
    if ((v.action ?? null) !== expectedAction) return null;
    state = candidateState;
    action = expectedAction;
  } else {
    if (
      typeof v.status !== "string" ||
      !CLOUD_WAKE_AGENT_STATUSES.has(v.status) ||
      typeof v.auth_mode !== "string" ||
      !CLOUD_HEALTH_AUTH_MODES.has(v.auth_mode) ||
      typeof v.subscription_pending !== "boolean" ||
      (v.last_wake_status !== undefined &&
        v.last_wake_status !== null &&
        (typeof v.last_wake_status !== "string" ||
          !CLOUD_WAKE_STATUSES.has(v.last_wake_status as import("./types").CloudCliWakeStatus)))
    ) {
      return null;
    }
    const wake = (v.last_wake_status as import("./types").CloudCliWakeStatus | null | undefined) ?? null;
    if (v.subscription_pending || wake === "auth_required") {
      state = "auth_required";
      action = "auth";
    } else if (v.status === "disabled") {
      state = "paused";
      action = "config";
    } else if (v.status === "expired") {
      state = "error";
      action = "config";
    } else if (wake === "error") {
      state = v.auth_mode === "subscription" ? "rate_limited" : "error";
      action = "config";
    } else if (wake === "timeout") {
      state = "timeout";
      action = "config";
    } else {
      state = "healthy";
      action = null;
    }
  }

  const safeId = typeof agentId === "string" && isSafeCloudRoomAgentId(agentId) ? agentId : null;
  const recovery_url =
    action && safeId ? `/cloud-agents?agent=${encodeURIComponent(safeId)}&action=${action}` : null;
  return { state, action, recovery_url };
}

export function summarizeChannelWakeHealth(
  raw: unknown,
): import("./types").ChannelWakeHealthDigest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const payload = raw as Record<string, unknown>;
  if (
    !safeNonDmChannelId(payload.channel_id) ||
    payload.observation_only !== true ||
    !Array.isArray(payload.agents) ||
    payload.agents.length > 500
  ) {
    return null;
  }

  const agents: import("./types").ChannelWakeHealthAgent[] = [];
  const seenIds = new Set<string>();
  const runtimesSet = new Set<import("./types").CloudWakeRuntimeType>();
  const attentionAgentIds: string[] = [];
  let ok = 0;
  let authRequired = 0;
  let timeout = 0;
  let error = 0;
  let unobserved = 0;

  for (const item of payload.agents) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const agentId = typeof row.agent_id === "string" ? row.agent_id.trim() : "";
    if (!isSafeCloudRoomAgentId(agentId) || seenIds.has(agentId)) continue;
    const runtime = typeof row.runtime === "string" ? row.runtime.trim() : "";
    if (!CLOUD_WAKE_RUNTIMES.has(runtime as import("./types").CloudWakeRuntimeType)) continue;
    const cloudStatus = typeof row.cloud_status === "string" ? row.cloud_status.trim() : "";
    if (!CLOUD_WAKE_AGENT_STATUSES.has(cloudStatus)) continue;

    seenIds.add(agentId);
    runtimesSet.add(runtime as import("./types").CloudWakeRuntimeType);

    const normalized: import("./types").ChannelWakeHealthAgent = {
      agent_id: agentId,
      runtime,
      cloud_status: cloudStatus,
    };
    const safeName = scrubWakeAgentDisplayName(row.name);
    if (safeName) normalized.name = safeName;

    const wakeStatus =
      typeof row.last_wake_status === "string" &&
      CLOUD_WAKE_STATUSES.has(row.last_wake_status as import("./types").CloudCliWakeStatus)
        ? (row.last_wake_status as import("./types").CloudCliWakeStatus)
        : undefined;
    if (wakeStatus) {
      normalized.last_wake_status = wakeStatus;
      if (wakeStatus === "ok") ok += 1;
      else if (wakeStatus === "auth_required") authRequired += 1;
      else if (wakeStatus === "timeout") timeout += 1;
      else error += 1;
    } else {
      unobserved += 1;
    }

    if (
      typeof row.last_wake_at === "string" &&
      row.last_wake_at.length <= 64 &&
      Number.isFinite(Date.parse(row.last_wake_at))
    ) {
      normalized.last_wake_at = row.last_wake_at;
    }
    if (
      typeof row.last_duration_ms === "number" &&
      Number.isFinite(row.last_duration_ms) &&
      row.last_duration_ms >= 0 &&
      row.last_duration_ms <= 86_400_000
    ) {
      normalized.last_duration_ms = Math.round(row.last_duration_ms);
    }

    if (cloudStatus === "disabled" || cloudStatus === "expired" || (wakeStatus && wakeStatus !== "ok")) {
      attentionAgentIds.push(agentId);
    }
    agents.push(normalized);
  }

  const degradedCount = authRequired + timeout + error;
  const observed = ok + degradedCount;
  const healthyRatio = observed > 0 ? Math.round((ok / observed) * 1000) / 1000 : 1;

  return {
    channel_id: payload.channel_id,
    observation_only: true,
    counts: {
      total_cloud_agents: agents.length,
      ok,
      auth_required: authRequired,
      timeout,
      error,
      unobserved,
    },
    degraded_count: degradedCount,
    healthy_ratio: healthyRatio,
    is_healthy: degradedCount === 0 && attentionAgentIds.length === 0,
    attention_agent_ids: attentionAgentIds,
    runtimes_present: [...runtimesSet].sort(),
    agents,
  };
}

function isSafeCloudRoomAgentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/.test(value) &&
    !PROTOTYPE_POISON_KEYS.has(value.toLowerCase()) &&
    !/^mr_[0-9a-f]{16,}$/i.test(value) &&
    !CREDENTIAL_PREFIX_RE.test(value) &&
    !JOINED_GRAPH_CREDENTIAL_ID_RE.test(value) &&
    !JOINED_GRAPH_AWS_KEY_ID_RE.test(value) &&
    !EMBEDDED_SECRET_TOKEN_RE.test(value)
  );
}

function isSafeCloudGroupChannelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(value) &&
    !PROTOTYPE_POISON_KEYS.has(value.toLowerCase()) &&
    !/^mr_[0-9a-f]{16,}$/i.test(value) &&
    !CLOUD_DIRECT_CHANNEL_RE.test(value) &&
    !DM_OR_DIRECT_CHANNEL_RE.test(value) &&
    !CREDENTIAL_PREFIX_RE.test(value) &&
    !JOINED_GRAPH_CREDENTIAL_ID_RE.test(value) &&
    !JOINED_GRAPH_AWS_KEY_ID_RE.test(value) &&
    !EMBEDDED_SECRET_TOKEN_RE.test(value)
  );
}

function isSafeCloudOkrChannelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{2,80}$/.test(value) &&
    isSafeCloudGroupChannelId(value)
  );
}

export function summarizeCloudAgentOkr(
  raw: unknown,
): import("./types").CloudAgentOkrWorkloadSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  let summaryObj: Record<string, unknown>;
  if ("okr_summary" in obj || "is_host" in obj) {
    if (obj.is_host !== false) return null;
    if (!obj.okr_summary || typeof obj.okr_summary !== "object" || Array.isArray(obj.okr_summary)) {
      return null;
    }
    summaryObj = obj.okr_summary as Record<string, unknown>;
  } else {
    summaryObj = obj;
  }

  const countFields = [
    summaryObj.doing_count,
    summaryObj.ready_count,
    summaryObj.waiting_count,
    summaryObj.blocked_count,
    summaryObj.done_count,
    summaryObj.owned_active_objectives,
  ];
  if (
    !countFields.every(
      (v): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000,
    )
  ) {
    return null;
  }
  const [doingCount, readyCount, waitingCount, blockedCount, doneCount, ownedActiveObjectives] =
    countFields as [number, number, number, number, number, number];

  const rawChannels = summaryObj.active_channel_ids;
  if (!Array.isArray(rawChannels) || rawChannels.length > 3) return null;
  const activeChannelIds: string[] = [];
  const seen = new Set<string>();
  for (const ch of rawChannels) {
    if (!isSafeCloudOkrChannelId(ch) || seen.has(ch)) return null;
    seen.add(ch);
    activeChannelIds.push(ch);
  }

  const actionableCount = doingCount + readyCount;
  const activeWorkloadCount =
    doingCount + readyCount + waitingCount + blockedCount + ownedActiveObjectives;

  return {
    doing_count: doingCount,
    ready_count: readyCount,
    waiting_count: waitingCount,
    blocked_count: blockedCount,
    done_count: doneCount,
    owned_active_objectives: ownedActiveObjectives,
    active_channel_ids: activeChannelIds,
    actionable_count: actionableCount,
    active_workload_count: activeWorkloadCount,
    is_idle: activeWorkloadCount === 0,
    primary_channel_id: activeChannelIds[0] ?? null,
  };
}

export function summarizeCloudAgentRoomPolicy(
  raw: unknown,
): import("./types").CloudAgentRoomPolicySummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const agentId = typeof rec.agent_id === "string" ? rec.agent_id.trim() : "";
  if (!isSafeCloudRoomAgentId(agentId)) return null;

  const cfg =
    rec.recovery_config && typeof rec.recovery_config === "object" && !Array.isArray(rec.recovery_config)
      ? (rec.recovery_config as Record<string, unknown>)
      : {};
  const isSubscription =
    cfg.auth_mode === "subscription" ||
    (typeof rec.credential_ref === "string" && rec.credential_ref.startsWith("subscription:"));
  const eligible =
    rec.is_host === false &&
    rec.status === "active" &&
    !Boolean(rec.deletion_pending) &&
    (!isSubscription || cfg.subscription_connected === true);

  const channelIds: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(rec.channels)) {
    for (const rawCh of rec.channels.slice(0, 200)) {
      if (typeof rawCh !== "string") continue;
      if (!isSafeCloudGroupChannelId(rawCh) || seen.has(rawCh)) continue;
      seen.add(rawCh);
      channelIds.push(rawCh);
    }
  }

  const defaultChannelId = channelIds.includes("welcome")
    ? "welcome"
    : (channelIds[0] ?? null);
  const removableChannelIds =
    eligible && channelIds.length > 1
      ? channelIds.filter((id) => id !== "welcome" && id !== defaultChannelId)
      : [];

  return {
    agent_id: agentId,
    eligible,
    channel_ids: channelIds,
    default_channel_id: defaultChannelId,
    removable_channel_ids: removableChannelIds,
    can_join_rooms: eligible,
    is_protected_only: channelIds.length > 0 && removableChannelIds.length === 0,
  };
}

const CUSTOM_SPECIALTY_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const CUSTOM_SPECIALTY_SECRET_IN_ID_RE =
  /(?:^|[^A-Za-z0-9])(?:ac_|agent_key_|sk[-_]|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AKIA|(?:hf|npm)_|AIza|eyJ)[A-Za-z0-9_+/=.-]*/i;

function sanitizeCustomSpecialtyTag(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const tag = raw.trim().toLowerCase();
  if (
    !CUSTOM_SPECIALTY_RE.test(tag) ||
    PROTOTYPE_POISON_KEYS.has(tag) ||
    CREDENTIAL_PREFIX_RE.test(tag) ||
    CUSTOM_SPECIALTY_SECRET_IN_ID_RE.test(tag)
  ) {
    return null;
  }
  return tag;
}

export function summarizeCloudAgentSpecialties(
  raw: unknown,
): import("./types").CloudAgentSpecialtySummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const agentId = typeof rec.agent_id === "string" ? rec.agent_id.trim() : "";
  if (!isSafeCloudRoomAgentId(agentId)) return null;

  const isHost = Boolean(rec.is_host);
  const rawRuntime = typeof rec.runtime_type === "string" ? rec.runtime_type.trim() : "";
  const runtime = CLOUD_WAKE_RUNTIMES.has(rawRuntime as import("./types").CloudWakeRuntimeType)
    ? (rawRuntime as import("./types").CloudWakeRuntimeType)
    : null;

  if (isHost) {
    const effective = ["cloud_host", ...(runtime ? [runtime] : [])];
    const observed = Array.isArray(rec.capabilities) ? rec.capabilities : [];
    const synced =
      observed.length === effective.length &&
      effective.every((v, idx) => observed[idx] === v);
    return {
      agent_id: agentId,
      is_host: true,
      runtime,
      host_agent_id: null,
      custom_specialties: [],
      effective_capabilities: effective,
      capabilities_synced: synced,
    };
  }

  const cfg =
    rec.recovery_config && typeof rec.recovery_config === "object" && !Array.isArray(rec.recovery_config)
      ? (rec.recovery_config as Record<string, unknown>)
      : {};
  const customSpecialties: string[] = [];
  const seenCustom = new Set<string>();
  if (Array.isArray(cfg.capabilities)) {
    for (const item of cfg.capabilities.slice(0, 8)) {
      const tag = sanitizeCustomSpecialtyTag(item);
      if (tag && !seenCustom.has(tag)) {
        seenCustom.add(tag);
        customSpecialties.push(tag);
      }
    }
  }

  const rawHost = typeof rec.host_agent_id === "string" ? rec.host_agent_id.trim() : "";
  const safeHost =
    rawHost &&
    /^[A-Za-z0-9_.-]{1,128}$/.test(rawHost) &&
    !rawHost.includes("..") &&
    !PROTOTYPE_POISON_KEYS.has(rawHost.toLowerCase()) &&
    !/^\d[\d.-]{5,}$/.test(rawHost) &&
    !CREDENTIAL_PREFIX_RE.test(rawHost) &&
    !CUSTOM_SPECIALTY_SECRET_IN_ID_RE.test(rawHost)
      ? rawHost
      : null;

  const effectiveSet = new Set<string>([
    ...customSpecialties,
    "cloud-sub-agent",
    ...(runtime ? [`runtime:${runtime}`] : []),
    ...(safeHost ? [`host:${safeHost}`] : []),
    "mcp",
  ]);
  const effectiveCapabilities = [...effectiveSet].map((tag) => tag.slice(0, 128));
  const observedCaps = Array.isArray(rec.capabilities) ? rec.capabilities : [];
  const synced =
    observedCaps.length === effectiveCapabilities.length &&
    effectiveCapabilities.every((val, idx) => observedCaps[idx] === val);

  return {
    agent_id: agentId,
    is_host: false,
    runtime,
    host_agent_id: safeHost,
    custom_specialties: customSpecialties,
    effective_capabilities: effectiveCapabilities,
    capabilities_synced: synced,
  };
}

function isValidMemoryAgentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value) &&
    !value.includes("..") &&
    !PROTOTYPE_POISON_KEYS.has(value.toLowerCase()) &&
    !/(?:^|[^A-Za-z0-9])mr_[0-9a-f]{16,}$/i.test(value) &&
    !/^\d{6,}$/.test(value) &&
    !CREDENTIAL_PREFIX_RE.test(value) &&
    !JOINED_GRAPH_CREDENTIAL_ID_RE.test(value) &&
    !JOINED_GRAPH_AWS_KEY_ID_RE.test(value) &&
    !EMBEDDED_SECRET_TOKEN_RE.test(value) &&
    !EMAIL_ID_RE.test(value) &&
    !PHONE_ID_RE.test(value)
  );
}

export function summarizeAgentMemoryIndex(
  raw: unknown,
): import("./types").AgentMemoryIndexSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const payload = raw as Record<string, unknown>;
  const agentId = typeof payload.agent_id === "string" ? payload.agent_id.trim() : "";
  if (!isValidMemoryAgentId(agentId)) return null;
  if (!Array.isArray(payload.memories) || payload.memories.length > 200) return null;

  const maxDocs =
    typeof payload.max_docs === "number" &&
    Number.isSafeInteger(payload.max_docs) &&
    payload.max_docs >= 1 &&
    payload.max_docs <= 200
      ? payload.max_docs
      : AGENT_MEMORY_DEFAULT_CAP;
  const maxBodyBytes =
    typeof payload.max_body_bytes === "number" &&
    Number.isSafeInteger(payload.max_body_bytes) &&
    payload.max_body_bytes >= 1 &&
    payload.max_body_bytes <= 10_000_000
      ? payload.max_body_bytes
      : AGENT_MEMORY_DEFAULT_BODY_CAP;

  const seenNames = new Set<string>();
  const items: import("./types").AgentMemoryIndexItem[] = [];
  let totalBytes = 0;
  let redactedCount = 0;
  let latestUpdatedAt: string | null = null;
  let latestMs = -Infinity;

  for (const entry of payload.memories) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!isValidPersonalSkillSlug(name) || seenNames.has(name)) continue;
    seenNames.add(name);

    const version =
      typeof row.version === "number" && Number.isSafeInteger(row.version) && row.version >= 1
        ? row.version
        : 1;
    const bytes =
      typeof row.bytes === "number" &&
      Number.isSafeInteger(row.bytes) &&
      row.bytes >= 0 &&
      row.bytes <= maxBodyBytes
        ? row.bytes
        : 0;
    const rawDesc = typeof row.description === "string" ? row.description : "";
    const redacted =
      rawDesc === "[redacted]" ||
      /(?:^|[^A-Za-z0-9])mr_[0-9a-f]{16,}/i.test(rawDesc) ||
      EMBEDDED_SECRET_TOKEN_RE.test(rawDesc) ||
      CREDENTIAL_PREFIX_RE.test(rawDesc.trim());
    const description = redacted
      ? ""
      : rawDesc.replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, 280);
    if (redacted) redactedCount += 1;

    const updatedAt =
      typeof row.updated_at === "string" &&
      row.updated_at.length <= 80 &&
      /^\d{4}-\d{2}-\d{2}T/.test(row.updated_at) &&
      Number.isFinite(Date.parse(row.updated_at))
        ? row.updated_at
        : null;
    if (updatedAt) {
      const parsed = Date.parse(updatedAt);
      if (parsed > latestMs) {
        latestMs = parsed;
        latestUpdatedAt = updatedAt;
      }
    }

    totalBytes += bytes;
    items.push({
      name,
      description,
      version,
      bytes,
      updated_at: updatedAt,
      redacted,
    });
  }

  items.sort((a, b) => {
    const aMs = a.updated_at ? Date.parse(a.updated_at) : -Infinity;
    const bMs = b.updated_at ? Date.parse(b.updated_at) : -Infinity;
    if (aMs !== bMs) return bMs - aMs;
    return a.name.localeCompare(b.name);
  });

  return {
    agent_id: agentId,
    note_count: items.length,
    max_docs: maxDocs,
    max_body_bytes: maxBodyBytes,
    remaining_doc_quota: Math.max(0, maxDocs - items.length),
    total_bytes: totalBytes,
    latest_updated_at: latestUpdatedAt,
    redacted_count: redactedCount,
    items,
  };
}

export function resolveInheritedObjectiveChannel(
  objectiveId: string,
  objectives: ReadonlyArray<import("./types").InheritableObjectiveChannelNode>,
): string | null {
  const startId = typeof objectiveId === "string" ? objectiveId.trim() : "";
  if (!safeGraphId(startId) || !Array.isArray(objectives) || objectives.length === 0) {
    return null;
  }
  const byId = new Map<string, import("./types").InheritableObjectiveChannelNode>();
  for (const row of objectives) {
    if (row && typeof row.id === "string" && safeGraphId(row.id) && !byId.has(row.id)) {
      byId.set(row.id, row);
    }
  }
  let cur = byId.get(startId);
  const seen = new Set<string>();
  let hops = 0;
  while (cur && hops <= 8) {
    const id = typeof cur.id === "string" ? cur.id : "";
    if (!id || seen.has(id)) return null;
    seen.add(id);
    if (typeof cur.discussion_channel_id === "string" && cur.discussion_channel_id.trim() !== "") {
      const chan = cur.discussion_channel_id.trim();
      return safeNonDmChannelId(chan) ? chan : null;
    }
    const parentId = typeof cur.parent_id === "string" ? cur.parent_id.trim() : "";
    if (!parentId || !safeGraphId(parentId)) return null;
    cur = byId.get(parentId);
    hops += 1;
  }
  return null;
}

export function computeLocalTaskActionability(
  tasks: ReadonlyArray<import("./types").LocalTaskActionabilityInputItem>,
  externalDepStatuses?: ReadonlyMap<string, string> | Record<string, string>,
): import("./types").LocalTaskActionabilitySummary {
  const ready_task_ids: string[] = [];
  const waiting_task_ids: string[] = [];
  let unresolved_edge_count = 0;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ready_task_ids, waiting_task_ids, unresolved_edge_count };
  }

  const statusById = new Map<string, string>();
  for (const t of tasks) {
    if (t && typeof t.id === "string" && safeGraphId(t.id)) {
      statusById.set(t.id, typeof t.status === "string" && t.status ? t.status : "todo");
    }
  }
  const lookupStatus = (depId: string): string | undefined => {
    const local = statusById.get(depId);
    if (local !== undefined) return local;
    if (!externalDepStatuses) return undefined;
    if (externalDepStatuses instanceof Map) {
      const val = externalDepStatuses.get(depId);
      return typeof val === "string" ? val : undefined;
    }
    if (typeof externalDepStatuses === "object" && Object.prototype.hasOwnProperty.call(externalDepStatuses, depId)) {
      const val = (externalDepStatuses as Record<string, unknown>)[depId];
      return typeof val === "string" ? val : undefined;
    }
    return undefined;
  };

  const seenTaskIds = new Set<string>();
  for (const t of tasks) {
    if (!t || typeof t.id !== "string" || !safeGraphId(t.id) || seenTaskIds.has(t.id)) continue;
    seenTaskIds.add(t.id);
    const status = typeof t.status === "string" && t.status ? t.status : "todo";
    let unresolvedCount = 0;
    if (Array.isArray(t.unresolved_depends_on)) {
      unresolvedCount = new Set(t.unresolved_depends_on.filter(safeGraphId)).size;
    } else if (t.ready === true) {
      unresolvedCount = 0;
    } else if (Array.isArray(t.depends_on) && t.depends_on.length > 0) {
      const uniqueDeps = [
        ...new Set(t.depends_on.filter((d: unknown): d is string => typeof d === "string" && d.length > 0)),
      ];
      for (const depId of uniqueDeps) {
        if (!safeGraphId(depId) || lookupStatus(depId) !== "done") {
          unresolvedCount += 1;
        }
      }
      if (t.ready === false && unresolvedCount === 0) {
        unresolvedCount = 1;
      }
    } else if (t.ready === false && status === "todo") {
      unresolvedCount = 1;
    }

    if (status !== "done" && unresolvedCount > 0) {
      waiting_task_ids.push(t.id);
      unresolved_edge_count += unresolvedCount;
    } else if (status === "todo" && unresolvedCount === 0) {
      ready_task_ids.push(t.id);
    }
  }

  return { ready_task_ids, waiting_task_ids, unresolved_edge_count };
}

export function summarizeChannelOkrSnapshot(
  raw: unknown,
): import("./types").ChannelOkrSnapshotSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const snap = raw as Record<string, unknown>;
  if (snap.note !== undefined) return null;
  if (!safeNonDmChannelId(snap.channel_id)) return null;
  const channelId = snap.channel_id;
  if (!Array.isArray(snap.objectives) || !Array.isArray(snap.tasks)) return null;
  if (snap.objectives.length > 500 || snap.tasks.length > 1000) return null;

  const includeArchived = snap.include_archived === true;
  const rawObjs = snap.objectives.filter(
    (o: unknown): o is Record<string, unknown> =>
      Boolean(o) && typeof o === "object" && !Array.isArray(o) && safeGraphId((o as Record<string, unknown>).id),
  );
  const byId = new Map<string, Record<string, unknown>>();
  for (const o of rawObjs) {
    const id = o.id as string;
    if (!byId.has(id)) byId.set(id, o);
  }

  const hasArchivedAncestor = (startId: string): boolean => {
    let cur = byId.get(startId);
    const seen = new Set<string>();
    let hops = 0;
    while (cur && hops <= 8) {
      const id = cur.id as string;
      if (seen.has(id)) return true;
      seen.add(id);
      if (cur.archived === true) return true;
      const parentId = typeof cur.parent_id === "string" ? cur.parent_id.trim() : "";
      if (!parentId || !safeGraphId(parentId)) return false;
      cur = byId.get(parentId);
      hops += 1;
    }
    return hops > 8;
  };

  const inheritableNodes: import("./types").InheritableObjectiveChannelNode[] = rawObjs.map((o) => ({
    id: o.id as string,
    discussion_channel_id: typeof o.discussion_channel_id === "string" ? o.discussion_channel_id : null,
    parent_id: typeof o.parent_id === "string" ? o.parent_id : null,
  }));

  const visibleObjectiveIds = new Set<string>();
  const active_objective_ids: string[] = [];
  for (const o of rawObjs) {
    const id = o.id as string;
    if (visibleObjectiveIds.has(id)) continue;
    if (!includeArchived && hasArchivedAncestor(id)) continue;
    if (resolveInheritedObjectiveChannel(id, inheritableNodes) !== channelId) continue;
    visibleObjectiveIds.add(id);
    if (o.status === "active" && o.archived !== true) {
      active_objective_ids.push(id);
    }
  }

  const activeSet = new Set(active_objective_ids);
  const loopSummary =
    snap.loop_summary && typeof snap.loop_summary === "object" && !Array.isArray(snap.loop_summary)
      ? (snap.loop_summary as Record<string, unknown>)
      : null;
  const unarmed_objective_ids = Array.isArray(loopSummary?.unarmed_objective_ids)
    ? [
        ...new Set(
          (loopSummary!.unarmed_objective_ids as unknown[]).filter(
            (id: unknown): id is string => safeGraphId(id) && activeSet.has(id),
          ),
        ),
      ]
    : [];

  let total_krs = 0;
  let completed_krs = 0;
  if (Array.isArray(snap.krs) && snap.krs.length <= 1000) {
    const seenKrIds = new Set<string>();
    for (const kr of snap.krs) {
      if (!kr || typeof kr !== "object" || Array.isArray(kr)) continue;
      const k = kr as Record<string, unknown>;
      if (!safeGraphId(k.id) || seenKrIds.has(k.id)) continue;
      if (typeof k.objective_id !== "string" || !visibleObjectiveIds.has(k.objective_id)) continue;
      if (
        typeof k.discussion_channel_id === "string" &&
        k.discussion_channel_id.trim() !== "" &&
        k.discussion_channel_id.trim() !== channelId
      ) {
        continue;
      }
      seenKrIds.add(k.id);
      total_krs += 1;
      const current = typeof k.current === "number" && Number.isFinite(k.current) ? k.current : NaN;
      const target = typeof k.target === "number" && Number.isFinite(k.target) ? k.target : NaN;
      if (Number.isFinite(current) && Number.isFinite(target)) {
        if (target > 0 ? current >= target : k.metric_type === "bool" && current === target) {
          completed_krs += 1;
        }
      }
    }
  }

  const visibleTasks: import("./types").LocalTaskActionabilityInputItem[] = [];
  for (const rawTask of snap.tasks) {
    if (!rawTask || typeof rawTask !== "object" || Array.isArray(rawTask)) continue;
    const t = rawTask as Record<string, unknown>;
    if (!safeGraphId(t.id)) continue;
    const taskChan = typeof t.discussion_channel_id === "string" ? t.discussion_channel_id.trim() : "";
    const objId = typeof t.objective_id === "string" ? t.objective_id : "";
    if (taskChan !== channelId && (taskChan !== "" || !visibleObjectiveIds.has(objId))) {
      continue;
    }
    visibleTasks.push({
      id: t.id,
      status: typeof t.status === "string" ? t.status : "todo",
      ready: typeof t.ready === "boolean" ? t.ready : undefined,
      depends_on: Array.isArray(t.depends_on)
        ? t.depends_on.filter((d: unknown): d is string => typeof d === "string")
        : null,
      unresolved_depends_on: Array.isArray(t.unresolved_depends_on)
        ? t.unresolved_depends_on.filter((d: unknown): d is string => typeof d === "string")
        : null,
    });
  }

  const actionability = computeLocalTaskActionability(visibleTasks);
  return {
    channel_id: channelId,
    active_objective_ids,
    unarmed_objective_ids,
    total_krs,
    completed_krs,
    ...actionability,
  };
}

const OKR_WATCH_CREDENTIAL_ID_RE =
  /(?:^|[^A-Za-z0-9])(?:mcp_(?:at|rt|code)_|ac_|agent_key_|sk[-_]|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|hf_|npm_|(?:AIza|eyJ)[A-Za-z0-9]|(?:Bearer|Basic)(?:[._-]|$))/i;
const OKR_WATCH_AWS_KEY_ID_RE = /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/;
const OKR_WATCH_DIRECT_CHANNEL_RE = /^(?:dm[-_:]|direct(?:$|[-_:]))/i;

function isSafeOkrWatchId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(value) &&
    !value.includes("..") &&
    !PROTOTYPE_POISON_KEYS.has(value.toLowerCase()) &&
    !/^mr_[0-9a-f]{16,}$/i.test(value) &&
    !OKR_WATCH_CREDENTIAL_ID_RE.test(value) &&
    !OKR_WATCH_AWS_KEY_ID_RE.test(value) &&
    !EMAIL_ID_RE.test(value) &&
    !PHONE_ID_RE.test(value)
  );
}

function sanitizeOkrWatchText(raw: unknown, maxLen: number): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function formatOkrWatchDuration(ms: number): string {
  const minMs = 60_000;
  const hourMs = 60 * minMs;
  if (ms < hourMs) return `${Math.round(ms / minMs)}m`;
  const h = ms / hourMs;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

export function summarizeOkrWatchReadiness(
  tasks: unknown,
  options?: import("./types").OkrWatchReadinessOptions,
): import("./types").OkrWatchReadinessSummary {
  const empty: import("./types").OkrWatchReadinessSummary = {
    total_tasks: 0,
    unfinished_tasks: 0,
    ready_count: 0,
    stalled_doing_task_ids: [],
    over_eta_task_ids: [],
    blocked_long_task_ids: [],
    idle_agents: [],
    supply_floor: 0,
    supply_starved: false,
    escalations: [],
  };
  if (!Array.isArray(tasks)) return empty;

  const nowMs =
    typeof options?.nowMs === "number" && Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const stallMinutes =
    typeof options?.stallMinutes === "number" &&
    Number.isFinite(options.stallMinutes) &&
    options.stallMinutes >= 5 &&
    options.stallMinutes <= 1440
      ? options.stallMinutes
      : 5;
  const stallMs = stallMinutes * 60_000;
  const blockedMs =
    typeof options?.blockedEscalateMs === "number" &&
    Number.isFinite(options.blockedEscalateMs) &&
    options.blockedEscalateMs > 0
      ? options.blockedEscalateMs
      : Math.max(4 * 3_600_000, stallMs);

  const validTasks: Array<{
    id: string;
    assignee: string;
    status: "todo" | "doing" | "done" | "blocked";
    title?: string;
    due?: string;
    blocked_reason?: string;
    stamp: string;
    depends_on: string[];
    has_invalid_dep: boolean;
  }> = [];
  const seenIds = new Set<string>();
  for (const raw of tasks.slice(0, 1000)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const assignee = typeof row.assignee === "string" ? row.assignee.trim() : "";
    if (!isSafeOkrWatchId(id) || !isSafeOkrWatchId(assignee) || seenIds.has(id)) continue;
    seenIds.add(id);
    const rawStatus = typeof row.status === "string" ? row.status.trim() : "todo";
    const status =
      rawStatus === "doing" || rawStatus === "done" || rawStatus === "blocked" ? rawStatus : "todo";
    const title = sanitizeOkrWatchText(row.title, 160) || undefined;
    const due = typeof row.due === "string" && row.due.trim() ? row.due.trim().slice(0, 64) : undefined;
    const blockedReason = typeof row.blocked_reason === "string" ? row.blocked_reason : undefined;
    const stamp =
      (typeof row.last_progress_at === "string" && row.last_progress_at.trim()) ||
      (typeof row.updated_at === "string" && row.updated_at.trim()) ||
      "";
    let hasInvalidDep = false;
    const dependsOn: string[] = [];
    if (row.depends_on !== undefined && row.depends_on !== null) {
      if (!Array.isArray(row.depends_on)) {
        hasInvalidDep = true;
      } else {
        for (const dep of row.depends_on) {
          if (typeof dep !== "string") {
            hasInvalidDep = true;
            continue;
          }
          const trimmedDep = dep.trim();
          if (!isSafeOkrWatchId(trimmedDep) || trimmedDep === id) {
            hasInvalidDep = true;
            continue;
          }
          dependsOn.push(trimmedDep);
        }
      }
    }
    validTasks.push({
      id,
      assignee,
      status,
      title,
      due,
      blocked_reason: blockedReason,
      stamp,
      depends_on: dependsOn,
      has_invalid_dep: hasInvalidDep,
    });
  }

  const members = Array.isArray(options?.members)
    ? [
        ...new Set(
          options!.members
            .map((m) => (typeof m === "string" ? m.trim() : ""))
            .filter(isSafeOkrWatchId),
        ),
      ].sort()
    : [];

  const stalled_doing_task_ids: string[] = [];
  const over_eta_task_ids: string[] = [];
  const blocked_long_task_ids: string[] = [];
  const escalations: import("./types").OkrWatchEscalationItem[] = [];
  const byId = new Map(validTasks.map((t) => [t.id, t]));
  const doneIds = new Set(validTasks.filter((t) => t.status === "done").map((t) => t.id));

  const lookupExternalDep = (depId: string): string | undefined => {
    const ext = options?.externalDepStatuses;
    if (!ext) return undefined;
    if (ext instanceof Map) {
      const v = ext.get(depId);
      return typeof v === "string" ? v : undefined;
    }
    if (typeof ext === "object" && Object.prototype.hasOwnProperty.call(ext, depId)) {
      const v = (ext as Record<string, unknown>)[depId];
      return typeof v === "string" ? v : undefined;
    }
    return undefined;
  };

  for (const t of validTasks) {
    if (t.status === "done" || t.status === "todo") continue;
    const progressMs = t.stamp ? Date.parse(t.stamp) : NaN;
    const silentMs = Number.isFinite(progressMs) ? Math.max(0, nowMs - progressMs) : 0;

    if (t.status === "doing") {
      const dueMs = t.due ? Date.parse(t.due) : NaN;
      if (Number.isFinite(dueMs) && nowMs > dueMs && (!Number.isFinite(progressMs) || silentMs > 0)) {
        over_eta_task_ids.push(t.id);
        escalations.push({
          kind: "over_eta",
          task_id: t.id,
          assignee: t.assignee,
          ...(t.title ? { title: t.title } : {}),
          detail: Number.isFinite(progressMs)
            ? `over ETA by ${formatOkrWatchDuration(nowMs - dueMs)} (silent ${formatOkrWatchDuration(silentMs)})`
            : `over ETA by ${formatOkrWatchDuration(nowMs - dueMs)} (no progress recorded)`,
          silent_ms: silentMs,
        });
      } else if (!Number.isFinite(dueMs) && Number.isFinite(progressMs) && silentMs >= stallMs) {
        stalled_doing_task_ids.push(t.id);
        escalations.push({
          kind: "stalled_doing",
          task_id: t.id,
          assignee: t.assignee,
          ...(t.title ? { title: t.title } : {}),
          detail: `silent for ${formatOkrWatchDuration(silentMs)}`,
          silent_ms: silentMs,
        });
      }
    } else if (t.status === "blocked" && silentMs >= blockedMs) {
      blocked_long_task_ids.push(t.id);
      const safeReason = sanitizeOkrWatchText(t.blocked_reason, 60);
      escalations.push({
        kind: "blocked_long",
        task_id: t.id,
        assignee: t.assignee,
        ...(t.title ? { title: t.title } : {}),
        detail: `blocked ${formatOkrWatchDuration(silentMs)}${safeReason ? `: ${safeReason}` : ""}`,
        silent_ms: silentMs,
      });
    }
  }

  const ready_count = validTasks.filter(
    (t) =>
      t.status === "todo" &&
      !t.has_invalid_dep &&
      t.depends_on.every(
        (d) =>
          isSafeOkrWatchId(d) &&
          d !== t.id &&
          (doneIds.has(d) || (!byId.has(d) && (options?.externalDepStatuses ? lookupExternalDep(d) === "done" : true))),
      ),
  ).length;

  const unfinished_tasks = validTasks.filter((t) => t.status !== "done").length;
  const busyAgents = new Set(validTasks.filter((t) => t.status !== "done").map((t) => t.assignee));
  const idle_agents = members.filter((m) => !busyAgents.has(m));
  const supply_floor = Math.ceil((idle_agents.length * 2) / 3);
  const supply_starved = unfinished_tasks > 0 && idle_agents.length > 0 && ready_count < supply_floor;

  return {
    total_tasks: validTasks.length,
    unfinished_tasks,
    ready_count,
    stalled_doing_task_ids,
    over_eta_task_ids,
    blocked_long_task_ids,
    idle_agents,
    supply_floor,
    supply_starved,
    escalations,
  };
}

function normalizeSdkDagCapabilities(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, 64)) {
    if (typeof item !== "string") continue;
    const norm = item.trim().toLowerCase();
    if (!norm || norm.length > 64 || PROTOTYPE_POISON_KEYS.has(norm) || OKR_WATCH_CREDENTIAL_ID_RE.test(norm) || OKR_WATCH_AWS_KEY_ID_RE.test(norm) || seen.has(norm)) {
      continue;
    }
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/**
 * Pure O(V+E) Kahn topological sort for client-side DAG validation.
 * Returns ordered safe task IDs when acyclic and all dependencies exist in `tasks`, or `null` on cycle/invalid/dangling dependency.
 */
export function topologicalSortDagTasks(tasks: unknown): string[] | null {
  if (!Array.isArray(tasks)) return null;
  const nodeDeps = new Map<string, string[]>();
  for (const raw of tasks.slice(0, 2000)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!isSafeOkrWatchId(id) || nodeDeps.has(id)) return null;
    const rawDeps = row.depends_on ?? row.dependsOn;
    const deps: string[] = [];
    const seenDeps = new Set<string>();
    if (rawDeps !== undefined && rawDeps !== null) {
      if (!Array.isArray(rawDeps)) return null;
      for (const d of rawDeps) {
        if (typeof d !== "string") return null;
        const depId = d.trim();
        if (!isSafeOkrWatchId(depId) || depId === id) return null;
        if (!seenDeps.has(depId)) {
          seenDeps.add(depId);
          deps.push(depId);
        }
      }
    }
    nodeDeps.set(id, deps);
  }

  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const [id, deps] of nodeDeps) {
    for (const dep of deps) {
      if (!nodeDeps.has(dep)) return null;
      const list = adjacency.get(dep) ?? [];
      list.push(id);
      adjacency.set(dep, list);
    }
    inDegree.set(id, deps.length);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  const sorted: string[] = [];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++]!;
    sorted.push(cur);
    for (const nextId of adjacency.get(cur) ?? []) {
      const nextDeg = (inDegree.get(nextId) ?? 0) - 1;
      inDegree.set(nextId, nextDeg);
      if (nextDeg === 0) queue.push(nextId);
    }
  }
  return sorted.length === nodeDeps.size ? sorted : null;
}

/**
 * Pure specialist-first capability scheduler matching `Server/src/dag-scheduler.ts`.
 * Schedules ready (`pending` / `todo`) tasks whose `depends_on` are all `completed` / `done`,
 * prioritizing capability-constrained tasks before generic tasks and narrow specialists on ties.
 */
export function scheduleReadyDagTasks(
  tasks: unknown,
  agents: unknown,
): import("./types").DagTaskAssignment[] {
  if (!Array.isArray(tasks) || !Array.isArray(agents)) return [];

  const parsedTasks: Array<{
    id: string;
    idx: number;
    status: string;
    deps: string[];
    hasInvalidDep: boolean;
    reqCaps: string[];
  }> = [];
  const seenTasks = new Set<string>();
  tasks.slice(0, 1000).forEach((raw, idx) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!isSafeOkrWatchId(id) || seenTasks.has(id)) return;
    seenTasks.add(id);
    const status = typeof row.status === "string" && row.status.trim() ? row.status.trim().toLowerCase() : "pending";
    const rawDeps = row.depends_on ?? row.dependsOn;
    const deps: string[] = [];
    let hasInvalidDep = false;
    if (rawDeps !== undefined && rawDeps !== null) {
      if (!Array.isArray(rawDeps)) {
        hasInvalidDep = true;
      } else {
        for (const d of rawDeps) {
          if (typeof d !== "string") {
            hasInvalidDep = true;
            continue;
          }
          const depId = d.trim();
          if (!isSafeOkrWatchId(depId) || depId === id) {
            hasInvalidDep = true;
            continue;
          }
          deps.push(depId);
        }
      }
    }
    const reqCaps = normalizeSdkDagCapabilities(row.required_capabilities ?? row.requiredCapabilities);
    parsedTasks.push({ id, idx, status, deps, hasInvalidDep, reqCaps });
  });

  const completedIds = new Set(
    parsedTasks.filter((t) => t.status === "completed" || t.status === "done").map((t) => t.id),
  );
  const readyTasks = parsedTasks
    .filter(
      (t) =>
        (t.status === "pending" || t.status === "todo") &&
        !t.hasInvalidDep &&
        t.deps.every((depId) => completedIds.has(depId)),
    )
    .sort(
      (a, b) =>
        Number(b.reqCaps.length > 0) - Number(a.reqCaps.length > 0) ||
        b.reqCaps.length - a.reqCaps.length ||
        a.idx - b.idx,
    );

  const availableAgents: Array<{ id: string; capSet: Set<string> }> = [];
  const seenAgents = new Set<string>();
  for (const raw of agents.slice(0, 500)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!isSafeOkrWatchId(id) || seenAgents.has(id)) continue;
    seenAgents.add(id);
    const curTask = row.current_task_id ?? row.currentTaskId;
    if (curTask !== undefined && curTask !== null && curTask !== "") continue;
    availableAgents.push({
      id,
      capSet: new Set(normalizeSdkDagCapabilities(row.capabilities)),
    });
  }

  const busyIds = new Set<string>();
  const assignments: import("./types").DagTaskAssignment[] = [];
  for (const task of readyTasks) {
    const candidates = availableAgents.filter((a) => !busyIds.has(a.id));
    if (candidates.length === 0) break;
    if (task.reqCaps.length === 0) {
      const chosen = candidates[0]!;
      busyIds.add(chosen.id);
      assignments.push({
        task_id: task.id,
        agent_id: chosen.id,
        matched_capabilities: 0,
        required_capabilities: 0,
      });
      continue;
    }
    let best: { id: string; capSet: Set<string> } | null = null;
    let bestScore = -1;
    let bestMatched = 0;
    let bestBreadth = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const matched = task.reqCaps.filter((c) => candidate.capSet.has(c)).length;
      const score = matched / task.reqCaps.length;
      if (score > bestScore || (score === bestScore && score > 0 && candidate.capSet.size < bestBreadth)) {
        bestScore = score;
        bestMatched = matched;
        bestBreadth = candidate.capSet.size;
        best = candidate;
      }
    }
    if (best) {
      busyIds.add(best.id);
      assignments.push({
        task_id: task.id,
        agent_id: best.id,
        matched_capabilities: bestMatched,
        required_capabilities: task.reqCaps.length,
      });
    }
  }
  return assignments;
}

function isEligibleSdkMentionMemberId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  const trimmed = id.trim();
  if (!trimmed || trimmed !== id || trimmed.length > 256 || trimmed.includes("..")) return false;
  if (/[\u0000-\u001f\u007f\s/\\]/.test(trimmed)) return false;
  if (
    PROTOTYPE_POISON_KEYS.has(trimmed.toLowerCase()) ||
    /^mr_[0-9a-f]{16,}$/i.test(trimmed) ||
    OKR_WATCH_CREDENTIAL_ID_RE.test(trimmed) ||
    OKR_WATCH_AWS_KEY_ID_RE.test(trimmed)
  ) {
    return false;
  }
  return true;
}

function resolveSdkMentionCandidate(
  candidate: string,
  eligible: readonly string[],
  displayNameOf?: (memberId: string) => string | undefined,
): string | null {
  if (!candidate) return null;
  if (eligible.includes(candidate)) return candidate;
  const lower = candidate.toLowerCase();

  const ciExact = eligible.filter((id) => id.toLowerCase() === lower);
  if (ciExact.length === 1) return ciExact[0]!;
  if (ciExact.length > 1) return null;

  const dnExact = eligible.filter((id) => (displayNameOf?.(id) || "").trim().toLowerCase() === lower);
  if (dnExact.length === 1) return dnExact[0]!;
  if (dnExact.length > 1) return null;

  if (candidate.includes("@")) return null;

  const prefixHits = eligible.filter(
    (id) =>
      id.toLowerCase().startsWith(lower) ||
      (displayNameOf?.(id) || "").trim().toLowerCase().startsWith(lower),
  );
  if (prefixHits.length === 1) return prefixHits[0]!;
  return null;
}

/**
 * Pure @mention token resolver matching `Server/src/mention-resolver.ts`.
 * Priority: exact ID → case-insensitive exact ID → unique display_name → unique ID/display_name prefix,
 * with sentence-ending period fallback, duplicate member dedup, and zero guessing on ambiguity.
 */
export function resolveAgentMention(
  token: unknown,
  memberIds: unknown,
  displayNameOf?: (memberId: string) => string | undefined,
): string | null {
  if (typeof token !== "string" || !Array.isArray(memberIds)) return null;
  const cleaned = token.trim().replace(/^@+/, "");
  if (
    !cleaned ||
    cleaned.length > 256 ||
    /[\u0000-\u001f\u007f\s/\\]/.test(cleaned) ||
    cleaned.includes("..") ||
    PROTOTYPE_POISON_KEYS.has(cleaned.toLowerCase()) ||
    /^mr_[0-9a-f]{16,}$/i.test(cleaned) ||
    OKR_WATCH_CREDENTIAL_ID_RE.test(cleaned) ||
    OKR_WATCH_AWS_KEY_ID_RE.test(cleaned)
  ) {
    return null;
  }

  const eligible: string[] = [];
  const seen = new Set<string>();
  for (const rawId of memberIds.slice(0, 2000)) {
    if (!isEligibleSdkMentionMemberId(rawId) || seen.has(rawId)) continue;
    seen.add(rawId);
    eligible.push(rawId);
  }
  if (eligible.length === 0) return null;

  const direct = resolveSdkMentionCandidate(cleaned, eligible, displayNameOf);
  if (direct) return direct;

  if (cleaned.endsWith(".")) {
    const withoutDots = cleaned.replace(/\.+$/, "");
    if (withoutDots) {
      return resolveSdkMentionCandidate(withoutDots, eligible, displayNameOf);
    }
  }
  return null;
}

/**
 * Extracts and resolves all @mentions from message content with exact parity to `Hub.resolveMentionedIds`,
 * including `@Display Name(agent-id)` canonicalization, inline CJK mentions, un-prefixed email filtering, and sender self-exclusion.
 */
export function extractResolvedMentions(
  content: unknown,
  memberIds: unknown,
  options?: import("./types").ExtractResolvedMentionsOptions,
): string[] {
  if (typeof content !== "string" || !content || !Array.isArray(memberIds)) return [];
  const eligibleSet = new Set<string>();
  const eligibleList: string[] = [];
  for (const rawId of memberIds.slice(0, 2000)) {
    if (!isEligibleSdkMentionMemberId(rawId) || eligibleSet.has(rawId)) continue;
    eligibleSet.add(rawId);
    eligibleList.push(rawId);
  }
  if (eligibleList.length === 0) return [];

  const senderId = typeof options?.senderId === "string" ? options.senderId.trim() : "";
  const normalizedContent = content
    .slice(0, 65536)
    .replace(/@[^@\n()]+\(([^()\s]+)\)/g, (original, id: string) => (eligibleSet.has(id) ? `@${id}` : original));

  const mentionRe = /@([A-Za-z0-9_.+\-@]+)/g;
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = mentionRe.exec(normalizedContent)) !== null) {
    if (m.index > 0 && /[A-Za-z0-9._%+-]/.test(normalizedContent[m.index - 1]!)) continue;
    const resolved = resolveAgentMention(m[1], eligibleList, options?.displayNameOf);
    if (!resolved || (senderId && resolved === senderId) || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

const SDK_PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SDK_UNSAFE_REF_RE =
  /(?:^dm[-:]|^mr_[0-9a-f]{16,}$|(?:^|[^A-Za-z0-9])(?:mcp_(?:at|rt|code)_|ac_[A-Za-z0-9_+/\-=]{6,}|agent_key_|sk[-_][A-Za-z0-9_-]{8,}|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|(?:hf|npm)_[A-Za-z0-9]{8,}|(?:AIza|eyJ)[A-Za-z0-9][A-Za-z0-9._-]{5,}))/i;
const SDK_AWS_KEY_ID_RE = /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?=$|[^A-Za-z0-9])/i;

function isSafeSdkWorkspaceRefId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  const trimmed = id.trim();
  if (!trimmed || trimmed !== id || trimmed.length > 128) return false;
  if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) return false;
  if (SDK_PROTOTYPE_KEYS.has(trimmed.toLowerCase())) return false;
  if (SDK_UNSAFE_REF_RE.test(trimmed) || SDK_AWS_KEY_ID_RE.test(trimmed)) return false;
  return true;
}

function dedupeSdkRowsById<T extends Record<string, any>>(rows: ReadonlyArray<T> | null | undefined): T[] {
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = typeof row.id === "string" ? row.id : "";
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(row);
  }
  return out;
}

function sdkEntityUpdatedMs(e: any): number {
  const v = e?.updated_at ?? e?.updatedAt;
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : Infinity;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return Infinity;
    const t = Date.parse(trimmed);
    if (!Number.isNaN(t)) return t;
    if (/^\d{9,16}$/.test(trimmed)) {
      const asNum = Number(trimmed);
      if (Number.isFinite(asNum)) return asNum;
    }
    return Infinity;
  }
  return Infinity;
}

/**
 * Pure zero-I/O `?since=` incremental filter mirroring `src/workspace-since.ts`,
 * including 3-layer sub-Objective `parent_id` unchanged-ancestor tracking, `NaN`
 * fail-open timestamp handling, entity deduplication, and unsafe reference rejection.
 */
export function filterWorkspaceEntitiesSince(
  entities: import("./types").WorkspaceSinceEntities,
  sinceMs: number,
  scopeChannelId?: string,
  allowedParentIds?: ReadonlySet<string>,
): import("./types").WorkspaceSinceFilterResult {
  const safeSince = typeof sinceMs === "number" && Number.isFinite(sinceMs) ? sinceMs : 0;
  const changed = (e: any) => sdkEntityUpdatedMs(e) >= safeSince;
  const projectLinks = (row: any) => {
    if (!scopeChannelId) return row;
    const out = { ...row };
    for (const field of ["linked_docs", "linked_channel_docs"]) {
      if (Array.isArray(row?.[field])) {
        out[field] = row[field].filter((ref: any) => ref && (!ref.channel_id || ref.channel_id === scopeChannelId));
      }
    }
    return out;
  };
  const rawObjectives = Array.isArray(entities?.objectives) ? entities.objectives : [];
  const rawKrs = Array.isArray(entities?.keyResults) ? entities.keyResults : [];
  const rawTasks = Array.isArray(entities?.tasks) ? entities.tasks : [];
  const rawDocs = Array.isArray(entities?.channelDocs) ? entities.channelDocs : [];

  const archivedObjectiveIds = new Set(
    rawObjectives.filter((o) => o?.archived === true && typeof o?.id === "string").map((o) => o.id as string),
  );
  const objectives = dedupeSdkRowsById(rawObjectives.filter(changed)).map(projectLinks);
  const keyResults = dedupeSdkRowsById(rawKrs.filter(changed)).map(projectLinks);
  const tasks = dedupeSdkRowsById(rawTasks.filter(changed)).map(projectLinks);
  const tombstones = new Set(
    rawDocs
      .filter((d) => d?.archived === true || d?.bodyMarkdown === "" || d?.body_markdown === "")
      .map((d) => d?.id),
  );
  const channelDocs = dedupeSdkRowsById(
    rawDocs
      .filter((d) => !tombstones.has(d?.id) && (!scopeChannelId || (d.channel_id ?? d.channelId) === scopeChannelId))
      .filter(changed),
  );

  const changedIds = new Set<string>();
  for (const arr of [objectives, keyResults, tasks, channelDocs]) {
    for (const e of arr) if (typeof e?.id === "string" && e.id) changedIds.add(e.id);
  }

  const refs = new Set<string>();
  for (const row of [...objectives, ...keyResults, ...tasks]) {
    for (const field of ["linked_docs", "linked_channel_docs"]) {
      if (Array.isArray(row?.[field])) {
        for (const link of row[field]) {
          if (
            isSafeSdkWorkspaceRefId(link?.doc_id) &&
            (!scopeChannelId || !link.channel_id || link.channel_id === scopeChannelId)
          ) {
            refs.add(link.doc_id);
          }
        }
      }
    }
  }
  for (const o of objectives) {
    if (
      !o?.archived &&
      isSafeSdkWorkspaceRefId(o?.parent_id) &&
      o.parent_id !== o.id &&
      !archivedObjectiveIds.has(o.parent_id) &&
      (!allowedParentIds || allowedParentIds.has(o.parent_id))
    ) {
      refs.add(o.parent_id);
    }
  }
  for (const k of keyResults) if (isSafeSdkWorkspaceRefId(k?.objective_id)) refs.add(k.objective_id);
  for (const t of tasks) {
    if (isSafeSdkWorkspaceRefId(t?.objective_id)) refs.add(t.objective_id);
    if (isSafeSdkWorkspaceRefId(t?.key_result_id)) refs.add(t.key_result_id);
    if (Array.isArray(t?.depends_on)) {
      for (const d of t.depends_on) if (isSafeSdkWorkspaceRefId(d) && d !== t.id) refs.add(d);
    }
    if (Array.isArray(t?.contributes_to)) {
      for (const c of t.contributes_to) if (isSafeSdkWorkspaceRefId(c) && c !== t.id) refs.add(c);
    }
  }
  const referencedUnchangedIds = [...refs].filter((id) => !changedIds.has(id) && !tombstones.has(id));
  return { objectives, keyResults, tasks, channelDocs, referencedUnchangedIds };
}

function safeSdkNonNegCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function isSafeSdkDiscoverableChannelId(id: unknown): id is string {
  return isSafeSdkWorkspaceRefId(id) && !/^arena-/i.test(id);
}

/**
 * Pure zero-I/O observable-liveness channel ranking mirroring `src/discovery-ranking.ts`:
 * `online_agent_count DESC` -> `member_count DESC` -> `created_at ASC` -> `id ASC`,
 * deduplicating channel IDs and dropping unsafe/DM/arena/prototype rows before truncation.
 */
export function rankDiscoverableChannels<T extends import("./types").DiscoverableChannelSummary>(
  channels: ReadonlyArray<T> | null | undefined,
  limit = 20,
): T[] {
  if (!Array.isArray(channels)) return [];
  const ts = (v: unknown): number => {
    if (typeof v === "number") return Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER;
    if (typeof v === "string") {
      const n = Date.parse(v);
      if (!Number.isNaN(n)) return n;
      const asNum = Number(v);
      if (Number.isFinite(asNum)) return asNum;
    }
    return Number.MAX_SAFE_INTEGER;
  };
  const seen = new Set<string>();
  const clean: T[] = [];
  for (const ch of channels) {
    if (!ch || typeof ch !== "object" || !isSafeSdkDiscoverableChannelId(ch.id)) continue;
    if ((ch as any).type === "direct" || (ch as any).archived === true) continue;
    if ((ch as any).visibility !== undefined && (ch as any).visibility !== "public") continue;
    if (seen.has(ch.id)) continue;
    seen.add(ch.id);
    clean.push(ch);
  }
  clean.sort((a, b) => {
    const byOnline = safeSdkNonNegCount(b.online_agent_count) - safeSdkNonNegCount(a.online_agent_count);
    if (byOnline !== 0) return byOnline;
    const byMembers = safeSdkNonNegCount(b.member_count) - safeSdkNonNegCount(a.member_count);
    if (byMembers !== 0) return byMembers;
    const byAge = ts(a.created_at) - ts(b.created_at);
    if (byAge !== 0) return byAge;
    return String(a.id).localeCompare(String(b.id));
  });
  return limit >= 0 ? clean.slice(0, limit) : clean;
}

export interface RESTClientOptions {
  baseUrl: string; // e.g. "http://localhost:8080"
  bearerToken?: string;
}

interface HealthResponse {
  status: string;
  agents: number;
  channels: number;
  proposals: number;
  uptime: number;
}

interface StoredChannel {
  id: string;
  name: string;
  type: string;
  consensus_rule: string;
  created_at: string;
  members: string[];
}

interface StoredMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_type: string;
  content: string;
  content_type: string;
  timestamp: string;
}

export class AgentChatREST {
  private baseUrl: string;
  private bearerToken?: string;

  constructor(options: RESTClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.bearerToken = options.bearerToken?.trim() || undefined;
  }

  // MARK: - Health

  async health(): Promise<HealthResponse> {
    return this.get("/health");
  }

  // MARK: - Agents

  async getOnlineAgents(opts?: import("./types").OnlineAgentsQuery): Promise<AgentCard[]> {
    const params = new URLSearchParams();
    if (opts?.status !== undefined) {
      if (opts.status !== "online" && opts.status !== "offline" && opts.status !== "all") {
        throw new Error("Invalid agent status filter");
      }
      params.set("status", opts.status);
    }
    if (opts?.limit !== undefined) {
      if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 200) {
        throw new Error("Invalid limit");
      }
      params.set("limit", String(opts.limit));
    }
    if (opts?.offset !== undefined) {
      if (!Number.isInteger(opts.offset) || opts.offset < 0) {
        throw new Error("Invalid offset");
      }
      params.set("offset", String(opts.offset));
    }
    const qs = params.size > 0 ? `?${params.toString()}` : "";
    const data = await this.get<{ agents: AgentCard[] }>(`/api/agents${qs}`, {
      "Cache-Control": "no-store",
      ...(this.authHeaders(opts?.bearerToken) ?? {}),
    });
    return data.agents;
  }

  async getAgent(agentId: string, opts?: { bearerToken?: string }): Promise<AgentCard> {
    const safeId = this.assertSafeDiscoveryAgentId(agentId);
    return this.get(`/api/agents/${encodeURIComponent(safeId)}`, {
      "Cache-Control": "no-store",
      ...(this.authHeaders(opts?.bearerToken) ?? {}),
    });
  }

  async discover(
    capabilities: string[] = [],
    limit = 20,
    opts?: import("./types").DiscoverAgentsOptions,
  ): Promise<AgentCard[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("Invalid limit");
    }
    const params = new URLSearchParams();
    const cleanedCaps = capabilities
      .map((c) => (typeof c === "string" ? c.trim() : ""))
      .filter((c) => c.length > 0);
    for (const cap of cleanedCaps) {
      if (cap.length > 64 || /[\u0000-\u001F]/.test(cap) || this.containsMemorySecretShape(cap)) {
        throw new Error("Invalid capability filter");
      }
    }
    if (cleanedCaps.length > 0) params.set("capabilities", cleanedCaps.join(","));
    if (opts?.q !== undefined) {
      const q = opts.q.trim();
      if (q.length > 200 || /[\u0000-\u001F]/.test(q) || this.containsMemorySecretShape(q)) {
        throw new Error("Invalid search query");
      }
      if (q.length > 0) params.set("q", q);
    }
    if (opts?.online_only !== undefined) {
      params.set("online_only", opts.online_only ? "1" : "0");
    }
    params.set("limit", String(limit));
    const data = await this.get<{ agents: AgentCard[] }>(`/api/discover?${params}`, {
      "Cache-Control": "no-store",
      ...(this.authHeaders(opts?.bearerToken) ?? {}),
    });
    return data.agents;
  }

  // MARK: - Channels

  async getChannels(agentId: string): Promise<StoredChannel[]> {
    const data = await this.get<{ channels: StoredChannel[] }>(
      `/api/channels?agent_id=${encodeURIComponent(agentId)}`,
    );
    return data.channels;
  }

  // MARK: - Messages

  async getMessages(
    channelId: string,
    limit = 50,
    before?: string,
    after?: string,
    opts?: import("./types").GetMessagesOptions,
  ): Promise<StoredMessage[]> {
    const safeChannel = this.assertSafeChannelRef(channelId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Invalid limit");
    }
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set("before", before.trim());
    if (after) params.set("after", after.trim());
    const data = await this.get<{ messages: StoredMessage[] }>(
      `/api/channels/${encodeURIComponent(safeChannel)}/messages?${params}`,
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(opts?.bearerToken) ?? {}),
      },
    );
    return data.messages;
  }

  /** Send a message via REST (no WebSocket needed) */
  async sendMessage(
    channelId: string,
    senderId: string,
    content: string,
    senderType = "agent",
    opts?: import("./types").SendMessageOptions,
  ): Promise<{ ok: boolean; id: string }> {
    const safeChannel = this.assertSafeChannelRef(channelId);
    const safeSender = typeof senderId === "string" ? senderId.trim() : "";
    if (!safeSender || safeSender.length > 160 || /[\u0000-\u001F]/.test(safeSender) || this.containsMemorySecretShape(safeSender)) {
      throw new Error("Invalid sender ID");
    }
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Message content is required");
    }
    if (senderType !== "agent" && senderType !== "human") {
      throw new Error("Invalid sender type");
    }
    return this.post(
      `/api/channels/${encodeURIComponent(safeChannel)}/messages`,
      {
        sender_id: safeSender,
        content,
        sender_type: senderType,
      },
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(opts?.bearerToken) ?? {}),
      },
    );
  }

  // MARK: - Search

  async search(
    query: string,
    channelId?: string,
    limit = 50,
    opts?: import("./types").SearchMessagesOptions,
  ): Promise<StoredMessage[]> {
    const q = typeof query === "string" ? query.trim() : "";
    if (!q || q.length > 200 || /[\u0000-\u001F]/.test(q)) {
      throw new Error("Invalid search query");
    }
    if (this.containsMemorySecretShape(q)) {
      throw new Error("Search query must not contain secrets");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("Invalid limit");
    }
    const params = new URLSearchParams({ q, limit: String(limit) });
    if (channelId !== undefined && channelId !== "") {
      params.set("channel_id", this.assertSafeChannelRef(channelId));
    } else if (opts?.include_owned === true) {
      params.set("include_owned", "1");
    }
    const data = await this.get<{ messages: StoredMessage[] }>(`/api/search?${params}`, {
      "Cache-Control": "no-store",
      ...(this.authHeaders(opts?.bearerToken) ?? {}),
    });
    return data.messages;
  }

  // MARK: - Arenas

  private assertSafeChannelRef(rawChannelId: string): string {
    const trimmed = typeof rawChannelId === "string" ? rawChannelId.trim() : "";
    if (
      !trimmed ||
      trimmed.length > 128 ||
      /[/\\?#&\s\u0000-\u001F]/.test(trimmed) ||
      trimmed.includes("..") ||
      /^(?:ac_|agent_key_|sk[-_]|gh[pousr]_|github_pat_|AIza|eyJ)/i.test(trimmed) ||
      this.containsMemorySecretShape(trimmed)
    ) {
      throw new Error("Invalid channel ID");
    }
    return trimmed;
  }

  async getArena(channelId: string, opts?: { bearerToken?: string }): Promise<import("./types").GetArenaResponse> {
    const safeChannel = this.assertSafeChannelRef(channelId);
    return this.get<import("./types").GetArenaResponse>(`/api/arenas/${encodeURIComponent(safeChannel)}`, {
      "Cache-Control": "no-store",
      ...(this.authHeaders(opts?.bearerToken) ?? {}),
    });
  }

  async createArena(
    input: import("./types").CreateArenaInput,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").CreateArenaResponse> {
    const topic = typeof input?.topic === "string" ? input.topic.trim() : "";
    if (!topic || topic.length > 120 || /[\u0000-\u001F]/.test(topic)) {
      throw new Error("Arena topic must be 1..120 characters");
    }
    if (this.containsMemorySecretShape(topic)) {
      throw new Error("Arena topic must not contain secrets");
    }
    if (!Array.isArray(input?.opponents) || input.opponents.length !== 2) {
      throw new Error("Arena opponents must be two distinct agent IDs");
    }
    const oppA = this.assertSafeDiscoveryAgentId(input.opponents[0]);
    const oppB = this.assertSafeDiscoveryAgentId(input.opponents[1]);
    if (oppA === oppB) {
      throw new Error("Arena opponents must be two distinct agent IDs");
    }
    const body: Record<string, unknown> = {
      topic,
      opponents: [oppA, oppB],
    };
    if (input.rounds !== undefined) {
      if (!Number.isInteger(input.rounds) || input.rounds < 1 || input.rounds > 20) {
        throw new Error("Arena rounds must be an integer between 1 and 20");
      }
      body.rounds = input.rounds;
    }
    const bearerToken = input.bearerToken ?? opts?.bearerToken;
    return this.post<import("./types").CreateArenaResponse>("/api/arenas", body, {
      "Cache-Control": "no-store",
      ...(this.authHeaders(bearerToken) ?? {}),
    });
  }

  async advanceArena(
    channelId: string,
    action: import("./types").ArenaAdvanceAction,
    opts?: import("./types").AdvanceArenaOptions,
  ): Promise<import("./types").AdvanceArenaResponse> {
    const safeChannel = this.assertSafeChannelRef(channelId);
    if (action !== "tick" && action !== "finish") {
      throw new Error("Invalid arena action");
    }
    const extraHeaders: Record<string, string> = {
      "Cache-Control": "no-store",
      ...(this.authHeaders(opts?.bearerToken) ?? {}),
    };
    if (opts?.idempotencyKey !== undefined) {
      const idem = opts.idempotencyKey.trim();
      if (!idem || idem.length > 96 || /[\u0000-\u001F]/.test(idem) || this.containsMemorySecretShape(idem)) {
        throw new Error("Invalid idempotencyKey");
      }
      extraHeaders["X-Idempotency-Key"] = idem;
    }
    return this.post<import("./types").AdvanceArenaResponse>(
      `/api/arenas/${encodeURIComponent(safeChannel)}/${action}`,
      {},
      extraHeaders,
    );
  }

  // MARK: - Stats

  async stats(): Promise<any> {
    return this.get("/api/stats");
  }

  // MARK: - Webhooks

  private hasEmbeddedWebhookSecret(candidate: string): boolean {
    return (
      EMBEDDED_SECRET_TOKEN_RE.test(candidate) ||
      JOINED_GRAPH_AWS_KEY_ID_RE.test(candidate) ||
      this.containsMemorySecretShape(candidate)
    );
  }

  private assertWebhookTarget(channelId: string, rawUrl: string): { channelId: string; url: string } {
    const safeChannel = typeof channelId === "string" ? channelId.trim() : "";
    if (
      !safeNonDmChannelId(safeChannel) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel)
    ) {
      throw new Error("Invalid channel ID");
    }
    const trimmedUrl = typeof rawUrl === "string" ? rawUrl.trim() : "";
    if (!trimmedUrl || trimmedUrl.length > 1024 || /[\u0000-\u001F\u007F]/.test(trimmedUrl)) {
      throw new Error("Invalid webhook URL");
    }
    let decodedUrl = "";
    if (trimmedUrl.includes("%")) {
      try {
        decodedUrl = decodeURIComponent(trimmedUrl);
      } catch {
        decodedUrl = "";
      }
    }
    if (
      this.hasEmbeddedWebhookSecret(trimmedUrl) ||
      (decodedUrl.length > 0 && this.hasEmbeddedWebhookSecret(decodedUrl))
    ) {
      throw new Error("Webhook URL must not contain secrets");
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmedUrl);
    } catch {
      throw new Error("Invalid webhook URL");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Webhook URL must use http(s)");
    }
    if (parsed.username || parsed.password) {
      throw new Error("Webhook URL must not contain credentials");
    }
    if (isPrivateOrReservedHost(parsed.hostname)) {
      throw new Error("Webhook host not allowed");
    }
    return { channelId: safeChannel, url: trimmedUrl };
  }

  async registerWebhook(
    channelId: string,
    url: string,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean }> {
    const target = this.assertWebhookTarget(channelId, url);
    return this.post(
      "/api/webhooks",
      { channel_id: target.channelId, url: target.url },
      this.authHeaders(opts?.bearerToken),
    );
  }

  async removeWebhook(
    channelId: string,
    url: string,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean }> {
    const target = this.assertWebhookTarget(channelId, url);
    return this.del(
      "/api/webhooks",
      { channel_id: target.channelId, url: target.url },
      this.authHeaders(opts?.bearerToken),
    );
  }

  // MARK: - Agent Registration

  async registerAgent(displayName: string, capabilities?: string[]): Promise<{ agentId: string; agentKey: string }> {
    return this.post("/api/agents/register", { display_name: displayName, capabilities });
  }

  async getUnclaimedAgents(limit = 50): Promise<any[]> {
    const data = await this.get<{ agents: any[] }>(`/api/agents/unclaimed?limit=${limit}`);
    return data.agents;
  }

  // MARK: - Unified Account API

  async registerAccount(params: { name: string; type: "agent" | "user"; id?: string; password?: string; capabilities?: string[] }): Promise<any> {
    return this.post("/api/account/register", params as any);
  }

  async login(id: string, key: string): Promise<any> {
    return this.post("/api/account/login", { id, key });
  }

  async getAccount(id: string): Promise<any> {
    return this.get(`/api/account/${encodeURIComponent(id)}`);
  }

  async claimAgent(ownerId: string, agentKey: string): Promise<any> {
    return this.post("/api/account/claim", { owner_id: ownerId, agent_key: agentKey });
  }

  async releaseAgent(ownerId: string, agentId: string): Promise<any> {
    return this.post("/api/account/release", { owner_id: ownerId, agent_id: agentId });
  }

  async setAgentStatus(ownerId: string, agentId: string, status: "active" | "disabled"): Promise<any> {
    return this.post("/api/account/status", { owner_id: ownerId, agent_id: agentId, status });
  }

  private assertSafeDiscoveryAgentId(rawAgentId: string): string {
    const trimmed = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
    if (
      !trimmed ||
      trimmed.length > 160 ||
      /[/\\?#&\s\u0000-\u001F]/.test(trimmed) ||
      trimmed.includes("..") ||
      /^(?:ac_|agent_key_|sk[-_]|gh[pousr]_|github_pat_|AIza|eyJ)/i.test(trimmed) ||
      this.containsMemorySecretShape(trimmed)
    ) {
      throw new Error("Invalid agent ID");
    }
    return trimmed;
  }

  private assertSafeHttpsProbeEndpoint(rawBaseUrl: string): string {
    const trimmed = typeof rawBaseUrl === "string" ? rawBaseUrl.trim() : "";
    if (!trimmed || trimmed.length > 512 || /[\u0000-\u001F]/.test(trimmed)) {
      throw new Error("A valid HTTPS API Base URL is required");
    }
    if (this.containsMemorySecretShape(trimmed)) {
      throw new Error("API Base URL must not contain secrets");
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error("A valid HTTPS API Base URL is required");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("Only HTTPS API Base URLs are supported");
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("API Base URL must not include credentials, query parameters, or fragments");
    }
    if (isPrivateOrReservedHost(parsed.hostname)) {
      throw new Error("Private or internal network endpoints are not allowed");
    }
    return parsed.toString();
  }

  async discoverChannels(
    query?: string,
    limit = 20,
    opts?: import("./types").DiscoverChannelsOptions,
  ): Promise<DiscoverableChannelSummary[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Invalid limit");
    }
    const params = new URLSearchParams();
    if (query !== undefined) {
      const q = query.trim();
      if (q.length > 200 || /[\u0000-\u001F]/.test(q) || this.containsMemorySecretShape(q)) {
        throw new Error("Invalid search query");
      }
      if (q.length > 0) params.set("q", q);
    }
    params.set("limit", String(limit));
    if (opts?.agent_id !== undefined) {
      params.set("agent_id", this.assertSafeDiscoveryAgentId(opts.agent_id));
    }
    const data = await this.get<{ channels: DiscoverableChannelSummary[] }>(
      `/api/channels/discover?${params.toString()}`,
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(opts?.bearerToken) ?? {}),
      },
    );
    return rankDiscoverableChannels(data?.channels, limit);
  }

  async getCloudAgentCatalog(opts?: { bearerToken?: string }): Promise<import("./types").CloudAgentCatalogResponse> {
    return this.get<import("./types").CloudAgentCatalogResponse>("/api/cloud-agents/catalog", {
      "Cache-Control": "no-store",
      ...(this.authHeaders(opts?.bearerToken) ?? {}),
    });
  }

  async getCloudAgentModels(opts?: { bearerToken?: string }): Promise<import("./types").CloudAgentModelsResponse> {
    return this.get<import("./types").CloudAgentModelsResponse>("/api/cloud-agents/models", {
      "Cache-Control": "no-store",
      ...(this.authHeaders(opts?.bearerToken) ?? {}),
    });
  }

  async probeCloudEndpointModels(
    input: import("./types").ProbeCloudEndpointModelsInput,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ProbeCloudEndpointModelsResponse> {
    const safeBaseUrl = this.assertSafeHttpsProbeEndpoint(input?.base_url);
    const body: Record<string, unknown> = { base_url: safeBaseUrl };
    if (input?.api_key !== undefined) {
      if (typeof input.api_key !== "string" || input.api_key.length > 512 || /[\u0000-\u001F]/.test(input.api_key)) {
        throw new Error("Invalid api_key");
      }
      const trimmedKey = input.api_key.trim();
      if (trimmedKey) body.api_key = trimmedKey;
    }
    if (input?.agent_id !== undefined) {
      body.agent_id = this.assertSafeDiscoveryAgentId(input.agent_id);
    }
    const bearerToken = input?.bearerToken ?? opts?.bearerToken;
    return this.post<import("./types").ProbeCloudEndpointModelsResponse>(
      "/api/cloud-agents/probe-models",
      body,
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(bearerToken) ?? {}),
      },
    );
  }

  async myChannels(
    agentIdOrQuery?: string | import("./types").MyChannelsQuery,
    opts?: { include_owned?: boolean; bearerToken?: string },
  ): Promise<import("./types").MyChannelSummaryItem[]> {
    const queryObj =
      agentIdOrQuery !== undefined && typeof agentIdOrQuery === "object" && agentIdOrQuery !== null
        ? agentIdOrQuery
        : undefined;
    const rawAgentId = typeof agentIdOrQuery === "string" ? agentIdOrQuery : queryObj?.agent_id;
    const includeOwned = queryObj?.include_owned ?? opts?.include_owned;
    const bearerToken = queryObj?.bearerToken ?? opts?.bearerToken;

    const params = new URLSearchParams();
    if (rawAgentId !== undefined) {
      const trimmed = rawAgentId.trim();
      if (
        !trimmed ||
        trimmed.length > 160 ||
        /[/\\?#&\s\u0000-\u001F]/.test(trimmed) ||
        trimmed.includes("..") ||
        /^(?:ac_|agent_key_|sk[-_]|gh[pousr]_|github_pat_|AIza|eyJ)/i.test(trimmed)
      ) {
        throw new Error("Invalid agent ID");
      }
      params.set("agent_id", trimmed);
    }
    if (includeOwned === true) {
      params.set("include_owned", "1");
    }
    const qs = params.size > 0 ? `?${params.toString()}` : "";
    const data = await this.get<{ channels: import("./types").MyChannelSummaryItem[] }>(
      `/api/channels/mine${qs}`,
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(bearerToken) ?? {}),
      },
    );
    return data.channels;
  }

  async getMe(opts?: { bearerToken?: string }): Promise<import("./types").AccountMeResponse> {
    return this.get<import("./types").AccountMeResponse>("/api/account/me", {
      "Cache-Control": "no-store",
      ...(this.authHeaders(opts?.bearerToken) ?? {}),
    });
  }

  async listMyIdentities(opts?: { bearerToken?: string }): Promise<import("./types").AccountIdentitiesResponse> {
    return this.get<import("./types").AccountIdentitiesResponse>("/api/account/me/identities", {
      "Cache-Control": "no-store",
      ...(this.authHeaders(opts?.bearerToken) ?? {}),
    });
  }

  async listOwnedAgents(
    ownerId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").OwnedAgentsListResponse> {
    const trimmed = typeof ownerId === "string" ? ownerId.trim() : "";
    if (
      !trimmed ||
      trimmed.length > 160 ||
      /[/\\?#&\s\u0000-\u001F]/.test(trimmed) ||
      trimmed === "." ||
      trimmed.includes("..") ||
      /^(?:ac_|agent_key_|sk[-_]|gh[pousr]_|github_pat_|AIza|eyJ)/i.test(trimmed)
    ) {
      throw new Error("Invalid owner ID");
    }
    return this.get<import("./types").OwnedAgentsListResponse>(
      `/api/account/${encodeURIComponent(trimmed)}/agents`,
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(opts?.bearerToken) ?? {}),
      },
    );
  }

  // MARK: - Owner-Scoped Cloud Agent Forensic Security Audit

  async getCloudAgentAuditLogs(
    agentId: string,
    opts?: { limit?: number; result?: CloudAgentAuditResult; bearerToken?: string },
  ): Promise<CloudAgentAuditFeed> {
    if (!isSafeCloudAuditAgentId(agentId) || this.containsMemorySecretShape(agentId)) {
      throw new Error("Invalid cloud agent ID");
    }
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) {
      if (!Number.isFinite(opts.limit)) throw new Error("Invalid audit limit");
      params.set("limit", String(Math.max(1, Math.min(50, Math.trunc(opts.limit)))));
    }
    if (opts?.result !== undefined) {
      if (!["ok", "denied", "error"].includes(opts.result)) throw new Error("Invalid audit result filter");
      params.set("result", opts.result);
    }
    const qs = params.toString();
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const raw = await this.get<unknown>(
      `/api/cloud-agents/${encodeURIComponent(agentId)}/audit${qs ? `?${qs}` : ""}`,
      headers,
    );
    const summary = summarizeCloudAgentAuditFeed(raw, agentId);
    if (!summary) {
      throw new Error("Invalid cloud agent audit feed");
    }
    return {
      agent_id: summary.agent_id,
      observation_only: true,
      entries: summary.entries.map(({ is_replay_revocation: _flag, ...entry }) => entry),
    };
  }

  // MARK: - Room-Scoped Cloud Agent Wake-Health Diagnostics

  async getChannelWakeHealth(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelWakeHealth> {
    const safeChannel = typeof channelId === "string" ? channelId.trim() : "";
    if (!safeNonDmChannelId(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.get<import("./types").ChannelWakeHealth>(
      `/api/channels/${encodeURIComponent(safeChannel)}/wake-health`,
      headers,
    );
  }

  // MARK: - Room & Caller Autonomous Loop Schedules (/api/loops)

  async getChannelLoops(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").RoomLoopsFeed> {
    const safeChannel = typeof channelId === "string" ? channelId.trim() : "";
    if (
      !safeChannel ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) ||
      safeChannel.includes("..") ||
      CREDENTIAL_PREFIX_RE.test(safeChannel) ||
      EMBEDDED_SECRET_TOKEN_RE.test(safeChannel)
    ) {
      throw new Error("Invalid channel ID");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.get<import("./types").RoomLoopsFeed>(
      `/api/loops?channel_id=${encodeURIComponent(safeChannel)}`,
      headers,
    );
  }

  async getMyLoops(opts?: {
    agent_id?: string;
    include_owned?: boolean;
    bearerToken?: string;
  }): Promise<import("./types").RoomLoopsFeed> {
    const params = new URLSearchParams();
    if (opts?.agent_id !== undefined) {
      const safeAgent = opts.agent_id.trim();
      if (
        !safeAgent ||
        safeAgent.length > 128 ||
        /[/\\?#&\s\u0000-\u001F]/.test(safeAgent) ||
        safeAgent.includes("..") ||
        /^(?:ac_|agent_key_|sk[-_]|gh[pousr]_|github_pat_|AIza|eyJ)/i.test(safeAgent)
      ) {
        throw new Error("Invalid agent ID");
      }
      params.set("agent_id", safeAgent);
    }
    if (opts?.include_owned) {
      params.set("include_owned", "1");
    }
    const qs = params.toString();
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.get<import("./types").RoomLoopsFeed>(`/api/loops/mine${qs ? `?${qs}` : ""}`, headers);
  }

  // MARK: - Single-RTT Room Capability & Readiness Brief (/api/channels/:id/brief)

  async getChannelBrief(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelBrief> {
    const safeChannel = typeof channelId === "string" ? channelId.trim() : "";
    if (
      !safeNonDmChannelId(safeChannel) ||
      PROTOTYPE_POISON_KEYS.has(safeChannel.toLowerCase()) ||
      EMBEDDED_SECRET_TOKEN_RE.test(safeChannel)
    ) {
      throw new Error("Invalid channel ID");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.get<import("./types").ChannelBrief>(
      `/api/channels/${encodeURIComponent(safeChannel)}/brief`,
      headers,
    );
  }

  // MARK: - Workspace Graph (/api/workspace/graph)

  async getWorkspaceGraph(
    scope: import("./types").WorkspaceGraphScopeType,
    id: string,
    opts?: { since?: string; bearerToken?: string },
  ): Promise<import("./types").WorkspaceGraph> {
    if (!["channel", "objective", "agent"].includes(scope)) {
      throw new Error("Invalid workspace graph scope");
    }
    const trimmedId = typeof id === "string" ? id.trim() : "";
    if (
      !safeGraphId(trimmedId) ||
      (scope === "channel" && DM_OR_DIRECT_CHANNEL_RE.test(trimmedId)) ||
      this.containsMemorySecretShape(trimmedId)
    ) {
      throw new Error("Invalid workspace graph ID");
    }
    const params = new URLSearchParams({ scope, id: trimmedId });
    if (opts?.since !== undefined) {
      const since = typeof opts.since === "string" ? opts.since.trim() : "";
      if (
        !since ||
        since.length > 64 ||
        !/^\d{4}-\d{2}-\d{2}T/.test(since) ||
        Number.isNaN(Date.parse(since))
      ) {
        throw new Error("Invalid workspace graph since timestamp");
      }
      params.set("since", since);
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.get<import("./types").WorkspaceGraph>(
      `/api/workspace/graph?${params.toString()}`,
      headers,
    );
  }

  // MARK: - Room Consensus Proposals (/api/channels/:id/proposals)

  async listChannelProposals(
    channelId: string,
    opts?: { limit?: number; bearerToken?: string },
  ): Promise<import("./types").ChannelProposalsFeed> {
    const safeChannel = typeof channelId === "string" ? channelId.trim() : "";
    if (
      !safeNonDmChannelId(safeChannel) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) ||
      this.containsMemorySecretShape(safeChannel)
    ) {
      throw new Error("Invalid channel ID");
    }
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) {
      if (!Number.isFinite(opts.limit)) throw new Error("Invalid proposals limit");
      params.set("limit", String(Math.max(1, Math.min(100, Math.trunc(opts.limit)))));
    }
    const qs = params.toString();
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const raw = await this.get<import("./types").ChannelProposalsFeed>(
      `/api/channels/${encodeURIComponent(safeChannel)}/proposals${qs ? `?${qs}` : ""}`,
      headers,
    );
    if (raw && typeof raw.channel_id === "string" && raw.channel_id.trim() && raw.channel_id.trim() !== safeChannel) {
      throw new Error("Channel proposals response channel mismatch");
    }
    return raw;
  }

  async createChannelProposal(
    channelId: string,
    input: import("./types").CreateChannelProposalInput,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").CreateChannelProposalResponse> {
    const safeChannel = typeof channelId === "string" ? channelId.trim() : "";
    if (
      !safeNonDmChannelId(safeChannel) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) ||
      this.containsMemorySecretShape(safeChannel)
    ) {
      throw new Error("Invalid channel ID");
    }
    const safePropId = input?.id !== undefined ? (typeof input.id === "string" ? input.id.trim() : "") : undefined;
    if (
      safePropId !== undefined &&
      (!safeGraphId(safePropId) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safePropId) ||
        EMBEDDED_SECRET_TOKEN_RE.test(safePropId) ||
        this.containsMemorySecretShape(safePropId))
    ) {
      throw new Error("Invalid proposal ID");
    }
    const safeSenderId =
      input?.sender_id !== undefined ? (typeof input.sender_id === "string" ? input.sender_id.trim() : "") : undefined;
    if (
      safeSenderId !== undefined &&
      (!isSafeCollaborationAgentId(safeSenderId) ||
        EMBEDDED_SECRET_TOKEN_RE.test(safeSenderId) ||
        this.containsMemorySecretShape(safeSenderId))
    ) {
      throw new Error("Invalid proposal sender_id");
    }
    const title = input?.title?.trim() ?? "";
    if (!title || title.length > 500) {
      throw new Error("Invalid proposal title");
    }
    if (input.consensus_rule && !["majority", "super_majority", "unanimous"].includes(input.consensus_rule)) {
      throw new Error("Invalid consensus rule");
    }
    if (input.expires_at !== undefined && input.expires_at !== "" && Number.isNaN(Date.parse(input.expires_at))) {
      throw new Error("Invalid proposal expires_at timestamp");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const body: Record<string, unknown> = {
      title,
      ...(safePropId !== undefined ? { id: safePropId } : {}),
      ...(safeSenderId !== undefined ? { sender_id: safeSenderId } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.code_diff !== undefined ? { code_diff: input.code_diff } : {}),
      ...(input.consensus_rule !== undefined ? { consensus_rule: input.consensus_rule } : {}),
      ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
    };
    return this.post<import("./types").CreateChannelProposalResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/proposals`,
      body,
      headers,
    );
  }

  async voteChannelProposal(
    channelId: string,
    proposalId: string,
    input: import("./types").VoteChannelProposalInput,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").VoteChannelProposalResponse> {
    const safeChannel = typeof channelId === "string" ? channelId.trim() : "";
    if (
      !safeNonDmChannelId(safeChannel) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) ||
      this.containsMemorySecretShape(safeChannel)
    ) {
      throw new Error("Invalid channel ID");
    }
    const safeProposal = typeof proposalId === "string" ? proposalId.trim() : "";
    if (
      !safeGraphId(safeProposal) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeProposal) ||
      EMBEDDED_SECRET_TOKEN_RE.test(safeProposal) ||
      this.containsMemorySecretShape(safeProposal)
    ) {
      throw new Error("Invalid proposal ID");
    }
    const safeVoterId =
      input?.voter_id !== undefined ? (typeof input.voter_id === "string" ? input.voter_id.trim() : "") : undefined;
    if (
      safeVoterId !== undefined &&
      (!isSafeCollaborationAgentId(safeVoterId) ||
        EMBEDDED_SECRET_TOKEN_RE.test(safeVoterId) ||
        this.containsMemorySecretShape(safeVoterId))
    ) {
      throw new Error("Invalid proposal voter_id");
    }
    if (!input || !["approve", "reject", "abstain"].includes(input.decision)) {
      throw new Error("Invalid vote decision");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const body: Record<string, unknown> = {
      decision: input.decision,
      ...(safeVoterId !== undefined ? { voter_id: safeVoterId } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    };
    return this.post<import("./types").VoteChannelProposalResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/proposals/${encodeURIComponent(safeProposal)}/votes`,
      body,
      headers,
    );
  }

  async getChannelPins(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelPinsResponse> {
    const safeChannel = typeof channelId === "string" ? channelId.trim() : "";
    if (
      !safeNonDmChannelId(safeChannel) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel)
    ) {
      throw new Error("Invalid channel ID");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const raw = await this.get<{ channel_id?: unknown; pinned_messages?: unknown }>(
      `/api/channels/${encodeURIComponent(safeChannel)}/pins`,
      headers,
    );
    const respChannel = typeof raw?.channel_id === "string" && raw.channel_id.trim() ? raw.channel_id.trim() : safeChannel;
    if (respChannel !== safeChannel) {
      throw new Error("Channel pins response channel mismatch");
    }
    const seen = new Set<string>();
    const pinnedMessages: string[] = [];
    if (Array.isArray(raw?.pinned_messages)) {
      for (const item of raw.pinned_messages.slice(0, 500)) {
        if (typeof item !== "string") continue;
        const trimmed = item.trim();
        if (
          !safeGraphId(trimmed) ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed) ||
          EMBEDDED_SECRET_TOKEN_RE.test(trimmed) ||
          seen.has(trimmed)
        ) {
          continue;
        }
        seen.add(trimmed);
        pinnedMessages.push(trimmed);
      }
    }
    return {
      channel_id: safeChannel,
      pinned_messages: pinnedMessages,
    };
  }

  // MARK: - Realtime Channel SSE Stream (/api/channels/:id/stream)

  async *iterateChannelEvents(
    channelId: string,
    opts?: import("./types").IterateChannelEventsOptions,
  ): AsyncGenerator<Record<string, unknown>, void, unknown> {
    const safeChannel = channelId?.trim() ?? "";
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) ||
      safeChannel.includes("..") ||
      /^(?:ac_|agent_key_|sk[-_])/i.test(safeChannel)
    ) {
      throw new Error("Invalid channel ID");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const res = await fetch(
      `${this.baseUrl}/api/channels/${encodeURIComponent(safeChannel)}/stream`,
      {
        method: "GET",
        headers,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      },
    );
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    if (!res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const maxBufferChars = 262_144;
    let buffer = "";

    let abortWakeup: (() => void) | null = null;
    const onAbort = () => {
      abortWakeup?.();
      void reader.cancel().catch(() => {});
    };
    opts?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (true) {
        if (opts?.signal?.aborted) break;
        const readResult = await new Promise<{ done: boolean; value?: Uint8Array } | null>((resolve, reject) => {
          abortWakeup = () => resolve(null);
          reader.read().then(
            (r) => resolve(r),
            (err) => {
              if (opts?.signal?.aborted) resolve(null);
              else reject(err);
            },
          );
        });
        abortWakeup = null;
        if (!readResult || opts?.signal?.aborted) break;
        const { value, done } = readResult;
        if (value) {
          buffer += decoder.decode(value, { stream: !done });
        } else if (done) {
          buffer += decoder.decode();
        }
        const parsed = parseSseFrames(buffer, maxBufferChars);
        buffer = parsed.rest;
        for (const evt of parsed.events) {
          if (opts?.signal?.aborted) break;
          yield evt;
        }
        if (done) {
          if (buffer.trim() && !opts?.signal?.aborted) {
            const flushed = parseSseFrames(`${buffer}\n\n`, maxBufferChars);
            for (const evt of flushed.events) {
              if (opts?.signal?.aborted) break;
              yield evt;
            }
          }
          break;
        }
      }
    } finally {
      opts?.signal?.removeEventListener("abort", onAbort);
      await reader.cancel().catch(() => {});
    }
  }

  async streamChannelEvents(
    channelId: string,
    opts: import("./types").StreamChannelEventsOptions,
  ): Promise<void> {
    if (!opts || typeof opts.onEvent !== "function") {
      throw new Error("Invalid SSE onEvent callback");
    }
    for await (const evt of this.iterateChannelEvents(channelId, opts)) {
      await opts.onEvent(evt);
    }
  }

  // MARK: - Personal Skills Library (/api/skills)

  private assertSkillName(name: string): string {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!isValidPersonalSkillSlug(trimmed)) {
      throw new Error("Invalid personal skill name");
    }
    return trimmed;
  }

  private assertLoopId(loopId: string): string {
    const trimmed = loopId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed) || /^(?:ac_|sk[-_])/i.test(trimmed)) {
      throw new Error("Invalid loop ID");
    }
    return trimmed;
  }

  async listPersonalSkills(
    opts?: { active_only?: boolean; bearerToken?: string },
  ): Promise<import("./types").PersonalSkillsListResponse> {
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const qs = opts?.active_only ? "?active_only=true" : "";
    return this.get<import("./types").PersonalSkillsListResponse>(`/api/skills${qs}`, headers);
  }

  async getPersonalSkill(
    name: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").PersonalSkillDetail> {
    const safeName = this.assertSkillName(name);
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.get<import("./types").PersonalSkillDetail>(
      `/api/skills/${encodeURIComponent(safeName)}`,
      headers,
    );
  }

  async getPersonalSkillRevisions(
    name: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").PersonalSkillRevisionsResponse> {
    const safeName = this.assertSkillName(name);
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.get<import("./types").PersonalSkillRevisionsResponse>(
      `/api/skills/${encodeURIComponent(safeName)}/revisions`,
      headers,
    );
  }

  async savePersonalSkill(
    name: string,
    input: import("./types").SavePersonalSkillInput,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").SavePersonalSkillResponse> {
    const safeName = this.assertSkillName(name);
    if (!input?.body_markdown || typeof input.body_markdown !== "string" || !input.body_markdown.trim()) {
      throw new Error("Invalid personal skill body_markdown");
    }
    const utf8Bytes = new TextEncoder().encode(input.body_markdown).byteLength;
    if (utf8Bytes > PERSONAL_SKILL_SERVER_BYTE_CAP) {
      throw new Error("Personal skill body_markdown exceeds 100000 UTF-8 bytes");
    }
    if (!hasValidSkillFrontmatter(input.body_markdown)) {
      throw new Error("Personal skill body_markdown requires YAML frontmatter with name and description");
    }
    if (
      input.if_match_version !== undefined &&
      (!Number.isSafeInteger(input.if_match_version) || input.if_match_version < 0)
    ) {
      throw new Error("Invalid personal skill if_match_version");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(input.if_match_version !== undefined ? { "If-Match": `"${input.if_match_version}"` } : {}),
    };
    const res = await fetch(`${this.baseUrl}/api/skills/${encodeURIComponent(safeName)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        body_markdown: input.body_markdown,
        ...(input.if_match_version !== undefined ? { if_match_version: input.if_match_version } : {}),
      }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  async archivePersonalSkill(
    name: string,
    expectedVersion: number,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ArchivePersonalSkillResponse> {
    const safeName = this.assertSkillName(name);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new Error("Invalid personal skill expectedVersion");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "If-Match": `"${expectedVersion}"`,
    };
    const res = await fetch(`${this.baseUrl}/api/skills/${encodeURIComponent(safeName)}`, {
      method: "DELETE",
      headers,
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  // MARK: - Room Loop Governance (/api/loops)

  async createLoop(
    input: import("./types").CreateRoomLoopInput,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").RoomLoopMutationResponse> {
    const channelId = input?.channel_id?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channelId) || /^(?:ac_|sk-)/i.test(channelId)) {
      throw new Error("Invalid channel ID");
    }
    const mode = input.mode ?? "prompt";
    if (!["prompt", "okr_wake", "okr_watch"].includes(mode)) {
      throw new Error("Invalid loop mode");
    }
    if (
      input.stall_minutes !== undefined &&
      (!Number.isInteger(input.stall_minutes) || input.stall_minutes < 5 || input.stall_minutes > 1440)
    ) {
      throw new Error("Invalid loop stall_minutes");
    }
    let safeDelegatedAgent: string | undefined;
    if (input.agent_id !== undefined) {
      const trimmedAgent = input.agent_id.trim();
      if (
        !trimmedAgent ||
        trimmedAgent.length > 128 ||
        /[/\\?#&\s\u0000-\u001F]/.test(trimmedAgent) ||
        trimmedAgent.includes("..") ||
        /^(?:ac_|agent_key_|sk[-_]|gh[pousr]_|github_pat_|AIza|eyJ)/i.test(trimmedAgent)
      ) {
        throw new Error("Invalid agent ID");
      }
      safeDelegatedAgent = trimmedAgent;
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const body: Record<string, unknown> = {
      channel_id: channelId,
      mode,
      ...(safeDelegatedAgent !== undefined ? { agent_id: safeDelegatedAgent } : {}),
      ...(input.interval !== undefined ? { interval: input.interval } : {}),
      ...(input.interval_ms !== undefined ? { interval_ms: input.interval_ms } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.objective_id !== undefined ? { objective_id: input.objective_id } : {}),
      ...(input.target_agent_id !== undefined ? { target_agent_id: input.target_agent_id } : {}),
      ...(input.target_agents !== undefined ? { target_agents: input.target_agents } : {}),
      ...(input.watch_idle !== undefined ? { watch_idle: input.watch_idle } : {}),
      ...(input.watch_supply !== undefined ? { watch_supply: input.watch_supply } : {}),
      ...(input.stall_minutes !== undefined ? { stall_minutes: input.stall_minutes } : {}),
    };
    return this.post<import("./types").RoomLoopMutationResponse>("/api/loops", body, headers);
  }

  async createOkrWatchLoop(
    input: import("./types").CreateOkrWatchLoopInput,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").RoomLoopMutationResponse> {
    const channelId = input?.channel_id?.trim() ?? "";
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channelId) ||
      channelId.startsWith("arena-") ||
      OKR_WATCH_DIRECT_CHANNEL_RE.test(channelId) ||
      !isSafeOkrWatchId(channelId)
    ) {
      throw new Error("Invalid channel ID");
    }
    const objectiveId = input?.objective_id?.trim() ?? "";
    if (!/^[A-Za-z0-9_-]{6,80}$/.test(objectiveId) || !isSafeOkrWatchId(objectiveId)) {
      throw new Error("Invalid objective ID");
    }
    let safeAgent: string | undefined;
    if (input.agent_id !== undefined) {
      const trimmedAgent = input.agent_id.trim();
      if (!isSafeOkrWatchId(trimmedAgent)) {
        throw new Error("Invalid agent ID");
      }
      safeAgent = trimmedAgent;
    }
    if (
      input.interval_ms !== undefined &&
      (!Number.isInteger(input.interval_ms) || input.interval_ms < 60_000 || input.interval_ms > 86_400_000)
    ) {
      throw new Error("interval_ms must be an integer between 60000 and 86400000");
    }
    if (
      input.stall_minutes !== undefined &&
      (!Number.isInteger(input.stall_minutes) || input.stall_minutes < 5 || input.stall_minutes > 1440)
    ) {
      throw new Error("Invalid loop stall_minutes");
    }
    const token = opts?.bearerToken?.trim() || input.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const body: Record<string, unknown> = {
      channel_id: channelId,
      objective_id: objectiveId,
      ...(safeAgent !== undefined ? { agent_id: safeAgent } : {}),
      ...(input.interval_ms !== undefined ? { interval_ms: input.interval_ms } : {}),
      ...(input.watch_idle !== undefined ? { watch_idle: Boolean(input.watch_idle) } : {}),
      ...(input.watch_supply !== undefined ? { watch_supply: Boolean(input.watch_supply) } : {}),
      ...(input.stall_minutes !== undefined ? { stall_minutes: input.stall_minutes } : {}),
    };
    return this.post<import("./types").RoomLoopMutationResponse>("/api/loops/okr-watch", body, headers);
  }

  async pauseLoop(
    loopId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").RoomLoopMutationResponse> {
    const safeId = this.assertLoopId(loopId);
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.post<import("./types").RoomLoopMutationResponse>(
      `/api/loops/${encodeURIComponent(safeId)}/pause`,
      {},
      headers,
    );
  }

  async resumeLoop(
    loopId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").RoomLoopMutationResponse> {
    const safeId = this.assertLoopId(loopId);
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.post<import("./types").RoomLoopMutationResponse>(
      `/api/loops/${encodeURIComponent(safeId)}/resume`,
      {},
      headers,
    );
  }

  async stopLoop(
    loopId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").RoomLoopMutationResponse> {
    const safeId = this.assertLoopId(loopId);
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.post<import("./types").RoomLoopMutationResponse>(
      `/api/loops/${encodeURIComponent(safeId)}/stop`,
      {},
      headers,
    );
  }

  async setLoopInterval(
    loopId: string,
    intervalMs: number,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").RoomLoopMutationResponse> {
    const safeId = this.assertLoopId(loopId);
    if (!Number.isInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 86_400_000) {
      throw new Error("Invalid loop interval_ms");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.post<import("./types").RoomLoopMutationResponse>(
      `/api/loops/${encodeURIComponent(safeId)}/interval`,
      { interval_ms: intervalMs },
      headers,
    );
  }

  // MARK: - OKR Structured Working Memory Governance (/api/okr)

  private assertOkrEntityId(rawId: string, label: string): string {
    const trimmed = rawId?.trim() ?? "";
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed) ||
      trimmed.includes("..") ||
      CREDENTIAL_PREFIX_RE.test(trimmed) ||
      EMAIL_ID_RE.test(trimmed) ||
      PHONE_ID_RE.test(trimmed)
    ) {
      throw new Error(`Invalid ${label}`);
    }
    return trimmed;
  }

  private assertOkrVersion(version: string | undefined): string | undefined {
    if (version === undefined) return undefined;
    const trimmed = version.trim();
    if (!trimmed || trimmed.length > 64 || Number.isNaN(Date.parse(trimmed)) || /[\x00-\x1f\x7f]/.test(trimmed)) {
      throw new Error("Invalid OKR if_match_updated_at version");
    }
    return trimmed;
  }

  private authHeaders(bearerToken?: string): Record<string, string> {
    const token = bearerToken?.trim() || this.bearerToken;
    return {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async listObjectives(opts?: import("./types").OkrListQuery): Promise<import("./types").OkrListResponse> {
    const params = new URLSearchParams();
    if (opts?.horizon !== undefined) {
      if (!["week", "month", "Q"].includes(opts.horizon)) throw new Error("Invalid OKR horizon");
      params.set("horizon", opts.horizon);
    }
    if (opts?.status !== undefined) {
      if (!["active", "done", "abandoned"].includes(opts.status)) throw new Error("Invalid OKR status");
      params.set("status", opts.status);
    }
    if (opts?.owner !== undefined) {
      const owner = opts.owner.trim();
      if (
        !owner ||
        owner.length > 160 ||
        owner.includes("..") ||
        CREDENTIAL_PREFIX_RE.test(owner) ||
        EMAIL_ID_RE.test(owner) ||
        PHONE_ID_RE.test(owner) ||
        /[\x00-\x1f\x7f]/.test(owner)
      ) {
        throw new Error("Invalid OKR owner");
      }
      params.set("owner", owner);
    }
    if (opts?.include_archived) params.set("include_archived", "true");
    if (opts?.objective_id !== undefined) {
      params.set("objective_id", this.assertOkrEntityId(opts.objective_id, "objective ID"));
    }
    if (opts?.view !== undefined) {
      if (!["mine-active", "blocking-me", "blocked-by-me", "related"].includes(opts.view)) {
        throw new Error("Invalid OKR view");
      }
      params.set("view", opts.view);
    }
    if (opts?.task_id !== undefined) {
      params.set("task_id", this.assertOkrEntityId(opts.task_id, "task ID"));
    }
    if (opts?.shape !== undefined) {
      if (opts.shape !== "summary") throw new Error("Invalid OKR shape");
      params.set("shape", opts.shape);
    }
    const qs = params.toString();
    return this.get<import("./types").OkrListResponse>(
      `/api/okr/objectives${qs ? `?${qs}` : ""}`,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async createObjective(
    input: import("./types").CreateOkrObjectiveInput,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; objective: import("./types").OkrObjectiveItem }> {
    const title = input?.title?.trim() ?? "";
    if (!title || title.length > 200) throw new Error("Invalid objective title");
    if (!["week", "month", "Q"].includes(input?.horizon)) throw new Error("Invalid OKR horizon");
    if (input.parent_id !== undefined) this.assertOkrEntityId(input.parent_id, "parent objective ID");
    if (input.discussion_channel_id !== undefined) {
      this.assertOkrEntityId(input.discussion_channel_id, "channel ID");
    }
    const body: Record<string, unknown> = {
      title,
      horizon: input.horizon,
      ...(input.owner !== undefined ? { owner: input.owner.trim() } : {}),
      ...(input.due !== undefined ? { due: input.due.trim() } : {}),
      ...(input.parent_id !== undefined ? { parent_id: input.parent_id.trim() } : {}),
      ...(input.discussion_channel_id !== undefined ? { discussion_channel_id: input.discussion_channel_id.trim() } : {}),
      ...(input.narrative !== undefined ? { narrative: input.narrative } : {}),
    };
    return this.post("/api/okr/objectives", body, this.authHeaders(opts?.bearerToken));
  }

  async updateObjective(
    objectiveId: string,
    input: import("./types").UpdateOkrObjectiveInput,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; objective: import("./types").OkrObjectiveItem }> {
    const safeId = this.assertOkrEntityId(objectiveId, "objective ID");
    const cas = this.assertOkrVersion(input?.if_match_updated_at);
    if (input?.title !== undefined) {
      const t = input.title.trim();
      if (!t || t.length > 200) throw new Error("Invalid objective title");
    }
    if (input?.horizon !== undefined && !["week", "month", "Q"].includes(input.horizon)) {
      throw new Error("Invalid OKR horizon");
    }
    if (input?.status !== undefined && !["active", "done", "abandoned"].includes(input.status)) {
      throw new Error("Invalid OKR status");
    }
    const body: Record<string, unknown> = {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.horizon !== undefined ? { horizon: input.horizon } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.due !== undefined ? { due: input.due } : {}),
      ...(input.narrative !== undefined ? { narrative: input.narrative } : {}),
      ...(cas !== undefined ? { if_match_updated_at: cas } : {}),
    };
    return this.patch(`/api/okr/objectives/${encodeURIComponent(safeId)}`, body, this.authHeaders(opts?.bearerToken));
  }

  async reparentObjective(
    objectiveId: string,
    input: import("./types").ReparentOkrObjectiveInput,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; objective: import("./types").OkrObjectiveItem; unchanged?: boolean }> {
    const safeId = this.assertOkrEntityId(objectiveId, "objective ID");
    const cas = this.assertOkrVersion(input?.if_match_updated_at);
    let parentId: string | null = null;
    if (input?.parent_id !== null && input?.parent_id !== undefined && input.parent_id !== "") {
      parentId = this.assertOkrEntityId(input.parent_id, "parent objective ID");
      if (parentId === safeId) throw new Error("Objective cannot parent itself");
    }
    const body: Record<string, unknown> = {
      parent_id: parentId,
      ...(cas !== undefined ? { if_match_updated_at: cas } : {}),
    };
    return this.patch(
      `/api/okr/objectives/${encodeURIComponent(safeId)}/parent`,
      body,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async archiveObjective(
    objectiveId: string,
    input?: import("./types").ArchiveOkrObjectiveInput,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; objective: import("./types").OkrObjectiveItem; retired_loop_ids?: string[] }> {
    const safeId = this.assertOkrEntityId(objectiveId, "objective ID");
    const body: Record<string, unknown> = {};
    if (input?.completion_summary !== undefined) {
      const summary = input.completion_summary.trim();
      if (summary.length > 280) throw new Error("Completion summary exceeds 280 chars");
      body.completion_summary = summary;
    }
    return this.post(
      `/api/okr/objectives/${encodeURIComponent(safeId)}/archive`,
      body,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async unarchiveObjective(
    objectiveId: string,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; objective: import("./types").OkrObjectiveItem }> {
    const safeId = this.assertOkrEntityId(objectiveId, "objective ID");
    return this.post(
      `/api/okr/objectives/${encodeURIComponent(safeId)}/unarchive`,
      {},
      this.authHeaders(opts?.bearerToken),
    );
  }

  async createKr(
    objectiveId: string,
    input: import("./types").CreateOkrKrInput,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; kr: import("./types").OkrKeyResultItem }> {
    const safeOid = this.assertOkrEntityId(objectiveId, "objective ID");
    const title = input?.title?.trim() ?? "";
    if (!title || title.length > 200) throw new Error("Invalid KR title");
    if (!["count", "bool", "percent"].includes(input?.metric_type)) throw new Error("Invalid KR metric_type");
    if (!Number.isFinite(input?.target) || input.target < 0) throw new Error("Invalid KR target");
    if (input.metric_type === "bool" && input.target !== 0 && input.target !== 1) {
      throw new Error("Invalid bool KR target");
    }
    if (input.metric_type === "percent" && input.target > 100) {
      throw new Error("Invalid percent KR target");
    }
    const body: Record<string, unknown> = {
      title,
      metric_type: input.metric_type,
      target: input.target,
      ...(input.current !== undefined ? { current: input.current } : {}),
      ...(input.risk_level !== undefined ? { risk_level: input.risk_level } : {}),
    };
    return this.post(
      `/api/okr/objectives/${encodeURIComponent(safeOid)}/krs`,
      body,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async updateKr(
    krId: string,
    input: import("./types").UpdateOkrKrInput,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; kr: import("./types").OkrKeyResultItem }> {
    const safeId = this.assertOkrEntityId(krId, "KR ID");
    const cas = this.assertOkrVersion(input?.if_match_updated_at);
    if (input?.title !== undefined) {
      const t = input.title.trim();
      if (!t || t.length > 200) throw new Error("Invalid KR title");
    }
    if (input?.metric_type !== undefined && !["count", "bool", "percent"].includes(input.metric_type)) {
      throw new Error("Invalid KR metric_type");
    }
    if (input?.target !== undefined && (!Number.isFinite(input.target) || input.target < 0)) {
      throw new Error("Invalid KR target");
    }
    const body: Record<string, unknown> = {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.metric_type !== undefined ? { metric_type: input.metric_type } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.current !== undefined ? { current: input.current } : {}),
      ...(input.risk_level !== undefined ? { risk_level: input.risk_level } : {}),
      ...(cas !== undefined ? { if_match_updated_at: cas } : {}),
    };
    return this.patch(`/api/okr/krs/${encodeURIComponent(safeId)}`, body, this.authHeaders(opts?.bearerToken));
  }

  async updateKrProgress(
    krId: string,
    input: import("./types").UpdateOkrKrProgressInput,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; kr: import("./types").OkrKeyResultItem }> {
    const safeId = this.assertOkrEntityId(krId, "KR ID");
    const cas = this.assertOkrVersion(input?.if_match_updated_at);
    if (!Number.isFinite(input?.current) || input.current < 0) throw new Error("Invalid KR current progress");
    const body: Record<string, unknown> = {
      current: input.current,
      ...(input.risk_level !== undefined ? { risk_level: input.risk_level } : {}),
      ...(cas !== undefined ? { if_match_updated_at: cas } : {}),
    };
    return this.patch(
      `/api/okr/krs/${encodeURIComponent(safeId)}/progress`,
      body,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async createTask(
    objectiveId: string,
    input: import("./types").CreateOkrTaskInput,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; task: import("./types").OkrTaskItem }> {
    const safeOid = this.assertOkrEntityId(objectiveId, "objective ID");
    const title = input?.title?.trim() ?? "";
    if (!title || title.length > 200) throw new Error("Invalid task title");
    const assignee = input?.assignee?.trim() ?? "";
    if (!assignee || assignee.length > 160 || /^(?:ac_|sk[-_])/i.test(assignee)) {
      throw new Error("Invalid task assignee");
    }
    const body: Record<string, unknown> = {
      title,
      assignee,
      ...(input.due !== undefined ? { due: input.due } : {}),
      ...(input.contributes_to !== undefined ? { contributes_to: input.contributes_to } : {}),
      ...(input.depends_on !== undefined ? { depends_on: input.depends_on } : {}),
      ...(input.linked_channel_docs !== undefined ? { linked_channel_docs: input.linked_channel_docs } : {}),
    };
    return this.post(
      `/api/okr/objectives/${encodeURIComponent(safeOid)}/tasks`,
      body,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async updateTask(
    taskId: string,
    input: import("./types").UpdateOkrTaskInput,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; task: import("./types").OkrTaskItem }> {
    const safeId = this.assertOkrEntityId(taskId, "task ID");
    const cas = this.assertOkrVersion(input?.if_match_updated_at);
    if (input?.title !== undefined) {
      const t = input.title.trim();
      if (!t || t.length > 200) throw new Error("Invalid task title");
    }
    if (input?.status !== undefined && !["todo", "doing", "done", "blocked"].includes(input.status)) {
      throw new Error("Invalid task status");
    }
    if (input?.due !== undefined && input.due !== null && input.due !== "" && input.due.length > 32) {
      throw new Error("Invalid task due");
    }
    const normalizeEvidenceArray = (
      items: import("./types").OkrTaskEvidenceInput[],
      allowEmpty: boolean,
    ): import("./types").OkrTaskEvidenceInput[] => {
      if (!Array.isArray(items) || (!allowEmpty && items.length === 0) || items.length > 10) {
        throw new Error("Invalid task evidence list (expected up to 10 items)");
      }
      return items.map((ev) => {
        if (!ev || !VALID_EVIDENCE_KINDS.has(ev.kind)) {
          throw new Error("Invalid task evidence kind");
        }
        const ref = ev.ref?.trim() ?? "";
        if (!ref || ref.length > 500) {
          throw new Error("Invalid task evidence ref");
        }
        const note = ev.note?.trim();
        if (note !== undefined && note.length > 500) {
          throw new Error("Invalid task evidence note");
        }
        return {
          kind: ev.kind,
          ref,
          ...(note ? { note } : {}),
        };
      });
    };
    const normalizedEvidence =
      input?.evidence !== undefined ? normalizeEvidenceArray(input.evidence, true) : undefined;
    let normalizedAppendEvidence: import("./types").OkrTaskEvidenceInput[] | string | undefined;
    if (Array.isArray(input?.append_evidence)) {
      normalizedAppendEvidence = normalizeEvidenceArray(input.append_evidence, false);
    } else if (typeof input?.append_evidence === "string") {
      normalizedAppendEvidence = input.append_evidence;
    }
    const body: Record<string, unknown> = {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.assignee !== undefined ? { assignee: input.assignee.trim() } : {}),
      ...(input.due !== undefined ? { due: input.due } : {}),
      ...(input.blocked_reason !== undefined ? { blocked_reason: input.blocked_reason } : {}),
      ...(input.blocker_agent !== undefined ? { blocker_agent: input.blocker_agent } : {}),
      ...(input.contributes_to !== undefined ? { contributes_to: input.contributes_to } : {}),
      ...(input.depends_on !== undefined ? { depends_on: input.depends_on } : {}),
      ...(input.linked_channel_docs !== undefined ? { linked_channel_docs: input.linked_channel_docs } : {}),
      ...(normalizedEvidence !== undefined ? { evidence: normalizedEvidence } : {}),
      ...(normalizedAppendEvidence !== undefined ? { append_evidence: normalizedAppendEvidence } : {}),
      ...(cas !== undefined ? { if_match_updated_at: cas } : {}),
    };
    return this.patch(`/api/okr/tasks/${encodeURIComponent(safeId)}`, body, {
      "Cache-Control": "no-store",
      ...this.authHeaders(opts?.bearerToken),
    });
  }

  async updateOkrTask(
    taskId: string,
    input: import("./types").UpdateOkrTaskInput,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; task: import("./types").OkrTaskItem }> {
    return this.updateTask(taskId, input, opts);
  }

  async addTaskComment(
    taskId: string,
    text: string,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean; comment: import("./types").OkrTaskCommentItem }> {
    const safeId = this.assertOkrEntityId(taskId, "task ID");
    const trimmed = text?.trim() ?? "";
    if (!trimmed || trimmed.length > 2000) throw new Error("Invalid task comment text");
    return this.post(
      `/api/okr/tasks/${encodeURIComponent(safeId)}/comments`,
      { text: trimmed },
      this.authHeaders(opts?.bearerToken),
    );
  }

  async listTaskComments(
    taskId: string,
    opts?: { limit?: number; bearerToken?: string },
  ): Promise<import("./types").OkrTaskCommentsListResponse> {
    const safeId = this.assertOkrEntityId(taskId, "task ID");
    let query = "";
    if (opts?.limit !== undefined) {
      if (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > 200) {
        throw new Error("Invalid task comments limit (expected integer 1..200)");
      }
      query = `?limit=${opts.limit}`;
    }
    return this.get(`/api/okr/tasks/${encodeURIComponent(safeId)}/comments${query}`, {
      "Cache-Control": "no-store",
      ...this.authHeaders(opts?.bearerToken),
    });
  }

  async getTaskBlockers(
    taskId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").OkrTaskBlockersResponse> {
    const safeId = this.assertOkrEntityId(taskId, "task ID");
    return this.get(`/api/okr/tasks/${encodeURIComponent(safeId)}/blockers`, {
      "Cache-Control": "no-store",
      ...this.authHeaders(opts?.bearerToken),
    });
  }

  async getTaskBlocks(
    taskId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").OkrTaskBlocksResponse> {
    const safeId = this.assertOkrEntityId(taskId, "task ID");
    return this.get(`/api/okr/tasks/${encodeURIComponent(safeId)}/blocks`, {
      "Cache-Control": "no-store",
      ...this.authHeaders(opts?.bearerToken),
    });
  }

  async logTaskProgress(
    taskId: string,
    input?: import("./types").LogOkrTaskProgressInput,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").LogOkrTaskProgressResponse> {
    const safeId = this.assertOkrEntityId(taskId, "task ID");
    const body: Record<string, unknown> = {};
    if (input?.note !== undefined) {
      if (typeof input.note !== "string" || input.note.length > 500) {
        throw new Error("Invalid task progress note (max 500 chars)");
      }
      if (input.note.trim()) body.note = input.note.trim();
    }
    if (input?.wake_id !== undefined) {
      body.wake_id = this.assertOkrEntityId(input.wake_id, "wake ID");
    }
    return this.post(
      `/api/okr/tasks/${encodeURIComponent(safeId)}/progress`,
      body,
      {
        "Cache-Control": "no-store",
        ...this.authHeaders(opts?.bearerToken),
      },
    );
  }

  async openOkrThread(
    input: import("./types").OpenOkrThreadInput,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").OpenOkrThreadResponse> {
    if (!input || !["objective", "kr", "task"].includes(input.target_type)) {
      throw new Error("Invalid OKR thread target_type");
    }
    const safeTargetId = this.assertOkrEntityId(input.target_id, "target ID");
    return this.post(
      "/api/okr/threads",
      { target_type: input.target_type, target_id: safeTargetId },
      {
        "Cache-Control": "no-store",
        ...this.authHeaders(opts?.bearerToken),
      },
    );
  }

  async setOkrLinks(
    targetType: import("./types").OkrNodeType,
    targetId: string,
    input: import("./types").SetOkrLinksInput,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").SetOkrLinksResponse> {
    if (!["objective", "kr", "task"].includes(targetType)) {
      throw new Error("Invalid OKR link targetType");
    }
    const safeTargetId = this.assertOkrEntityId(targetId, `${targetType} ID`);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Invalid OKR links payload");
    }
    const cas = this.assertOkrVersion(input.if_match_updated_at);
    if ((input.narrative !== undefined || input.narrative_path !== undefined) && targetType !== "objective") {
      throw new Error("narrative and narrative_path are only supported on objective targets");
    }
    if (input.discussion_channel_id !== undefined && targetType !== "objective") {
      throw new Error("discussion_channel_id is only supported on objective targets");
    }
    const body: Record<string, unknown> = {
      ...(cas !== undefined ? { if_match_updated_at: cas } : {}),
    };
    if (input.narrative !== undefined) {
      if (input.narrative !== null && input.narrative !== "") {
        if (typeof input.narrative !== "string" || input.narrative.length > 4000) {
          throw new Error("Invalid objective narrative");
        }
      }
      body.narrative = input.narrative;
    }
    if (input.narrative_path !== undefined) {
      if (input.narrative_path !== null && input.narrative_path !== "") {
        if (
          typeof input.narrative_path !== "string" ||
          input.narrative_path.length > 256 ||
          input.narrative_path.includes("..") ||
          /[\x00-\x1f\x7f]/.test(input.narrative_path)
        ) {
          throw new Error("Invalid narrative_path");
        }
      }
      body.narrative_path = input.narrative_path;
    }
    if (input.discussion_channel_id !== undefined) {
      if (input.discussion_channel_id === null || input.discussion_channel_id === "") {
        body.discussion_channel_id = input.discussion_channel_id;
      } else {
        const safeCh = this.assertOkrEntityId(input.discussion_channel_id, "discussion_channel_id");
        if (/^(?:dm-|direct(?:$|[-_:]))/i.test(safeCh)) {
          throw new Error("OKR discussion_channel_id cannot target a direct message channel");
        }
        body.discussion_channel_id = safeCh;
      }
    }
    if (input.linked_docs !== undefined) {
      if (!Array.isArray(input.linked_docs) || input.linked_docs.length > 20) {
        throw new Error("Invalid linked_docs array (max 20)");
      }
      body.linked_docs = input.linked_docs.map((p) => {
        if (typeof p !== "string" || !p.trim() || p.length > 256 || p.includes("..") || this.containsMemorySecretShape(p)) {
          throw new Error("Invalid linked_docs path");
        }
        return p.trim();
      });
    }
    if (input.linked_channel_docs !== undefined) {
      if (!Array.isArray(input.linked_channel_docs) || input.linked_channel_docs.length > 20) {
        throw new Error("Invalid linked_channel_docs array (max 20)");
      }
      body.linked_channel_docs = input.linked_channel_docs.map((ref) => ({
        channel_id: this.assertOkrEntityId(ref?.channel_id, "linked_channel_docs.channel_id"),
        doc_id: this.assertChannelDocId(ref?.doc_id),
      }));
    }
    return this.patch(
      `/api/okr/links/${targetType}/${encodeURIComponent(safeTargetId)}`,
      body,
      {
        "Cache-Control": "no-store",
        ...this.authHeaders(opts?.bearerToken),
      },
    );
  }

  async transferObjective(
    objectiveId: string,
    input: import("./types").TransferOkrObjectiveInput,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").TransferOkrObjectiveResponse> {
    const safeOid = this.assertOkrEntityId(objectiveId, "objective ID");
    const newOwner = typeof input?.new_owner === "string" ? input.new_owner.trim() : "";
    if (!newOwner || newOwner.length > 160 || /[\x00-\x1f\x7f/]/.test(newOwner) || this.containsMemorySecretShape(newOwner)) {
      throw new Error("Invalid new_owner");
    }
    return this.post(
      `/api/okr/objectives/${encodeURIComponent(safeOid)}/transfer`,
      { new_owner: newOwner },
      {
        "Cache-Control": "no-store",
        ...this.authHeaders(opts?.bearerToken),
      },
    );
  }

  // MARK: - Channel Docs CAS & Revision History (/api/channels/:id/docs) & Key Rotation

  private assertChannelDocRoomId(channelId: string): string {
    const safeCh = this.assertOkrEntityId(channelId, "channel ID");
    if (
      PROTOTYPE_POISON_KEYS.has(safeCh.toLowerCase()) ||
      DM_OR_DIRECT_CHANNEL_RE.test(safeCh) ||
      CREDENTIAL_PREFIX_RE.test(safeCh) ||
      EMBEDDED_SECRET_TOKEN_RE.test(safeCh)
    ) {
      throw new Error("Invalid channel ID");
    }
    return safeCh;
  }

  private assertChannelDocId(docId: string): string {
    const trimmed = docId?.trim() ?? "";
    if (!isSafeChannelDocSlug(trimmed)) {
      throw new Error("Invalid channel doc ID");
    }
    return trimmed;
  }

  async listChannelDocs(
    channelId: string,
    opts?: { level?: 1 | 2 | 3 | 4; active_only?: boolean; bearerToken?: string },
  ): Promise<import("./types").ChannelDocsListResponse> {
    const safeCh = this.assertChannelDocRoomId(channelId);
    const params = new URLSearchParams();
    if (opts?.level !== undefined) {
      if (![1, 2, 3, 4].includes(opts.level)) throw new Error("Invalid channel doc level");
      params.set("level", String(opts.level));
    }
    if (opts?.active_only) params.set("active_only", "true");
    const qs = params.toString();
    return this.get<import("./types").ChannelDocsListResponse>(
      `/api/channels/${encodeURIComponent(safeCh)}/docs${qs ? `?${qs}` : ""}`,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async getChannelDoc(
    channelId: string,
    docId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelDocDetailItem> {
    const safeCh = this.assertChannelDocRoomId(channelId);
    const safeDoc = this.assertChannelDocId(docId);
    return this.get<import("./types").ChannelDocDetailItem>(
      `/api/channels/${encodeURIComponent(safeCh)}/docs/${encodeURIComponent(safeDoc)}`,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async getChannelDocRevisions(
    channelId: string,
    docId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelDocRevisionsResponse> {
    const safeCh = this.assertChannelDocRoomId(channelId);
    const safeDoc = this.assertChannelDocId(docId);
    return this.get<import("./types").ChannelDocRevisionsResponse>(
      `/api/channels/${encodeURIComponent(safeCh)}/docs/${encodeURIComponent(safeDoc)}/revisions`,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async saveChannelDoc(
    channelId: string,
    docId: string,
    input: import("./types").SaveChannelDocInput,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelDocDetailItem> {
    const safeCh = this.assertChannelDocRoomId(channelId);
    const safeDoc = this.assertChannelDocId(docId);
    const title = input?.title?.trim() ?? "";
    if (!title || title.length > 120) throw new Error("Invalid channel doc title");
    if (!["topic", "rules", "roles", "context", "deep_dive", "skill", "channel_skill"].includes(input?.kind)) {
      throw new Error("Invalid channel doc kind");
    }
    if (![1, 2, 3, 4].includes(input?.level)) throw new Error("Invalid channel doc level");
    if (typeof input?.body_markdown !== "string" || !input.body_markdown.trim()) {
      throw new Error("Invalid channel doc body_markdown");
    }
    if (
      (input.kind === "skill" || input.kind === "channel_skill") &&
      !parseChannelSkillFrontmatter(input.body_markdown).is_valid_skill
    ) {
      throw new Error("Invalid skill frontmatter: name and description are required");
    }
    if (!Number.isSafeInteger(input?.if_match_version) || input.if_match_version < 0) {
      throw new Error("Invalid channel doc if_match_version");
    }
    const headers: Record<string, string> = {
      ...this.authHeaders(opts?.bearerToken),
      "Content-Type": "application/json",
      "If-Match": `"${input.if_match_version}"`,
    };
    const res = await fetch(
      `${this.baseUrl}/api/channels/${encodeURIComponent(safeCh)}/docs/${encodeURIComponent(safeDoc)}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          title,
          kind: input.kind,
          level: input.level,
          body_markdown: input.body_markdown,
        }),
      },
    );
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  async archiveChannelDoc(
    channelId: string,
    docId: string,
    expectedVersion?: number,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ArchiveChannelDocResponse> {
    const safeCh = this.assertChannelDocRoomId(channelId);
    const safeDoc = this.assertChannelDocId(docId);
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new Error("Invalid channel doc expectedVersion");
    }
    const headers: Record<string, string> = {
      ...this.authHeaders(opts?.bearerToken),
      ...(expectedVersion !== undefined ? { "If-Match": `"${expectedVersion}"` } : {}),
    };
    const res = await fetch(
      `${this.baseUrl}/api/channels/${encodeURIComponent(safeCh)}/docs/${encodeURIComponent(safeDoc)}`,
      {
        method: "DELETE",
        headers,
      },
    );
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    const rawEtag = res.headers.get("ETag")?.replace(/^W\//i, "").replace(/^"|"$/g, "").trim();
    const parsedVer = rawEtag && /^\d+$/.test(rawEtag) ? Number(rawEtag) : undefined;
    if (res.status === 204) {
      return { archived: true, ...(parsedVer !== undefined ? { version: parsedVer } : {}) };
    }
    const data = await res.json().catch(() => ({}));
    return {
      archived: true,
      ...(typeof data?.version === "number" ? { version: data.version } : parsedVer !== undefined ? { version: parsedVer } : {}),
    };
  }

  async rotateAgentKey(
    agentId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").RotateAgentKeyResponse> {
    const trimmed = agentId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(trimmed) || /^(?:ac_|sk[-_])/i.test(trimmed)) {
      throw new Error("Invalid agent ID");
    }
    return this.post<import("./types").RotateAgentKeyResponse>(
      `/api/agents/${encodeURIComponent(trimmed)}/rotate-key`,
      {},
      this.authHeaders(opts?.bearerToken),
    );
  }

  // MARK: - Room Threads & OKR Snapshot (/api/channels/:id/threads & /okr_snapshot)

  async getChannelThreads(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelThreadsResponse> {
    const safeChannel = typeof channelId === "string" ? channelId.trim() : "";
    if (
      !safeNonDmChannelId(safeChannel) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel)
    ) {
      throw new Error("Invalid channel ID");
    }
    const raw = await this.get<{ channel_id?: unknown; threads?: unknown }>(
      `/api/channels/${encodeURIComponent(safeChannel)}/threads`,
      this.authHeaders(opts?.bearerToken),
    );
    const respChannel = typeof raw?.channel_id === "string" && raw.channel_id.trim() ? raw.channel_id.trim() : safeChannel;
    if (respChannel !== safeChannel) {
      throw new Error("Channel threads response channel mismatch");
    }
    const seen = new Set<string>();
    const threads: import("./types").ChannelThreadSummaryItem[] = [];
    if (Array.isArray(raw?.threads)) {
      for (const item of raw.threads.slice(0, 500)) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const rec = item as Record<string, unknown>;
        const parentId = typeof rec.parent_id === "string" ? rec.parent_id.trim() : "";
        if (
          !safeGraphId(parentId) ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(parentId) ||
          EMBEDDED_SECRET_TOKEN_RE.test(parentId) ||
          seen.has(parentId)
        ) {
          continue;
        }
        const replyCount =
          typeof rec.reply_count === "number" && Number.isFinite(rec.reply_count)
            ? Math.trunc(rec.reply_count)
            : 0;
        if (replyCount <= 0) continue;
        const parsedTs =
          typeof rec.last_reply_at === "string" && rec.last_reply_at.trim()
            ? Date.parse(rec.last_reply_at)
            : NaN;
        const lastReplyAt = Number.isFinite(parsedTs) ? new Date(parsedTs).toISOString() : "";
        seen.add(parentId);
        threads.push({
          parent_id: parentId,
          reply_count: Math.min(replyCount, 100_000),
          last_reply_at: lastReplyAt,
        });
      }
    }
    return {
      channel_id: safeChannel,
      threads,
    };
  }

  async getChannelOkrSnapshot(
    channelId: string,
    opts?: { include_archived?: boolean; bearerToken?: string },
  ): Promise<import("./types").ChannelOkrSnapshotResponse> {
    const safeChannel = typeof channelId === "string" ? channelId.trim() : "";
    if (
      !safeChannel ||
      safeChannel.includes("..") ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) ||
      CREDENTIAL_PREFIX_RE.test(safeChannel) ||
      EMAIL_ID_RE.test(safeChannel) ||
      PHONE_ID_RE.test(safeChannel)
    ) {
      throw new Error("Invalid channel ID");
    }
    const qs = opts?.include_archived ? "?include_archived=true" : "";
    return this.get<import("./types").ChannelOkrSnapshotResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/okr_snapshot${qs}`,
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(opts?.bearerToken) ?? {}),
      },
    );
  }

  // MARK: - Machine-Readable A2A / MCP Discovery & Room Membership Governance

  async getAgentCard(): Promise<import("./types").A2AAgentCard> {
    return this.get<import("./types").A2AAgentCard>("/.well-known/agent-card.json");
  }

  async getMcpDiscoveryCard(): Promise<import("./types").McpDiscoveryCard> {
    return this.get<import("./types").McpDiscoveryCard>("/.well-known/mcp.json");
  }

  async updateAgentCapabilities(
    agentId: string,
    capabilities: string[],
    opts?: { bearerToken?: string },
  ): Promise<import("./types").UpdateAgentCapabilitiesResponse> {
    const safeAgentId = agentId?.trim() ?? "";
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(safeAgentId) ||
      safeAgentId.includes("..") ||
      PROTOTYPE_POISON_KEYS.has(safeAgentId.toLowerCase()) ||
      CREDENTIAL_PREFIX_RE.test(safeAgentId) ||
      CUSTOM_SPECIALTY_SECRET_IN_ID_RE.test(safeAgentId)
    ) {
      throw new Error("Invalid agent ID");
    }
    if (!Array.isArray(capabilities)) {
      throw new Error("capabilities array required");
    }
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const raw of capabilities) {
      if (typeof raw !== "string") continue;
      const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
      if (!cleaned) continue;
      if (cleaned.length > 128) {
        throw new Error("Capability tag exceeds 128 chars");
      }
      if (
        PROTOTYPE_POISON_KEYS.has(cleaned.toLowerCase()) ||
        CREDENTIAL_PREFIX_RE.test(cleaned) ||
        CUSTOM_SPECIALTY_SECRET_IN_ID_RE.test(cleaned)
      ) {
        throw new Error("Capability tag must not resemble a credential");
      }
      const key = cleaned.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(cleaned);
      if (normalized.length >= 32) break;
    }
    return this.post<import("./types").UpdateAgentCapabilitiesResponse>(
      `/api/agents/${encodeURIComponent(safeAgentId)}/capabilities`,
      { capabilities: normalized },
      this.authHeaders(opts?.bearerToken),
    );
  }

  async getChannelMembers(
    channelId: string,
    opts?: { limit?: number; bearerToken?: string },
  ): Promise<import("./types").ChannelMembersResponse> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const qs = new URLSearchParams();
    if (typeof opts?.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0) {
      qs.set("limit", String(Math.min(1000, Math.max(1, Math.trunc(opts.limit)))));
    }
    const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
    return this.get<import("./types").ChannelMembersResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/members${suffix}`,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async getChannelCollaborationRoster(
    channelId: string,
    opts?: { limit?: number; bearerToken?: string },
  ): Promise<import("./types").ChannelCollaborationRosterResponse> {
    const safeChannel = typeof channelId === "string" ? channelId.trim() : "";
    if (
      !safeChannel ||
      !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(safeChannel) ||
      safeChannel.includes("..") ||
      CREDENTIAL_PREFIX_RE.test(safeChannel) ||
      EMAIL_ID_RE.test(safeChannel) ||
      PHONE_ID_RE.test(safeChannel)
    ) {
      throw new Error("Invalid channel ID");
    }
    const qs = new URLSearchParams({ view: "collaboration" });
    if (opts?.limit !== undefined) {
      if (!Number.isFinite(opts.limit) || opts.limit < 1) {
        throw new Error("Invalid roster limit");
      }
      qs.set("limit", String(Math.min(1000, Math.max(1, Math.trunc(opts.limit)))));
    }
    return this.get<import("./types").ChannelCollaborationRosterResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/members?${qs.toString()}`,
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(opts?.bearerToken) ?? {}),
      },
    );
  }

  async createStoryArtifact(
    input: import("./types").CreateStoryArtifactInput,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").CreateStoryArtifactResponse> {
    const safeChannel = typeof input?.channel_id === "string" ? input.channel_id.trim() : "";
    if (!safeChannel) {
      throw new Error("Invalid channel ID");
    }
    if (DM_OR_DIRECT_CHANNEL_RE.test(safeChannel)) {
      throw new Error("Story artifacts cannot be generated from direct message channels");
    }
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) ||
      safeChannel.includes("..") ||
      /^mr_[0-9a-f]{16,}$/i.test(safeChannel) ||
      PROTOTYPE_POISON_KEYS.has(safeChannel.toLowerCase()) ||
      /^\d{6,}$/.test(safeChannel) ||
      CREDENTIAL_PREFIX_RE.test(safeChannel) ||
      EMBEDDED_SECRET_TOKEN_RE.test(safeChannel) ||
      EMAIL_ID_RE.test(safeChannel) ||
      PHONE_ID_RE.test(safeChannel)
    ) {
      throw new Error("Invalid channel ID");
    }
    const validStoryTypes = ["debug_war_room", "agent_debate", "build_log", "brainstorm"];
    if (!validStoryTypes.includes(input?.story_type)) {
      throw new Error("Invalid story_type");
    }
    if (!Array.isArray(input?.message_ids)) {
      throw new Error("message_ids must be an array of 3 to 8 message IDs");
    }
    const seenIds = new Set<string>();
    const cleanMessageIds: string[] = [];
    for (const rawId of input.message_ids) {
      const id = typeof rawId === "string" ? rawId.trim() : "";
      if (
        !id ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) ||
        id.includes("..") ||
        /^mr_[0-9a-f]{16,}$/i.test(id) ||
        PROTOTYPE_POISON_KEYS.has(id.toLowerCase()) ||
        CREDENTIAL_PREFIX_RE.test(id) ||
        this.containsMemorySecretShape(id)
      ) {
        throw new Error("Invalid message ID in message_ids");
      }
      if (!seenIds.has(id)) {
        seenIds.add(id);
        cleanMessageIds.push(id);
      }
    }
    if (cleanMessageIds.length < 3 || cleanMessageIds.length > 8) {
      throw new Error("message_ids must contain between 3 and 8 unique message IDs");
    }
    const body: Record<string, unknown> = {
      channel_id: safeChannel,
      message_ids: cleanMessageIds,
      story_type: input.story_type,
    };
    const fieldCaps = { title: 96, summary: 200, outcome: 160 } as const;
    for (const field of ["title", "summary", "outcome"] as const) {
      const val = input[field];
      if (val !== undefined) {
        if (typeof val !== "string" || val.length > fieldCaps[field] || /[\x00-\x1f\x7f]/.test(val)) {
          throw new Error(`Invalid story ${field}`);
        }
        if (CREDENTIAL_PREFIX_RE.test(val.trim()) || this.containsMemorySecretShape(val)) {
          throw new Error(`Story ${field} must not contain secrets`);
        }
        const trimmed = val.trim();
        if (trimmed) body[field] = trimmed;
      }
    }
    if (input.qr_target !== undefined) {
      const qr = typeof input.qr_target === "string" ? input.qr_target.trim() : "";
      if (!qr || qr.length > 500 || /[\u0000-\u001F\u007F\s]/.test(qr)) {
        throw new Error("Invalid story qr_target");
      }
      if (CREDENTIAL_PREFIX_RE.test(qr) || this.containsMemorySecretShape(qr)) {
        throw new Error("Story qr_target must not contain secrets");
      }
      let parsedQr: URL;
      try {
        parsedQr = new URL(qr);
      } catch {
        throw new Error("Invalid story qr_target");
      }
      if (parsedQr.protocol !== "https:") {
        throw new Error("Story qr_target must use https://");
      }
      if (parsedQr.username || parsedQr.password || isPrivateOrLoopbackHostname(parsedQr.hostname)) {
        throw new Error("Invalid story qr_target");
      }
      body.qr_target = qr;
    }
    return this.post<import("./types").CreateStoryArtifactResponse>(
      "/api/stories/artifact",
      body,
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(opts?.bearerToken) ?? {}),
      },
    );
  }

  async joinChannel(
    channelId: string,
    opts?: { sender_id?: string; bearerToken?: string },
  ): Promise<import("./types").ChannelJoinResponse> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const body: Record<string, unknown> = {};
    if (opts?.sender_id !== undefined) {
      const persona = opts.sender_id.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(persona) || /^(?:ac_|sk[-_])/i.test(persona)) {
        throw new Error("Invalid sender_id");
      }
      body.sender_id = persona;
    }
    return this.post<import("./types").ChannelJoinResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/join`,
      body,
      { "Cache-Control": "no-store", ...this.authHeaders(opts?.bearerToken) },
    );
  }

  async leaveChannel(
    channelId: string,
    opts?: { sender_id?: string; bearerToken?: string },
  ): Promise<import("./types").ChannelLeaveResponse> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const body: Record<string, unknown> = {};
    if (opts?.sender_id !== undefined) {
      const persona = opts.sender_id.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(persona) || /^(?:ac_|sk[-_])/i.test(persona)) {
        throw new Error("Invalid sender_id");
      }
      body.sender_id = persona;
    }
    return this.post<import("./types").ChannelLeaveResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/leave`,
      body,
      { "Cache-Control": "no-store", ...this.authHeaders(opts?.bearerToken) },
    );
  }

  async getChannelDetail(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelDetailResponse> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    return this.get<import("./types").ChannelDetailResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/detail`,
      { "Cache-Control": "no-store", ...this.authHeaders(opts?.bearerToken) },
    );
  }

  // MARK: - Room Invites & Private Join-Request Governance

  private assertSafePrincipalTarget(raw: string, label: string): string {
    const trimmed = raw?.trim() ?? "";
    if (
      !trimmed ||
      trimmed.length > 254 ||
      /[\x00-\x1f\x7f/\\]/.test(trimmed) ||
      trimmed === "." ||
      trimmed === ".." ||
      /^(?:ac_|agent_key_|sk[-_]|ghp_|eyJ[A-Za-z0-9_-]+\.)/i.test(trimmed)
    ) {
      throw new Error(`Invalid ${label}`);
    }
    return trimmed;
  }

  async inviteToChannel(
    channelId: string,
    agentId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelInviteMutationResponse> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const safeTarget = this.assertSafePrincipalTarget(agentId, "target ID");
    return this.post<import("./types").ChannelInviteMutationResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/invite`,
      { agent_id: safeTarget },
      { "Cache-Control": "no-store", ...this.authHeaders(opts?.bearerToken) },
    );
  }

  async listChannelInvites(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelOutgoingInvitesResponse> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    return this.get<import("./types").ChannelOutgoingInvitesResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/invites`,
      { "Cache-Control": "no-store", ...this.authHeaders(opts?.bearerToken) },
    );
  }

  async listMyInvites(
    opts?: { bearerToken?: string },
  ): Promise<import("./types").AccountIncomingInvitesResponse> {
    return this.get<import("./types").AccountIncomingInvitesResponse>(
      "/api/account/me/invites",
      { "Cache-Control": "no-store", ...this.authHeaders(opts?.bearerToken) },
    );
  }

  async respondToChannelInvite(
    channelId: string,
    targetId: string,
    action: import("./types").ChannelInviteAction,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean }> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const safeTarget = this.assertSafePrincipalTarget(targetId, "target ID");
    if (action !== "accept" && action !== "reject" && action !== "cancel") {
      throw new Error("Invalid invite action");
    }
    return this.post<{ ok: boolean }>(
      `/api/channels/${encodeURIComponent(safeChannel)}/invites/${encodeURIComponent(safeTarget)}/${action}`,
      {},
      { "Cache-Control": "no-store", ...this.authHeaders(opts?.bearerToken) },
    );
  }

  async requestChannelJoin(
    channelId: string,
    opts?: import("./types").RequestChannelJoinInput,
  ): Promise<import("./types").RequestChannelJoinResponse> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const body: Record<string, unknown> = {};
    if (opts?.message !== undefined) {
      const cleaned = opts.message.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
      if (cleaned.length > 500) {
        throw new Error("Join request message exceeds 500 chars");
      }
      if (
        this.containsMemorySecretShape(cleaned) ||
        /(?:ac_[A-Za-z0-9_-]{12,}|agent_key_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)/.test(cleaned)
      ) {
        throw new Error("Join request message must not contain credentials");
      }
      if (cleaned) body.message = cleaned;
    }
    if (opts?.proxy_agent_id !== undefined) {
      const proxy = opts.proxy_agent_id.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(proxy) || /^(?:ac_|sk[-_])/i.test(proxy)) {
        throw new Error("Invalid proxy_agent_id");
      }
      body.proxy_agent_id = proxy;
    }
    return this.post<import("./types").RequestChannelJoinResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/join-request`,
      body,
      { "Cache-Control": "no-store", ...this.authHeaders(opts?.bearerToken) },
    );
  }

  async cancelChannelJoinRequest(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean }> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    return this.del<{ ok: boolean }>(
      `/api/channels/${encodeURIComponent(safeChannel)}/join-request`,
      {},
      { "Cache-Control": "no-store", ...this.authHeaders(opts?.bearerToken) },
    );
  }

  async listChannelJoinRequests(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelJoinRequestsResponse> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    return this.get<import("./types").ChannelJoinRequestsResponse>(
      `/api/channels/${encodeURIComponent(safeChannel)}/join-requests`,
      { "Cache-Control": "no-store", ...this.authHeaders(opts?.bearerToken) },
    );
  }

  async listMyManagedJoinRequests(
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ManagedChannelJoinRequestsResponse> {
    return this.get<import("./types").ManagedChannelJoinRequestsResponse>(
      "/api/join-requests/mine",
      { "Cache-Control": "no-store", ...this.authHeaders(opts?.bearerToken) },
    );
  }

  async respondToChannelJoinRequest(
    channelId: string,
    accountId: string,
    action: import("./types").ChannelJoinRequestAction,
    opts?: { bearerToken?: string },
  ): Promise<{ ok: boolean }> {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const safeAccount = this.assertSafePrincipalTarget(accountId, "account ID");
    if (action !== "approve" && action !== "reject") {
      throw new Error("Invalid join request action");
    }
    return this.post<{ ok: boolean }>(
      `/api/channels/${encodeURIComponent(safeChannel)}/join-requests/${encodeURIComponent(safeAccount)}/${action}`,
      {},
      { "Cache-Control": "no-store", ...this.authHeaders(opts?.bearerToken) },
    );
  }

  // MARK: - Persistent Agent Working Memory (/api/memory) & Cloud Room Lifecycle

  private assertMemorySlug(rawName: string): string {
    const safe = rawName?.trim() ?? "";
    if (!isValidPersonalSkillSlug(safe)) {
      throw new Error("Invalid memory name");
    }
    return safe;
  }

  private containsMemorySecretShape(text: string): boolean {
    if (!text) return false;
    return EMBEDDED_SECRET_TOKEN_RE.test(text) || JOINED_GRAPH_AWS_KEY_ID_RE.test(text);
  }

  async listMemories(opts?: { bearerToken?: string }): Promise<import("./types").AgentMemoryListResponse> {
    return this.get<import("./types").AgentMemoryListResponse>("/api/memory", this.authHeaders(opts?.bearerToken));
  }

  async getMemory(
    name: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").AgentMemoryDetailItem> {
    const safeName = this.assertMemorySlug(name);
    return this.get<import("./types").AgentMemoryDetailItem>(
      `/api/memory/${encodeURIComponent(safeName)}`,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async getMemoryRevisions(
    name: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").AgentMemoryRevisionsResponse> {
    const safeName = this.assertMemorySlug(name);
    return this.get<import("./types").AgentMemoryRevisionsResponse>(
      `/api/memory/${encodeURIComponent(safeName)}/revisions`,
      this.authHeaders(opts?.bearerToken),
    );
  }

  async saveMemory(
    name: string,
    input: import("./types").SaveAgentMemoryInput,
  ): Promise<import("./types").SaveAgentMemoryResponse> {
    const safeName = this.assertMemorySlug(name);
    if (typeof input?.body_markdown !== "string" || !input.body_markdown.trim()) {
      throw new Error("Memory body_markdown is required");
    }
    const byteLen = new TextEncoder().encode(input.body_markdown).byteLength;
    if (byteLen > 256_000) {
      throw new Error("Memory body_markdown exceeds 256000 UTF-8 bytes");
    }
    if (
      this.containsMemorySecretShape(input.body_markdown) ||
      (typeof input.description === "string" && this.containsMemorySecretShape(input.description))
    ) {
      throw new Error("Memory must not contain API keys, tokens, or private keys");
    }
    if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 280)) {
      throw new Error("Memory description must be a string up to 280 characters");
    }
    if (
      input.if_match_version !== undefined &&
      (!Number.isInteger(input.if_match_version) || input.if_match_version < 0 || input.if_match_version > 1_000_000)
    ) {
      throw new Error("Invalid memory if_match_version");
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
      ...(this.authHeaders(input.bearerToken) ?? {}),
      ...(input.if_match_version !== undefined ? { "If-Match": `"${input.if_match_version}"` } : {}),
    };
    const body: Record<string, unknown> = {
      body_markdown: input.body_markdown,
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      ...(input.if_match_version !== undefined ? { if_match_version: input.if_match_version } : {}),
    };
    const res = await fetch(`${this.baseUrl}/api/memory/${encodeURIComponent(safeName)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  async deleteMemory(
    name: string,
    opts?: { if_match_version?: number; bearerToken?: string },
  ): Promise<import("./types").DeleteAgentMemoryResponse> {
    const safeName = this.assertMemorySlug(name);
    if (
      opts?.if_match_version !== undefined &&
      (!Number.isInteger(opts.if_match_version) || opts.if_match_version < 1 || opts.if_match_version > 1_000_000)
    ) {
      throw new Error("Memory delete if_match_version must be an integer >= 1");
    }
    const qs = opts?.if_match_version !== undefined ? `?if_match_version=${opts.if_match_version}` : "";
    const headers: Record<string, string> = {
      ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
      ...(this.authHeaders(opts?.bearerToken) ?? {}),
      ...(opts?.if_match_version !== undefined ? { "If-Match": `"${opts.if_match_version}"` } : {}),
    };
    const res = await fetch(`${this.baseUrl}/api/memory/${encodeURIComponent(safeName)}${qs}`, {
      method: "DELETE",
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  async cloudAgentJoinChannel(
    agentId: string,
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").CloudAgentChannelMutationResponse> {
    const safeAgent = agentId?.trim() ?? "";
    if (!isSafeCloudRoomAgentId(safeAgent)) {
      throw new Error("Invalid cloud agent ID");
    }
    const safeChannel = channelId?.trim() ?? "";
    if (!isSafeCloudGroupChannelId(safeChannel)) {
      throw new Error("Invalid group channel ID");
    }
    return this.post<import("./types").CloudAgentChannelMutationResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/join-channel`,
      { channel_id: safeChannel },
      this.authHeaders(opts?.bearerToken),
    );
  }

  async cloudAgentLeaveChannel(
    agentId: string,
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").CloudAgentChannelMutationResponse> {
    const safeAgent = agentId?.trim() ?? "";
    if (!isSafeCloudRoomAgentId(safeAgent)) {
      throw new Error("Invalid cloud agent ID");
    }
    const safeChannel = channelId?.trim() ?? "";
    if (!isSafeCloudGroupChannelId(safeChannel)) {
      throw new Error("Invalid group channel ID");
    }
    if (safeChannel === "welcome") {
      throw new Error("Default channel welcome cannot be removed");
    }
    return this.post<import("./types").CloudAgentChannelMutationResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/leave-channel`,
      { channel_id: safeChannel },
      this.authHeaders(opts?.bearerToken),
    );
  }

  async wakeCloudAgent(
    agentId: string,
    input?: import("./types").WakeCloudAgentInput,
  ): Promise<import("./types").WakeCloudAgentResponse> {
    const safeAgent = agentId?.trim() ?? "";
    if (!isSafeCloudRoomAgentId(safeAgent)) {
      throw new Error("Invalid cloud agent ID");
    }
    const body: Record<string, unknown> = {};
    if (input?.channel_id !== undefined) {
      const safeChannel = input.channel_id.trim();
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) ||
        safeChannel.includes("..") ||
        PROTOTYPE_POISON_KEYS.has(safeChannel) ||
        CREDENTIAL_PREFIX_RE.test(safeChannel) ||
        EMBEDDED_SECRET_TOKEN_RE.test(safeChannel)
      ) {
        throw new Error("Invalid channel ID");
      }
      body.channel_id = safeChannel;
    }
    if (input?.prompt !== undefined) {
      if (typeof input.prompt !== "string" || input.prompt.length > 4000) {
        throw new Error("Wake prompt must be a string up to 4000 characters");
      }
      if (this.containsMemorySecretShape(input.prompt)) {
        throw new Error("Wake prompt must not contain credentials");
      }
      body.prompt = input.prompt;
    }
    return this.post<import("./types").WakeCloudAgentResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/wake`,
      body,
      this.authHeaders(input?.bearerToken),
    );
  }

  private assertCloudAgentId(rawId: string): string {
    const safe = rawId?.trim() ?? "";
    if (!isValidMemoryAgentId(safe)) {
      throw new Error("Invalid cloud agent ID");
    }
    return safe;
  }

  async listCloudAgents(
    query?: import("./types").CloudAgentsListQuery,
  ): Promise<import("./types").CloudAgentsListResponse> {
    const params = new URLSearchParams();
    if (query?.host_environment_id !== undefined) {
      const envId = typeof query.host_environment_id === "string" ? query.host_environment_id.trim() : "";
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(envId) ||
        envId.includes("..") ||
        PROTOTYPE_POISON_KEYS.has(envId.toLowerCase()) ||
        /^mr_[0-9a-f]{16,}$/i.test(envId) ||
        CREDENTIAL_PREFIX_RE.test(envId) ||
        JOINED_GRAPH_CREDENTIAL_ID_RE.test(envId) ||
        JOINED_GRAPH_AWS_KEY_ID_RE.test(envId) ||
        this.containsMemorySecretShape(envId)
      ) {
        throw new Error("Invalid host_environment_id");
      }
      params.set("host_environment_id", envId);
    }
    if (query?.parent_agent_id !== undefined) {
      params.set("parent_agent_id", this.assertCloudAgentId(query.parent_agent_id));
    }
    const qs = params.toString();
    const raw = await this.get<import("./types").CloudAgentsListResponse>(
      `/api/cloud-agents${qs ? `?${qs}` : ""}`,
      {
        Accept: "application/json",
        "Cache-Control": "no-store",
        ...(this.authHeaders(query?.bearerToken) ?? {}),
      },
    );
    if (!raw || !Array.isArray(raw.agents)) return raw;
    const sanitizedAgents = raw.agents.map((agent) => {
      if (!agent || typeof agent !== "object" || Array.isArray(agent)) return agent;
      if (!("okr_summary" in agent) && agent.is_host === undefined) return agent;
      if (agent.is_host !== false) {
        return "okr_summary" in agent ? { ...agent, okr_summary: null } : agent;
      }
      if (agent.okr_summary === undefined) return agent;
      const cleanOkr = summarizeCloudAgentOkr({ is_host: false, okr_summary: agent.okr_summary });
      return {
        ...agent,
        okr_summary: cleanOkr
          ? {
              doing_count: cleanOkr.doing_count,
              ready_count: cleanOkr.ready_count,
              waiting_count: cleanOkr.waiting_count,
              blocked_count: cleanOkr.blocked_count,
              done_count: cleanOkr.done_count,
              owned_active_objectives: cleanOkr.owned_active_objectives,
              active_channel_ids: cleanOkr.active_channel_ids,
            }
          : null,
      };
    });
    return { ...raw, agents: sanitizedAgents };
  }

  async tuneCloudAgent(
    agentId: string,
    input: import("./types").TuneCloudAgentInput,
  ): Promise<import("./types").TuneCloudAgentResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    if (!input || typeof input !== "object") {
      throw new Error("Cloud agent tuning input object is required");
    }
    const body: Record<string, unknown> = {};
    if (input.display_name !== undefined) {
      if (typeof input.display_name !== "string" || !input.display_name.trim() || input.display_name.length > 80) {
        throw new Error("display_name must be a non-empty string up to 80 characters");
      }
      if (this.containsMemorySecretShape(input.display_name)) {
        throw new Error("display_name must not contain credentials");
      }
      body.display_name = input.display_name.trim();
    }
    if (input.system_prompt !== undefined) {
      if (input.system_prompt !== null) {
        if (typeof input.system_prompt !== "string" || input.system_prompt.length > 16_000) {
          throw new Error("system_prompt must be null or a string up to 16000 characters");
        }
        if (this.containsMemorySecretShape(input.system_prompt)) {
          throw new Error("system_prompt must not contain credentials");
        }
      }
      body.system_prompt = input.system_prompt;
    }
    if (input.model !== undefined) {
      if (input.model !== null && (typeof input.model !== "string" || input.model.length > 120)) {
        throw new Error("model must be null or a string up to 120 characters");
      }
      body.model = input.model;
    }
    if (input.effort !== undefined) {
      if (input.effort !== null && (typeof input.effort !== "string" || input.effort.length > 32)) {
        throw new Error("effort must be null or a string up to 32 characters");
      }
      body.effort = input.effort;
    }
    if (input.capabilities !== undefined) {
      if (!Array.isArray(input.capabilities) || input.capabilities.length > 24) {
        throw new Error("capabilities must be an array of up to 24 tags");
      }
      body.capabilities = input.capabilities.map((raw) => {
        if (typeof raw !== "string") throw new Error("Capability tag must be a string");
        const tag = raw.trim();
        if (!tag || tag.length > 48 || /[\x00-\x1f\x7f]/.test(tag) || PROTOTYPE_POISON_KEYS.has(tag.toLowerCase())) {
          throw new Error("Invalid capability tag");
        }
        if (
          this.containsMemorySecretShape(tag) ||
          CREDENTIAL_PREFIX_RE.test(tag) ||
          CUSTOM_SPECIALTY_SECRET_IN_ID_RE.test(tag)
        ) {
          throw new Error("Capability tag must not contain credentials");
        }
        return tag;
      });
    }
    let ifMatchHeader: string | undefined;
    if (input.if_match_updated_at !== undefined) {
      const ver = input.if_match_updated_at.trim();
      if (!ver || ver.length > 64 || /[\x00-\x1f\x7f"]/.test(ver)) {
        throw new Error("Invalid if_match_updated_at version");
      }
      body.if_match_updated_at = ver;
      ifMatchHeader = ver;
    }
    if (Object.keys(body).length === 0) {
      throw new Error("At least one tuning field is required");
    }
    return this.patch<import("./types").TuneCloudAgentResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}`,
      body,
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(input.bearerToken) ?? {}),
        ...(ifMatchHeader ? { "If-Match": ifMatchHeader } : {}),
      },
    );
  }

  async listCloudAgentMemories(
    agentId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").CloudAgentMemoryListResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    return this.get<import("./types").CloudAgentMemoryListResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/memory`,
      {
        Accept: "application/json",
        "Cache-Control": "no-store",
        ...(this.authHeaders(opts?.bearerToken) ?? {}),
      },
    );
  }

  async getCloudAgentMemory(
    agentId: string,
    name: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").CloudAgentMemoryDetailResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    const safeName = this.assertMemorySlug(name);
    return this.get<import("./types").CloudAgentMemoryDetailResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/memory/${encodeURIComponent(safeName)}`,
      {
        Accept: "application/json",
        "Cache-Control": "no-store",
        ...(this.authHeaders(opts?.bearerToken) ?? {}),
      },
    );
  }

  async getCloudAgentMemoryRevisions(
    agentId: string,
    name: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").AgentMemoryRevisionsResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    const safeName = this.assertMemorySlug(name);
    return this.get<import("./types").AgentMemoryRevisionsResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/memory/${encodeURIComponent(safeName)}/revisions`,
      {
        Accept: "application/json",
        "Cache-Control": "no-store",
        ...(this.authHeaders(opts?.bearerToken) ?? {}),
      },
    );
  }

  async saveCloudAgentMemory(
    agentId: string,
    name: string,
    input: import("./types").SaveAgentMemoryInput,
  ): Promise<import("./types").SaveCloudAgentMemoryResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    const safeName = this.assertMemorySlug(name);
    if (typeof input?.body_markdown !== "string" || !input.body_markdown.trim()) {
      throw new Error("Memory body_markdown is required");
    }
    const byteLen = new TextEncoder().encode(input.body_markdown).byteLength;
    if (byteLen > 256_000) {
      throw new Error("Memory body_markdown exceeds 256000 UTF-8 bytes");
    }
    if (
      this.containsMemorySecretShape(input.body_markdown) ||
      (typeof input.description === "string" && this.containsMemorySecretShape(input.description))
    ) {
      throw new Error("Memory must not contain API keys, tokens, or private keys");
    }
    if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 280)) {
      throw new Error("Memory description must be a string up to 280 characters");
    }
    if (
      input.if_match_version !== undefined &&
      (!Number.isInteger(input.if_match_version) || input.if_match_version < 0 || input.if_match_version > 1_000_000)
    ) {
      throw new Error("Invalid memory if_match_version");
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
      ...(this.authHeaders(input.bearerToken) ?? {}),
      ...(input.if_match_version !== undefined ? { "If-Match": `"${input.if_match_version}"` } : {}),
    };
    const body: Record<string, unknown> = {
      body_markdown: input.body_markdown,
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      ...(input.if_match_version !== undefined ? { if_match_version: input.if_match_version } : {}),
    };
    const res = await fetch(
      `${this.baseUrl}/api/cloud-agents/${encodeURIComponent(safeAgent)}/memory/${encodeURIComponent(safeName)}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  async deleteCloudAgentMemory(
    agentId: string,
    name: string,
    opts?: { if_match_version?: number; bearerToken?: string },
  ): Promise<import("./types").DeleteAgentMemoryResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    const safeName = this.assertMemorySlug(name);
    if (
      opts?.if_match_version !== undefined &&
      (!Number.isInteger(opts.if_match_version) || opts.if_match_version < 1 || opts.if_match_version > 1_000_000)
    ) {
      throw new Error("Memory delete if_match_version must be an integer >= 1");
    }
    const qs = opts?.if_match_version !== undefined ? `?if_match_version=${opts.if_match_version}` : "";
    const headers: Record<string, string> = {
      "Cache-Control": "no-store",
      ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
      ...(this.authHeaders(opts?.bearerToken) ?? {}),
      ...(opts?.if_match_version !== undefined ? { "If-Match": `"${opts.if_match_version}"` } : {}),
    };
    const res = await fetch(
      `${this.baseUrl}/api/cloud-agents/${encodeURIComponent(safeAgent)}/memory/${encodeURIComponent(safeName)}${qs}`,
      {
        method: "DELETE",
        headers,
      },
    );
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  async recoverCloudAgent(
    agentId: string,
    input?: import("./types").RecoverCloudAgentInput,
  ): Promise<import("./types").RecoverCloudAgentResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    const body: Record<string, unknown> = {};
    if (input?.gemini_api_key !== undefined) {
      if (typeof input.gemini_api_key !== "string" || !input.gemini_api_key.trim() || input.gemini_api_key.length > 512) {
        throw new Error("gemini_api_key must be a non-empty string up to 512 characters when provided");
      }
      body.gemini_api_key = input.gemini_api_key.trim();
    }
    return this.post<import("./types").RecoverCloudAgentResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/recover`,
      body,
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(input?.bearerToken) ?? {}),
      },
    );
  }

  private assertCloudLoopId(loopId: string): string {
    const trimmed = typeof loopId === "string" ? loopId.trim() : "";
    if (!/^loop_[A-Za-z0-9_-]{6,64}$/.test(trimmed)) {
      throw new Error("Invalid cloud loop ID");
    }
    return trimmed;
  }

  async listCloudAgentLoops(
    agentId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").CloudAgentLoopsListResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    return this.get<import("./types").CloudAgentLoopsListResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/loops`,
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(opts?.bearerToken) ?? {}),
      },
    );
  }

  async listCloudAgentLoopObjectives(
    agentId: string,
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").CloudAgentLoopObjectivesResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    const trimmedChannel = typeof channelId === "string" ? channelId.trim() : "";
    if (
      !trimmedChannel ||
      trimmedChannel.includes("..") ||
      !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(trimmedChannel) ||
      trimmedChannel.startsWith("arena-") ||
      DM_OR_DIRECT_CHANNEL_RE.test(trimmedChannel) ||
      CREDENTIAL_PREFIX_RE.test(trimmedChannel) ||
      EMAIL_ID_RE.test(trimmedChannel) ||
      PHONE_ID_RE.test(trimmedChannel)
    ) {
      throw new Error("Invalid channel ID");
    }
    return this.get<import("./types").CloudAgentLoopObjectivesResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/loops/objectives?channel_id=${encodeURIComponent(trimmedChannel)}`,
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(opts?.bearerToken) ?? {}),
      },
    );
  }

  async createCloudAgentLoop(
    agentId: string,
    input: import("./types").CreateCloudAgentLoopInput,
  ): Promise<import("./types").CreateCloudAgentLoopResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    const channelId = typeof input?.channel_id === "string" ? input.channel_id.trim() : "";
    if (
      !channelId ||
      !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(channelId) ||
      PROTOTYPE_POISON_KEYS.has(channelId) ||
      /^\d{6,}$/.test(channelId) ||
      channelId.startsWith("arena-") ||
      CREDENTIAL_PREFIX_RE.test(channelId) ||
      EMBEDDED_SECRET_TOKEN_RE.test(channelId)
    ) {
      throw new Error("Invalid channel ID");
    }
    const mode = input.mode ?? "prompt";
    if (!["prompt", "okr_wake", "okr_watch"].includes(mode)) {
      throw new Error("Invalid loop mode");
    }
    if (mode !== "prompt" && DM_OR_DIRECT_CHANNEL_RE.test(channelId)) {
      throw new Error("OKR loops require a group or project channel");
    }
    const body: Record<string, unknown> = { channel_id: channelId, mode };
    if (input.interval !== undefined) {
      const iv = String(input.interval).trim();
      if (!iv) throw new Error("Invalid loop interval");
      body.interval = iv;
    } else if (input.interval_ms !== undefined) {
      if (!Number.isInteger(input.interval_ms) || input.interval_ms < 60_000 || input.interval_ms > 86_400_000) {
        throw new Error("interval_ms must be an integer between 60000 and 86400000");
      }
      body.interval_ms = input.interval_ms;
    } else {
      throw new Error("Provide interval or interval_ms");
    }

    if (input.prompt !== undefined) {
      const prompt = String(input.prompt).trim();
      if (this.containsMemorySecretShape(prompt)) {
        throw new Error("Loop prompt must not contain API keys, tokens, or private keys");
      }
      body.prompt = prompt;
    } else if (mode === "prompt") {
      throw new Error("Non-empty prompt required for prompt mode");
    }

    if (mode !== "prompt") {
      const oid = typeof input.objective_id === "string" ? input.objective_id.trim() : "";
      if (
        !/^[A-Za-z0-9_-]{6,80}$/.test(oid) ||
        PROTOTYPE_POISON_KEYS.has(oid) ||
        /^\d{6,}$/.test(oid) ||
        CREDENTIAL_PREFIX_RE.test(oid) ||
        EMBEDDED_SECRET_TOKEN_RE.test(oid)
      ) {
        throw new Error("Invalid objective ID");
      }
      body.objective_id = oid;
      if (input.target_agents !== undefined) {
        if (!Array.isArray(input.target_agents) || input.target_agents.length > 10) {
          throw new Error("Invalid target_agents");
        }
        const normalizedTargets: string[] = [];
        const seenTargets = new Set<string>();
        for (const rawTarget of input.target_agents) {
          if (typeof rawTarget !== "string") throw new Error("Invalid target_agents");
          const clean = rawTarget.trim().replace(/^@/, "");
          if (
            !/^[A-Za-z0-9._-]{1,128}$/.test(clean) ||
            clean.includes("..") ||
            PROTOTYPE_POISON_KEYS.has(clean) ||
            /^\d{6,}$/.test(clean) ||
            CREDENTIAL_PREFIX_RE.test(clean) ||
            EMBEDDED_SECRET_TOKEN_RE.test(clean) ||
            EMAIL_ID_RE.test(clean) ||
            PHONE_ID_RE.test(clean)
          ) {
            throw new Error("Invalid target_agents");
          }
          if (!seenTargets.has(clean)) {
            seenTargets.add(clean);
            normalizedTargets.push(clean);
          }
        }
        body.target_agents = normalizedTargets;
      }
      if (mode === "okr_watch") {
        if (input.watch_idle !== undefined) body.watch_idle = Boolean(input.watch_idle);
        if (input.watch_supply !== undefined) body.watch_supply = Boolean(input.watch_supply);
        if (input.stall_minutes !== undefined) {
          if (!Number.isInteger(input.stall_minutes) || input.stall_minutes < 5 || input.stall_minutes > 1440) {
            throw new Error("stall_minutes must be an integer between 5 and 1440");
          }
          body.stall_minutes = input.stall_minutes;
        }
      }
    }

    return this.post<import("./types").CreateCloudAgentLoopResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/loops`,
      body,
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(input.bearerToken) ?? {}),
      },
    );
  }

  async pauseCloudAgentLoop(
    agentId: string,
    loopId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").MutateCloudAgentLoopResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    const safeLoop = this.assertCloudLoopId(loopId);
    return this.post<import("./types").MutateCloudAgentLoopResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/loops/${encodeURIComponent(safeLoop)}/pause`,
      {},
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(opts?.bearerToken) ?? {}),
      },
    );
  }

  async resumeCloudAgentLoop(
    agentId: string,
    loopId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").MutateCloudAgentLoopResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    const safeLoop = this.assertCloudLoopId(loopId);
    return this.post<import("./types").MutateCloudAgentLoopResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/loops/${encodeURIComponent(safeLoop)}/resume`,
      {},
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(opts?.bearerToken) ?? {}),
      },
    );
  }

  async setCloudAgentLoopInterval(
    agentId: string,
    loopId: string,
    intervalInput: { interval?: string; interval_ms?: number; bearerToken?: string },
  ): Promise<import("./types").MutateCloudAgentLoopResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    const safeLoop = this.assertCloudLoopId(loopId);
    const body: Record<string, unknown> = {};
    if (intervalInput?.interval !== undefined) {
      const iv = String(intervalInput.interval).trim();
      if (!iv) throw new Error("Invalid loop interval");
      body.interval = iv;
    } else if (intervalInput?.interval_ms !== undefined) {
      if (
        !Number.isInteger(intervalInput.interval_ms) ||
        intervalInput.interval_ms < 60_000 ||
        intervalInput.interval_ms > 86_400_000
      ) {
        throw new Error("interval_ms must be an integer between 60000 and 86400000");
      }
      body.interval_ms = intervalInput.interval_ms;
    } else {
      throw new Error("Provide interval or interval_ms");
    }
    return this.post<import("./types").MutateCloudAgentLoopResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/loops/${encodeURIComponent(safeLoop)}/interval`,
      body,
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(intervalInput.bearerToken) ?? {}),
      },
    );
  }

  async stopCloudAgentLoop(
    agentId: string,
    loopId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").MutateCloudAgentLoopResponse> {
    const safeAgent = this.assertCloudAgentId(agentId);
    const safeLoop = this.assertCloudLoopId(loopId);
    return this.del<import("./types").MutateCloudAgentLoopResponse>(
      `/api/cloud-agents/${encodeURIComponent(safeAgent)}/loops/${encodeURIComponent(safeLoop)}`,
      {},
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(opts?.bearerToken) ?? {}),
      },
    );
  }

  async getMyEntitlements(opts?: { bearerToken?: string }): Promise<import("./types").CallerEntitlementsResponse> {
    return this.get<import("./types").CallerEntitlementsResponse>("/api/me/entitlements", {
      "Cache-Control": "no-store",
      ...(this.authHeaders(opts?.bearerToken) ?? {}),
    });
  }

  async kickChannelMember(
    channelId: string,
    input: import("./types").KickChannelMemberInput,
  ): Promise<import("./types").KickChannelMemberResponse> {
    const trimmedChannel = typeof channelId === "string" ? channelId.trim() : "";
    if (
      !trimmedChannel ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmedChannel) ||
      trimmedChannel.includes("..") ||
      /^(?:ac_|agent_key_|sk[-_]|gh[pousr]_|github_pat_|AIza|eyJ)/i.test(trimmedChannel)
    ) {
      throw new Error("Invalid channel ID");
    }
    const hasTargetRef = typeof (input as any)?.target_ref === "string" && (input as any).target_ref.trim().length > 0;
    const hasAgentId = typeof (input as any)?.agent_id === "string" && (input as any).agent_id.trim().length > 0;
    if (hasTargetRef === hasAgentId) {
      throw new Error("Provide exactly one of target_ref or agent_id");
    }
    const body: Record<string, unknown> = {};
    if (hasTargetRef) {
      const ref = (input as { target_ref: string }).target_ref.trim();
      if (ref.length > 160 || /[\u0000-\u001F\s]/.test(ref) || this.containsMemorySecretShape(ref)) {
        throw new Error("Invalid target_ref");
      }
      body.target_ref = ref;
    } else {
      const aid = (input as { agent_id: string }).agent_id.trim();
      if (
        aid.length > 128 ||
        /[/\\?#&\s\u0000-\u001F]/.test(aid) ||
        aid.includes("..") ||
        /^(?:ac_|agent_key_|sk[-_]|gh[pousr]_|github_pat_|AIza|eyJ)/i.test(aid)
      ) {
        throw new Error("Invalid agent ID");
      }
      body.agent_id = aid;
    }
    return this.post<import("./types").KickChannelMemberResponse>(
      `/api/channels/${encodeURIComponent(trimmedChannel)}/kick`,
      body,
      {
        "Cache-Control": "no-store",
        ...(this.authHeaders(input.bearerToken) ?? {}),
      },
    );
  }

  // MARK: - Internal

  private async get<T = any>(path: string, headers?: Record<string, string>): Promise<T> {
    const mergedHeaders: Record<string, string> = {
      ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
      ...(headers ?? {}),
    };
    const res = await fetch(
      `${this.baseUrl}${path}`,
      Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : undefined,
    );
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  private async post<T = any>(
    path: string,
    body: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<T> {
    const mergedHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
      ...(headers ?? {}),
    };
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: mergedHeaders,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  private async patch<T = any>(
    path: string,
    body: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<T> {
    const mergedHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
      ...(headers ?? {}),
    };
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PATCH",
      headers: mergedHeaders,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }

  private async del<T = any>(
    path: string,
    body: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<T> {
    const mergedHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
      ...(headers ?? {}),
    };
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: mergedHeaders,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`HTTP ${res.status}: ${error.message ?? error.error ?? res.statusText}`);
    }
    return res.json();
  }
}

const CONTACT_INTERNAL_PRINCIPAL_RE = /^(?:apple_[a-z0-9._-]+|user:)/i;
const CONTACT_EMAIL_ID_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_PHONE_ID_RE = /^\+?\d[\d ()-]{5,}\d$/;
const CONTACT_CREDENTIAL_ID_RE =
  /(?:^|[^A-Za-z0-9])(?:mcp_(?:at|rt|code)_|ac_|agent_key_|sk[-_]|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|(?:hf|npm)_)/i;
const CONTACT_CASE_SENSITIVE_SECRET_RE =
  /(?:^|[^A-Za-z0-9])(?:(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])|(?:AIza|eyJ)[A-Za-z0-9][A-Za-z0-9_.-]{7,})/;

function isPhoneShapedContactHitId(id: string): boolean {
  return CONTACT_PHONE_ID_RE.test(id) && id.replace(/\D/g, "").length >= 7;
}

/**
 * Pure zero-I/O client contact-search privacy filter mirroring `src/contact-search-filter.ts`:
 * - Agent handles remain discoverable by prefix/substring;
 * - Human accounts (`type: "user" | "human"`, email IDs, or phone IDs) surface ONLY on exact match;
 * - Blocks `apple_*`, `user:*`, `mr_*` opaque refs, prototype keys, tombstones, and 14-family credentials;
 * - Deduplicates hits and excludes caller case-insensitively.
 */
export function filterContactSearchHits<T extends import("./types").ContactSearchHit>(
  results: ReadonlyArray<T>,
  caller: string,
  query: string,
): T[] {
  if (!Array.isArray(results)) return [];
  const q = (typeof query === "string" ? query : "").trim().toLowerCase();
  const callerNorm = (typeof caller === "string" ? caller : "").trim().toLowerCase();
  const seen = new Set<string>();
  const out: T[] = [];

  for (const hit of results) {
    if (!hit || typeof hit !== "object" || typeof hit.id !== "string") continue;
    const rawId = hit.id.trim();
    if (
      !rawId ||
      rawId.length > 128 ||
      /[\x00-\x1f\x7f]/.test(rawId) ||
      PROTOTYPE_POISON_KEYS.has(rawId.toLowerCase()) ||
      /^mr_[0-9a-f]{16,}$/i.test(rawId) ||
      CONTACT_INTERNAL_PRINCIPAL_RE.test(rawId) ||
      CONTACT_CREDENTIAL_ID_RE.test(rawId) ||
      CONTACT_CASE_SENSITIVE_SECRET_RE.test(rawId)
    ) {
      continue;
    }
    const status = typeof hit.status === "string" ? hit.status.trim().toLowerCase() : "";
    if (
      status === "deleted" ||
      status === "disabled" ||
      Boolean(hit.deleted_at) ||
      hit.deletion_pending === true
    ) {
      continue;
    }
    const idNorm = rawId.toLowerCase();
    if (callerNorm && idNorm === callerNorm) continue;
    if (seen.has(idNorm)) continue;

    const normType = typeof hit.type === "string" ? hit.type.trim().toLowerCase() : "";
    const isHuman =
      normType === "user" ||
      normType === "human" ||
      CONTACT_EMAIL_ID_RE.test(rawId) ||
      isPhoneShapedContactHitId(rawId);

    if (isHuman && (!q || idNorm !== q)) continue;

    seen.add(idNorm);
    out.push(hit);
  }

  return out;
}
