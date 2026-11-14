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
const CREDENTIAL_PREFIX_RE = /^(?:ac_|agent_key_|sk[-_]|gh[pousr]_|github_pat_|AIza|eyJ)/i;
const EMAIL_ID_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_ID_RE = /^\+?\d[\d ()-]{5,}\d$/;

function isSafeCollaborationAgentId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    SAFE_COLLAB_AGENT_ID_RE.test(id) &&
    !id.includes("..") &&
    !CREDENTIAL_PREFIX_RE.test(id) &&
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

function safeGraphId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 160 &&
    !/[/\\?#&\s\u0000-\u001F\u007F]/.test(value) &&
    !value.includes("..") &&
    !CREDENTIAL_PREFIX_RE.test(value) &&
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
    !safeGraphId(scope.id)
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
    ? g.referenced_unchanged_ids.slice(0, 5000).filter(safeGraphId).length
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
    const title =
      typeof node.title === "string" && node.title.trim()
        ? node.title.trim().slice(0, 200)
        : node.id;
    const status =
      typeof node.status === "string" && node.status.trim()
        ? node.status.trim().slice(0, 32)
        : "active";
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

const DM_OR_DIRECT_CHANNEL_RE = /^(?:dm[-_]|direct(?:$|[-_:]))/i;
const EMBEDDED_SECRET_TOKEN_RE =
  /(?:^|[^A-Za-z0-9])(?:ac_[A-Za-z0-9_-]{8,}|agent_key_[A-Za-z0-9_-]{8,}|sk[-_][A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AIza[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)/i;

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

export function summarizeProposalsFeed(
  raw: unknown,
  nowMs?: number,
): import("./types").ProposalsFeedSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const feed = raw as Record<string, unknown>;
  if (!safeNonDmChannelId(feed.channel_id) || !Array.isArray(feed.proposals) || feed.proposals.length > 500) {
    return null;
  }
  const channelId = feed.channel_id;
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
    if (!safeGraphId(p.id) || EMBEDDED_SECRET_TOKEN_RE.test(p.id) || seenIds.has(p.id)) continue;
    if (p.channel_id !== undefined && p.channel_id !== channelId) continue;
    seenIds.add(p.id);

    let status: import("./types").ChannelProposalStatus =
      p.status === "passed" || p.status === "rejected" || p.status === "expired" ? p.status : "pending";
    if (status === "pending" && typeof p.expires_at === "string" && p.expires_at.trim()) {
      const expMs = Date.parse(p.expires_at);
      if (Number.isFinite(expMs) && expMs <= refNow) {
        status = "expired";
      }
    }

    if (status === "passed") passedCount += 1;
    else if (status === "rejected") rejectedCount += 1;
    else if (status === "expired") expiredCount += 1;
    else {
      pendingCount += 1;
      pendingIds.push(p.id);
    }

    if (Array.isArray(p.votes)) {
      const seenVoters = new Set<string>();
      for (const v of p.votes.slice(0, 200)) {
        if (!v || typeof v !== "object") continue;
        const vote = v as Record<string, unknown>;
        if (vote.decision !== "approve" && vote.decision !== "reject" && vote.decision !== "abstain") continue;
        const voterKey = typeof vote.voter_id === "string" && vote.voter_id.trim() ? vote.voter_id.trim() : "";
        if (!voterKey || seenVoters.has(voterKey)) continue;
        seenVoters.add(voterKey);
        if (
          typeof vote.reason === "string" &&
          vote.reason.trim().length > 0 &&
          !EMBEDDED_SECRET_TOKEN_RE.test(vote.reason)
        ) {
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

  private isPrivateIpv4Host(ipv4: string): boolean {
    return (
      ipv4 === "0.0.0.0" ||
      /^0\./.test(ipv4) ||
      /^127\./.test(ipv4) ||
      /^10\./.test(ipv4) ||
      /^192\.168\./.test(ipv4) ||
      /^169\.254\./.test(ipv4) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(ipv4) ||
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ipv4)
    );
  }

  private assertWebhookTarget(channelId: string, rawUrl: string): { channelId: string; url: string } {
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const trimmedUrl = rawUrl?.trim() ?? "";
    if (!trimmedUrl || trimmedUrl.length > 1024 || /[\u0000-\u001F]/.test(trimmedUrl)) {
      throw new Error("Invalid webhook URL");
    }
    if (this.containsMemorySecretShape(trimmedUrl)) {
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
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    let blockedHost =
      !host ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host === "::1" ||
      host === "::" ||
      this.isPrivateIpv4Host(host) ||
      /^f[cd][0-9a-f]{0,2}:/.test(host) ||
      /^fe[89ab][0-9a-f]:/.test(host);
    if (!blockedHost && host.startsWith("::ffff:")) {
      const rest = host.slice(7);
      if (this.isPrivateIpv4Host(rest)) {
        blockedHost = true;
      } else {
        const hexMatch = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
        if (hexMatch) {
          const hi = parseInt(hexMatch[1]!, 16);
          const lo = parseInt(hexMatch[2]!, 16);
          const mappedIpv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
          if (this.isPrivateIpv4Host(mappedIpv4)) blockedHost = true;
        }
      }
    }
    if (blockedHost) {
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
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      !host ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host === "::1" ||
      host === "::" ||
      /^f[cd][0-9a-f]{0,2}:/i.test(host) ||
      /^fe[89ab][0-9a-f]:/i.test(host) ||
      this.isPrivateIpv4Host(host)
    ) {
      throw new Error("Private or internal network endpoints are not allowed");
    }
    const mappedV4 = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mappedV4 && this.isPrivateIpv4Host(mappedV4[1])) {
      throw new Error("Private or internal network endpoints are not allowed");
    }
    const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      if (this.isPrivateIpv4Host(dotted)) {
        throw new Error("Private or internal network endpoints are not allowed");
      }
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
    return data.channels;
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
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(agentId) || /^ac_/i.test(agentId)) {
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
    return this.get<CloudAgentAuditFeed>(
      `/api/cloud-agents/${encodeURIComponent(agentId)}/audit${qs ? `?${qs}` : ""}`,
      headers,
    );
  }

  // MARK: - Room-Scoped Cloud Agent Wake-Health Diagnostics

  async getChannelWakeHealth(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelWakeHealth> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channelId) || /^ac_/i.test(channelId)) {
      throw new Error("Invalid channel ID");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.get<import("./types").ChannelWakeHealth>(
      `/api/channels/${encodeURIComponent(channelId)}/wake-health`,
      headers,
    );
  }

  // MARK: - Room & Caller Autonomous Loop Schedules (/api/loops)

  async getChannelLoops(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").RoomLoopsFeed> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channelId) || /^ac_/i.test(channelId)) {
      throw new Error("Invalid channel ID");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    return this.get<import("./types").RoomLoopsFeed>(
      `/api/loops?channel_id=${encodeURIComponent(channelId)}`,
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
      !safeChannel ||
      !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(safeChannel) ||
      safeChannel.includes("..") ||
      CREDENTIAL_PREFIX_RE.test(safeChannel) ||
      EMAIL_ID_RE.test(safeChannel) ||
      PHONE_ID_RE.test(safeChannel)
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
      !trimmedId ||
      trimmedId.length > 160 ||
      /[/\\?#&\s\u0000-\u001F\u007F]/.test(trimmedId) ||
      trimmedId.includes("..") ||
      CREDENTIAL_PREFIX_RE.test(trimmedId) ||
      EMAIL_ID_RE.test(trimmedId) ||
      PHONE_ID_RE.test(trimmedId) ||
      (scope === "channel" && DM_OR_DIRECT_CHANNEL_RE.test(trimmedId)) ||
      /(?:^|[^A-Za-z0-9])(?:sk[-_][A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AIza[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,})/i.test(
        trimmedId,
      ) ||
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
    if (!safeNonDmChannelId(channelId) || this.containsMemorySecretShape(channelId)) {
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
    return this.get<import("./types").ChannelProposalsFeed>(
      `/api/channels/${encodeURIComponent(channelId)}/proposals${qs ? `?${qs}` : ""}`,
      headers,
    );
  }

  async createChannelProposal(
    channelId: string,
    input: import("./types").CreateChannelProposalInput,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").CreateChannelProposalResponse> {
    if (!safeNonDmChannelId(channelId) || this.containsMemorySecretShape(channelId)) {
      throw new Error("Invalid channel ID");
    }
    if (
      input?.id !== undefined &&
      (!safeGraphId(input.id) || EMBEDDED_SECRET_TOKEN_RE.test(input.id) || this.containsMemorySecretShape(input.id))
    ) {
      throw new Error("Invalid proposal ID");
    }
    const title = input?.title?.trim() ?? "";
    if (!title || title.length > 500) {
      throw new Error("Invalid proposal title");
    }
    for (const textField of [title, input?.content, input?.code_diff]) {
      if (
        typeof textField === "string" &&
        textField.length > 0 &&
        (EMBEDDED_SECRET_TOKEN_RE.test(textField) || this.containsMemorySecretShape(textField))
      ) {
        throw new Error("Secret or credential detected in proposal payload");
      }
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
      ...(input.id !== undefined ? { id: input.id } : {}),
      ...(input.sender_id !== undefined ? { sender_id: input.sender_id } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.code_diff !== undefined ? { code_diff: input.code_diff } : {}),
      ...(input.consensus_rule !== undefined ? { consensus_rule: input.consensus_rule } : {}),
      ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
    };
    return this.post<import("./types").CreateChannelProposalResponse>(
      `/api/channels/${encodeURIComponent(channelId)}/proposals`,
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
    if (!safeNonDmChannelId(channelId) || this.containsMemorySecretShape(channelId)) {
      throw new Error("Invalid channel ID");
    }
    if (
      !safeGraphId(proposalId) ||
      EMBEDDED_SECRET_TOKEN_RE.test(proposalId) ||
      this.containsMemorySecretShape(proposalId)
    ) {
      throw new Error("Invalid proposal ID");
    }
    if (!input || !["approve", "reject", "abstain"].includes(input.decision)) {
      throw new Error("Invalid vote decision");
    }
    if (
      typeof input.reason === "string" &&
      input.reason.length > 0 &&
      (EMBEDDED_SECRET_TOKEN_RE.test(input.reason) || this.containsMemorySecretShape(input.reason))
    ) {
      throw new Error("Secret or credential detected in vote reason");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const body: Record<string, unknown> = {
      decision: input.decision,
      ...(input.voter_id !== undefined ? { voter_id: input.voter_id } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    };
    return this.post<import("./types").VoteChannelProposalResponse>(
      `/api/channels/${encodeURIComponent(channelId)}/proposals/${encodeURIComponent(proposalId)}/votes`,
      body,
      headers,
    );
  }

  async getChannelPins(
    channelId: string,
    opts?: { bearerToken?: string },
  ): Promise<import("./types").ChannelPinsResponse> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channelId) || /^(?:ac_|sk-)/i.test(channelId)) {
      throw new Error("Invalid channel ID");
    }
    const token = opts?.bearerToken?.trim() || this.bearerToken;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const raw = await this.get<{ channel_id?: unknown; pinned_messages?: unknown }>(
      `/api/channels/${encodeURIComponent(channelId)}/pins`,
      headers,
    );
    const seen = new Set<string>();
    const pinnedMessages: string[] = [];
    if (Array.isArray(raw?.pinned_messages)) {
      for (const item of raw.pinned_messages) {
        if (typeof item !== "string") continue;
        const trimmed = item.trim();
        if (!trimmed || /[\x00-\x1f\x7f]/.test(trimmed) || seen.has(trimmed)) continue;
        seen.add(trimmed);
        pinnedMessages.push(trimmed);
      }
    }
    return {
      channel_id: typeof raw?.channel_id === "string" && raw.channel_id.trim() ? raw.channel_id.trim() : channelId,
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
    const trimmed = name.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(trimmed) || /^(?:ac_|sk[-_])/i.test(trimmed)) {
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
      /^(?:ac_|agent_key_|sk[-_]|gh[pousr]_|github_pat_|AIza|eyJ)/i.test(channelId)
    ) {
      throw new Error("Invalid channel ID");
    }
    const objectiveId = input?.objective_id?.trim() ?? "";
    if (!/^[A-Za-z0-9_-]{6,80}$/.test(objectiveId) || /^ac_/i.test(objectiveId)) {
      throw new Error("Invalid objective ID");
    }
    let safeAgent: string | undefined;
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
      if (this.containsMemorySecretShape(t)) throw new Error("Task title cannot contain credentials or secrets");
    }
    if (input?.status !== undefined && !["todo", "doing", "done", "blocked"].includes(input.status)) {
      throw new Error("Invalid task status");
    }
    if (input?.due !== undefined && input.due !== null && input.due !== "" && input.due.length > 32) {
      throw new Error("Invalid task due");
    }
    if (typeof input?.blocked_reason === "string" && this.containsMemorySecretShape(input.blocked_reason)) {
      throw new Error("Task blocked_reason cannot contain credentials or secrets");
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
        if (this.containsMemorySecretShape(ref)) {
          throw new Error("Task evidence cannot contain credentials or secrets");
        }
        const note = ev.note?.trim();
        if (note !== undefined && note.length > 500) {
          throw new Error("Invalid task evidence note");
        }
        if (note && this.containsMemorySecretShape(note)) {
          throw new Error("Task evidence cannot contain credentials or secrets");
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
      if (this.containsMemorySecretShape(input.append_evidence)) {
        throw new Error("Task evidence cannot contain credentials or secrets");
      }
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
    if (this.containsMemorySecretShape(trimmed)) throw new Error("Task comment cannot contain credentials or secrets");
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
      if (this.containsMemorySecretShape(input.note)) {
        throw new Error("Task progress note cannot contain credentials or secrets");
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
        if (this.containsMemorySecretShape(input.narrative)) {
          throw new Error("Objective narrative cannot contain credentials or secrets");
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

  private assertChannelDocId(docId: string): string {
    const trimmed = docId?.trim() ?? "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(trimmed) || /^(?:ac_|sk[-_])/i.test(trimmed)) {
      throw new Error("Invalid channel doc ID");
    }
    return trimmed;
  }

  async listChannelDocs(
    channelId: string,
    opts?: { level?: 1 | 2 | 3 | 4; active_only?: boolean; bearerToken?: string },
  ): Promise<import("./types").ChannelDocsListResponse> {
    const safeCh = this.assertOkrEntityId(channelId, "channel ID");
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
    const safeCh = this.assertOkrEntityId(channelId, "channel ID");
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
    const safeCh = this.assertOkrEntityId(channelId, "channel ID");
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
    const safeCh = this.assertOkrEntityId(channelId, "channel ID");
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
    const safeCh = this.assertOkrEntityId(channelId, "channel ID");
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
    const safeChannel = channelId?.trim() ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
      throw new Error("Invalid channel ID");
    }
    const raw = await this.get<{ channel_id?: unknown; threads?: unknown }>(
      `/api/channels/${encodeURIComponent(safeChannel)}/threads`,
      this.authHeaders(opts?.bearerToken),
    );
    const seen = new Set<string>();
    const threads: import("./types").ChannelThreadSummaryItem[] = [];
    if (Array.isArray(raw?.threads)) {
      for (const item of raw.threads) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const parentId = typeof rec.parent_id === "string" ? rec.parent_id.trim() : "";
        if (!parentId || /[\x00-\x1f\x7f]/.test(parentId) || seen.has(parentId)) continue;
        const replyCount =
          typeof rec.reply_count === "number" && Number.isFinite(rec.reply_count) && rec.reply_count >= 0
            ? Math.trunc(rec.reply_count)
            : 0;
        const lastReplyAt = typeof rec.last_reply_at === "string" ? rec.last_reply_at.trim() : "";
        seen.add(parentId);
        threads.push({ parent_id: parentId, reply_count: replyCount, last_reply_at: lastReplyAt });
      }
    }
    return {
      channel_id: typeof raw?.channel_id === "string" && raw.channel_id.trim() ? raw.channel_id.trim() : safeChannel,
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
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(safeAgentId) || /^(?:ac_|sk[-_])/i.test(safeAgentId)) {
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
      if (/^(?:ac_|sk[-_]|ghp_|eyJ[A-Za-z0-9_-]+\.)/i.test(cleaned)) {
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
    if (/^(?:dm-|direct(?:$|[-_:]))/i.test(safeChannel)) {
      throw new Error("Story artifacts cannot be generated from direct message channels");
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
        id.length > 128 ||
        /[\u0000-\u001F\s/\\?#&]/.test(id) ||
        id.includes("..") ||
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
    for (const field of ["title", "summary", "outcome"] as const) {
      const val = input[field];
      if (val !== undefined) {
        if (typeof val !== "string" || val.length > 500) {
          throw new Error(`Invalid story ${field}`);
        }
        if (this.containsMemorySecretShape(val)) {
          throw new Error(`Story ${field} must not contain secrets`);
        }
        const trimmed = val.trim();
        if (trimmed) body[field] = trimmed;
      }
    }
    if (input.qr_target !== undefined) {
      const qr = typeof input.qr_target === "string" ? input.qr_target.trim() : "";
      if (!qr || qr.length > 512 || /[\u0000-\u001F]/.test(qr)) {
        throw new Error("Invalid story qr_target");
      }
      if (this.containsMemorySecretShape(qr)) {
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
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(safe) || safe.includes("..")) {
      throw new Error("Invalid memory name");
    }
    return safe;
  }

  private containsMemorySecretShape(text: string): boolean {
    if (!text) return false;
    return (
      /\bac_[A-Za-z0-9_-]{12,}\b/.test(text) ||
      /\bsk-(?:ant|proj|live|test)-[A-Za-z0-9_-]{10,}\b/.test(text) ||
      /\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(text) ||
      /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(text) ||
      /\bAIza[0-9A-Za-z_-]{30,}\b/.test(text) ||
      /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(text) ||
      /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/.test(text)
    );
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
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(safeAgent) || /^(?:ac_|sk[-_])/i.test(safeAgent)) {
      throw new Error("Invalid cloud agent ID");
    }
    const safeChannel = channelId?.trim() ?? "";
    if (
      !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(safeChannel) ||
      /^dm-/i.test(safeChannel) ||
      /^(?:ac_|sk[-_])/i.test(safeChannel)
    ) {
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
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(safeAgent) || /^(?:ac_|sk[-_])/i.test(safeAgent)) {
      throw new Error("Invalid cloud agent ID");
    }
    const safeChannel = channelId?.trim() ?? "";
    if (
      !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(safeChannel) ||
      /^dm-/i.test(safeChannel) ||
      /^(?:ac_|sk[-_])/i.test(safeChannel)
    ) {
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
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(safeAgent) || /^(?:ac_|sk[-_])/i.test(safeAgent)) {
      throw new Error("Invalid cloud agent ID");
    }
    const body: Record<string, unknown> = {};
    if (input?.channel_id !== undefined) {
      const safeChannel = input.channel_id.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(safeChannel) || /^(?:ac_|sk[-_])/i.test(safeChannel)) {
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
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(safe) ||
      safe.includes("..") ||
      /^(?:ac_|sk[-_])/i.test(safe)
    ) {
      throw new Error("Invalid cloud agent ID");
    }
    return safe;
  }

  async listCloudAgents(
    query?: import("./types").CloudAgentsListQuery,
  ): Promise<import("./types").CloudAgentsListResponse> {
    const params = new URLSearchParams();
    if (query?.host_environment_id !== undefined) {
      const envId = query.host_environment_id.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(envId) || /^(?:ac_|sk[-_])/i.test(envId)) {
        throw new Error("Invalid host_environment_id");
      }
      params.set("host_environment_id", envId);
    }
    if (query?.parent_agent_id !== undefined) {
      params.set("parent_agent_id", this.assertCloudAgentId(query.parent_agent_id));
    }
    const qs = params.toString();
    return this.get<import("./types").CloudAgentsListResponse>(
      `/api/cloud-agents${qs ? `?${qs}` : ""}`,
      {
        Accept: "application/json",
        "Cache-Control": "no-store",
        ...(this.authHeaders(query?.bearerToken) ?? {}),
      },
    );
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
        if (!tag || tag.length > 48 || /[\x00-\x1f\x7f]/.test(tag)) {
          throw new Error("Invalid capability tag");
        }
        if (this.containsMemorySecretShape(tag) || /^(?:ac_|sk[-_])/i.test(tag)) {
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
      channelId.startsWith("arena-") ||
      /^(?:ac_|agent_key_|sk[-_]|gh[pousr]_|github_pat_|AIza|eyJ)/i.test(channelId)
    ) {
      throw new Error("Invalid channel ID");
    }
    const mode = input.mode ?? "prompt";
    if (!["prompt", "okr_wake", "okr_watch"].includes(mode)) {
      throw new Error("Invalid loop mode");
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
      if (!/^[A-Za-z0-9_-]{6,80}$/.test(oid) || /^ac_/i.test(oid)) {
        throw new Error("Invalid objective ID");
      }
      body.objective_id = oid;
      if (input.target_agents !== undefined) {
        body.target_agents = input.target_agents;
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
