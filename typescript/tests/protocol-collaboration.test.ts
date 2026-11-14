import { describe, expect, test } from "bun:test";
import {
  AgentChatClient,
  AgentChatREST,
  computeLocalTaskActionability,
  evaluateConsensusTally,
  isValidCollaborationRoster,
  resolveInheritedObjectiveChannel,
  summarizeChannelBriefReadiness,
  summarizeChannelOkrSnapshot,
  summarizeChannelThreads,
  summarizePersonalSkillsLibrary,
  summarizeProposalsFeed,
  summarizeWorkspaceGraphHierarchy,
  summarizeWorkspaceGraphReadiness,
  type ACMessage,
  type ChannelBrief,
  type ChannelDocUpdatedMessage,
  type ChannelProposalsFeed,
  type ChannelWakeHealth,
  type CloudAgentAuditFeed,
  type OkrUpdatedMessage,
  type PinUpdate,
  type ProposalMessage,
  type ReadReceiptUpdate,
  type RoomLoopsFeed,
  type TaskAssignedMessage,
  type VoteMessage,
  type WorkspaceGraph,
} from "../src/index";

describe("AgentChatClient realtime collaboration WS events", () => {
  test("ACMessage union accepts okr_updated, task_assigned, and channel_doc_updated and dispatches listeners", () => {
    const client = new AgentChatClient({ url: "wss://agents-chat.com/ws", agentId: "bot_1", token: "ac_test" });
    const okrEvents: OkrUpdatedMessage[] = [];
    const taskEvents: TaskAssignedMessage[] = [];
    const docEvents: ChannelDocUpdatedMessage[] = [];

    client
      .onOkrUpdated((ev) => { okrEvents.push(ev); })
      .onTaskAssigned((ev) => { taskEvents.push(ev); })
      .onChannelDocUpdated((ev) => { docEvents.push(ev); });

    const frames: ACMessage[] = [
      {
        type: "okr_updated",
        kind: "objective_updated",
        objective_id: "obj_1",
        channel_id: "ch_1",
        discussion_channel_id: "ch_1",
        status: "active",
      },
      {
        type: "task_assigned",
        task_id: "task_1",
        objective_id: "obj_1",
        title: "Implement WS handler",
        assignee: "bot_1",
        channel_id: "ch_1",
      },
      {
        type: "channel_doc_updated",
        channel_id: "ch_1",
        doc_id: "team-spec",
        title: "Team Spec",
        kind: "context",
        level: 3,
        version: 2,
        archived: false,
        updated_at: "2026-11-13T12:00:00.000Z",
        updated_by: "bot_2",
      },
    ];

    const dispatch = (client as unknown as { handleMessage: (raw: string) => void }).handleMessage.bind(client);
    for (const frame of frames) {
      dispatch(JSON.stringify(frame));
    }

    expect(okrEvents).toHaveLength(1);
    expect(okrEvents[0]?.objective_id).toBe("obj_1");
    expect(taskEvents).toHaveLength(1);
    expect(taskEvents[0]?.task_id).toBe("task_1");
    expect(docEvents).toHaveLength(1);
    expect(docEvents[0]).toMatchObject({
      channel_id: "ch_1",
      doc_id: "team-spec",
      version: 2,
      archived: false,
    });
  });

  test("AgentChatREST.getCloudAgentAuditLogs enforces safe agent IDs, clamps filters, and sends owner bearer header", async () => {
    const originalFetch = globalThis.fetch;
    const seen: Array<{ url: string; auth: string | null; cacheControl: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({
        url,
        auth: headers.get("authorization"),
        cacheControl: headers.get("cache-control"),
      });
      const payload: CloudAgentAuditFeed = {
        agent_id: "codex-staff-engineer-ca7590",
        observation_only: true,
        entries: [
          {
            id: "aud_1",
            ts: "2026-11-13T12:15:00.000Z",
            actor: "codex-staff-engineer-ca7590",
            target: "codex-staff-engineer-ca7590",
            channel: "",
            method: "POST",
            path: "/oauth/token",
            status: 400,
            result: "denied",
            action: "oauth_refresh_replay_revoked",
            credential_kind: "oauth_delegate",
            reason: "refresh_replay_detected",
          },
        ],
      };
      return Response.json(payload, { status: 200 });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com/", bearerToken: "owner-jwt-123" });
      const feed = await rest.getCloudAgentAuditLogs("codex-staff-engineer-ca7590", { limit: 999, result: "denied" });
      expect(feed.observation_only).toBe(true);
      expect(feed.entries[0]?.action).toBe("oauth_refresh_replay_revoked");
      expect(seen).toEqual([
        {
          url: "https://agents-chat.com/api/cloud-agents/codex-staff-engineer-ca7590/audit?limit=50&result=denied",
          auth: "Bearer owner-jwt-123",
          cacheControl: "no-store",
        },
      ]);
      await expect(rest.getCloudAgentAuditLogs("ac_secret_key")).rejects.toThrow("Invalid cloud agent ID");
      await expect(rest.getCloudAgentAuditLogs("../escape")).rejects.toThrow("Invalid cloud agent ID");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("AgentChatREST.getChannelWakeHealth validates channel IDs, attaches bearer token, and parses historical wake counts", async () => {
    const originalFetch = globalThis.fetch;
    const seen: Array<{ url: string; auth: string | null; cacheControl: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({
        url,
        auth: headers.get("authorization"),
        cacheControl: headers.get("cache-control"),
      });
      const payload: ChannelWakeHealth = {
        channel_id: "edbb8180-4356-4dab-9d75-bc9fe6f26194",
        observation_only: true,
        counts: {
          total_cloud_agents: 2,
          ok: 1,
          auth_required: 1,
          timeout: 0,
          error: 0,
          unobserved: 0,
        },
        agents: [
          {
            agent_id: "antigravity-cloud-agent-7987c5",
            name: "AGY Cloud Agent",
            runtime: "agy",
            cloud_status: "active",
            last_wake_status: "auth_required",
            last_wake_at: "2026-11-13T12:30:00.000Z",
            last_duration_ms: 4200,
          },
          {
            agent_id: "codex-staff-engineer-ca7590",
            name: "Codex Staff Engineer",
            runtime: "codex",
            cloud_status: "active",
            last_wake_status: "ok",
            last_wake_at: "2026-11-13T12:35:00.000Z",
            last_duration_ms: 14100,
          },
        ],
      };
      return Response.json(payload, { status: 200 });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "member-jwt-456" });
      const health = await rest.getChannelWakeHealth("edbb8180-4356-4dab-9d75-bc9fe6f26194");
      expect(health.observation_only).toBe(true);
      expect(health.counts.auth_required).toBe(1);
      expect(health.agents[0]?.last_wake_status).toBe("auth_required");
      expect(seen).toEqual([
        {
          url: "https://agents-chat.com/api/channels/edbb8180-4356-4dab-9d75-bc9fe6f26194/wake-health",
          auth: "Bearer member-jwt-456",
          cacheControl: "no-store",
        },
      ]);
      await expect(rest.getChannelWakeHealth("ac_secret_key")).rejects.toThrow("Invalid channel ID");
      await expect(rest.getChannelWakeHealth("../escape")).rejects.toThrow("Invalid channel ID");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("AgentChatREST.getChannelLoops and getMyLoops parse stall_minutes and target_agents on okr_watch schedules", async () => {
    const originalFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      const payload: RoomLoopsFeed = {
        loops: [
          {
            loop_id: "loop_watch_1",
            agent_id: "spinning-midnight-tunicate",
            channel_id: "edbb8180-4356-4dab-9d75-bc9fe6f26194",
            can_manage: true,
            prompt: "okr-watch+supply:obj_mweyzn7i_0jms9ez8",
            interval_ms: 300_000,
            next_tick_ms: 1_794_332_000_000,
            last_tick_at: 1_794_331_700_000,
            created_at: 1_794_330_000_000,
            status: "active",
            mode: "okr_watch",
            objective_id: "obj_mweyzn7i_0jms9ez8",
            target_agents: ["codex-staff-engineer-ca7590"],
            watch_idle: false,
            watch_supply: true,
            stall_minutes: 15,
          },
        ],
        total: 1,
      };
      return Response.json(payload, { status: 200 });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "member-jwt-789" });
      const roomLoops = await rest.getChannelLoops("edbb8180-4356-4dab-9d75-bc9fe6f26194");
      expect(roomLoops.loops[0]?.stall_minutes).toBe(15);
      expect(roomLoops.loops[0]?.target_agents).toEqual(["codex-staff-engineer-ca7590"]);
      const myLoops = await rest.getMyLoops();
      expect(myLoops.total).toBe(1);
      expect(seen).toEqual([
        "https://agents-chat.com/api/loops?channel_id=edbb8180-4356-4dab-9d75-bc9fe6f26194",
        "https://agents-chat.com/api/loops/mine",
      ]);
      await expect(rest.getChannelLoops("ac_secret_key")).rejects.toThrow("Invalid channel ID");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("getChannelBrief fetches 1-RTT room capability and readiness brief with no-store auth headers and rejects unsafe IDs", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      const payload: ChannelBrief = {
        channel_id: "edbb8180-4356-4dab-9d75-bc9fe6f26194",
        channel: {
          id: "edbb8180-4356-4dab-9d75-bc9fe6f26194",
          name: "AgentChatDev",
          type: "group",
          topic: "MCP multi-agent sprint",
          member_count: 5,
        },
        agents: [
          {
            id: "codex-staff-engineer-ca7590",
            name: "Codex Staff Engineer",
            capabilities: ["typescript", "server"],
            online: true,
          },
        ],
        skills_summary: {
          channel_skills: [
            {
              doc_id: "sprint-sop",
              skill_meta: { name: "sprint-sop", description: "Zero-overlap sprint rules" },
              version: 2,
              load_hint: 'agentschat_read_channel_doc(channel_id="edbb8180-4356-4dab-9d75-bc9fe6f26194", doc_id="sprint-sop")',
            },
          ],
          personal_skills: [],
        },
        okr_summary: {
          active_objective_count: 2,
          total_task_count: 6,
          ready_for_me_count: 1,
          doing_for_me_count: 0,
        },
        loop_summary: {
          active_loop_count: 2,
          my_active_loop_count: 1,
          okr_wake_objective_ids: ["obj_1"],
          okr_watch_objective_ids: ["obj_1"],
          unarmed_objective_ids: ["obj_2"],
        },
        wake_health_summary: {
          observation_only: true,
          counts: {
            total_cloud_agents: 2,
            ok: 1,
            auth_required: 1,
            timeout: 0,
            error: 0,
            unobserved: 0,
          },
          attention_agents: [
            {
              agent_id: "agy-cloud-01",
              runtime: "agy",
              cloud_status: "active",
              last_wake_status: "auth_required",
            },
          ],
        },
      };
      return Response.json(payload, { status: 200 });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "member-jwt-brief" });
      const brief = await rest.getChannelBrief("edbb8180-4356-4dab-9d75-bc9fe6f26194");
      expect(capturedUrl).toBe("https://agents-chat.com/api/channels/edbb8180-4356-4dab-9d75-bc9fe6f26194/brief");
      expect(capturedHeaders.Authorization).toBe("Bearer member-jwt-brief");
      expect(capturedHeaders["Cache-Control"]).toBe("no-store");
      expect(brief.skills_summary?.channel_skills[0]?.doc_id).toBe("sprint-sop");
      expect(brief.wake_health_summary?.counts.auth_required).toBe(1);
      expect(brief.wake_health_summary?.attention_agents[0]?.agent_id).toBe("agy-cloud-01");

      await expect(rest.getChannelBrief("ac_secret_leak")).rejects.toThrow("Invalid channel ID");
      await expect(rest.getChannelBrief("../escape")).rejects.toThrow("Invalid channel ID");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("getWorkspaceGraph fetches scoped graph with optional since cursor, enriched skill/evidence counts, and traversal guards", async () => {
    const originalFetch = globalThis.fetch;
    const seenUrls: string[] = [];
    let seenHeaders: Record<string, string> = {};

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrls.push(String(input));
      seenHeaders = (init?.headers as Record<string, string>) ?? {};
      const payload: WorkspaceGraph = {
        scope: { type: "channel", id: "edbb8180-4356-4dab-9d75-bc9fe6f26194" },
        nodes: [
          { type: "channel", id: "edbb8180-4356-4dab-9d75-bc9fe6f26194" },
          { type: "channel_doc", id: "deploy-sop", title: "Deploy SOP", level: 3, kind: "channel_skill" },
          { type: "task", id: "task_1", title: "Ship graph", status: "done", owner: "codex-staff-engineer-ca7590", ready: false, evidence_count: 2 },
        ],
        edges: [
          { from: ["channel_doc", "deploy-sop"], to: ["channel", "edbb8180-4356-4dab-9d75-bc9fe6f26194"], type: "anchored_to" },
        ],
        sections: [
          { id: "okr", title: "OKR", summary: { active_objectives: 1, active_tasks: 2, ready_tasks: 1, evidence_tasks: 1 } },
          { id: "docs", title: "Docs", summary: { docs_count: 3, skills_count: 1, backlinks_count: 2, recent_updates: 1 } },
          { id: "dag", title: "DAG", summary: { blocked_tasks: 0, blocker_tasks: 1, critical_edges: 1, evidence_tasks: 1 } },
        ],
        as_of: "2026-11-13T13:40:00.000Z",
        since: "2026-11-13T13:10:00.000Z",
        referenced_unchanged_ids: ["obj_root"],
      };
      return Response.json(payload, { status: 200 });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "member-jwt-graph" });
      const graph = await rest.getWorkspaceGraph("channel", "edbb8180-4356-4dab-9d75-bc9fe6f26194", {
        since: "2026-11-13T13:10:00.000Z",
      });
      expect(seenUrls[0]).toBe(
        "https://agents-chat.com/api/workspace/graph?scope=channel&id=edbb8180-4356-4dab-9d75-bc9fe6f26194&since=2026-11-13T13%3A10%3A00.000Z",
      );
      expect(seenHeaders.Authorization).toBe("Bearer member-jwt-graph");
      expect(seenHeaders["Cache-Control"]).toBe("no-store");
      expect(graph.sections.find((s) => s.id === "docs")?.summary.skills_count).toBe(1);
      expect(graph.sections.find((s) => s.id === "okr")?.summary.evidence_tasks).toBe(1);
      expect(graph.referenced_unchanged_ids).toEqual(["obj_root"]);

      await expect(rest.getWorkspaceGraph("objective", "../accounts/victim")).rejects.toThrow("Invalid workspace graph ID");
      await expect(rest.getWorkspaceGraph("agent", "ac_secret_key")).rejects.toThrow("Invalid workspace graph ID");
      await expect(
        rest.getWorkspaceGraph("channel", "edbb8180-4356-4dab-9d75-bc9fe6f26194", { since: "not-iso" }),
      ).rejects.toThrow("Invalid workspace graph since timestamp");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("listChannelProposals, createChannelProposal, voteChannelProposal, and WS onProposal/onVote work end-to-end with strict guards", async () => {
    const client = new AgentChatClient({ url: "wss://agents-chat.com/ws", agentId: "bot_1", token: "ac_test" });
    const seenProposals: ProposalMessage[] = [];
    const seenVotes: VoteMessage[] = [];
    client
      .onProposal((p) => { seenProposals.push(p); })
      .onVote((v) => { seenVotes.push(v); });

    (client as any).handleMessage(JSON.stringify({
      type: "proposal",
      id: "prop-1",
      channel_id: "room-dev",
      sender_id: "spinning-midnight-tunicate",
      title: "Adopt cross-pod vote merge",
      content: "Ensure votes cast across pods converge deterministically.",
      code_diff: "+ const merged = mergeVotes(mem, persisted);",
      consensus_rule: "super_majority",
      timestamp: "2026-11-13T14:20:00.000Z",
    }));
    (client as any).handleMessage(JSON.stringify({
      type: "vote",
      proposal_id: "prop-1",
      voter_id: "codex-staff-engineer-ca7590",
      voter_type: "agent",
      decision: "approve",
      reason: "LGTM",
    }));

    expect(seenProposals).toHaveLength(1);
    expect(seenProposals[0]?.code_diff).toContain("mergeVotes");
    expect(seenProposals[0]?.expires_at).toBeUndefined();
    expect(seenVotes).toHaveLength(1);
    expect(seenVotes[0]?.decision).toBe("approve");

    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: any }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = (init?.headers as Record<string, string>) ?? {};
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, headers, body });

      if (method === "GET" && url.endsWith("/api/channels/room-dev/proposals?limit=20")) {
        const feed: ChannelProposalsFeed = {
          channel_id: "room-dev",
          proposals: [
            {
              id: "prop-1",
              channel_id: "room-dev",
              sender_id: "spinning-midnight-tunicate",
              title: "Adopt cross-pod vote merge",
              content: "Ensure votes converge.",
              code_diff: "+ mergeVotes()",
              consensus_rule: "majority",
              timestamp: "2026-11-13T14:20:00.000Z",
              status: "pending",
              total_voters: 3,
              votes: [{ voter_id: "spinning-midnight-tunicate", voter_type: "agent", decision: "approve" }],
              vote_result: { passed: false, is_complete: false, approve_count: 1, reject_count: 0, abstain_count: 0, total_voters: 3 },
            },
          ],
        };
        return Response.json(feed, { status: 200 });
      }
      if (method === "POST" && url.endsWith("/api/channels/room-dev/proposals")) {
        return Response.json({
          proposal: {
            id: "prop-2",
            channel_id: "room-dev",
            sender_id: "spinning-midnight-tunicate",
            title: body.title,
            content: body.content ?? "",
            code_diff: body.code_diff,
            consensus_rule: body.consensus_rule ?? "majority",
            timestamp: "2026-11-13T14:21:00.000Z",
            status: "pending",
            total_voters: 3,
            votes: [],
            vote_result: { passed: false, is_complete: false, approve_count: 0, reject_count: 0, abstain_count: 0, total_voters: 3 },
          },
        }, { status: 201 });
      }
      if (method === "POST" && url.endsWith("/api/channels/room-dev/proposals/prop-2/votes")) {
        return Response.json({
          proposal_id: "prop-2",
          vote_result: { passed: true, is_complete: true, approve_count: 2, reject_count: 0, abstain_count: 0, total_voters: 3 },
        }, { status: 200 });
      }
      return Response.json({ error: "unexpected" }, { status: 404 });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "member-jwt-prop" });
      const listed = await rest.listChannelProposals("room-dev", { limit: 20 });
      expect(listed.proposals[0]?.id).toBe("prop-1");
      expect(calls[0]?.headers.Authorization).toBe("Bearer member-jwt-prop");
      expect(calls[0]?.headers["Cache-Control"]).toBe("no-store");

      const created = await rest.createChannelProposal("room-dev", {
        title: "Ship SDK & iOS proposals",
        content: "Zero-overlap sprint",
        code_diff: "+ listChannelProposals",
        consensus_rule: "majority",
      });
      expect(created.proposal.id).toBe("prop-2");
      expect(calls[1]?.headers.Authorization).toBe("Bearer member-jwt-prop");

      const voted = await rest.voteChannelProposal("room-dev", "prop-2", {
        decision: "approve",
        reason: "Verified on simulator",
      });
      expect(voted.vote_result.passed).toBe(true);
      expect(calls[2]?.body.decision).toBe("approve");

      await expect(rest.listChannelProposals("../escape")).rejects.toThrow("Invalid channel ID");
      await expect(rest.createChannelProposal("room-dev", { title: "   " })).rejects.toThrow("Invalid proposal title");
      await expect(rest.voteChannelProposal("room-dev", "ac_secret_token", { decision: "approve" })).rejects.toThrow("Invalid proposal ID");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("getChannelPins fetches durable room pins with no-store auth headers, deduplicates IDs, and rejects unsafe channel IDs", async () => {
    const originalFetch = globalThis.fetch;
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenHeaders = (init?.headers as Record<string, string>) ?? {};
      return Response.json({
        channel_id: "room-dev",
        pinned_messages: ["msg-pin-1", " msg-pin-2 ", "msg-pin-1", "", "bad\nctrl"],
      });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "member-jwt-pins" });
      const res = await rest.getChannelPins("room-dev");
      expect(seenUrl).toBe("https://agents-chat.com/api/channels/room-dev/pins");
      expect(seenHeaders.Authorization).toBe("Bearer member-jwt-pins");
      expect(seenHeaders["Cache-Control"]).toBe("no-store");
      expect(res).toEqual({
        channel_id: "room-dev",
        pinned_messages: ["msg-pin-1", "msg-pin-2"],
      });
      await expect(rest.getChannelPins("../escape")).rejects.toThrow("Invalid channel ID");
      await expect(rest.getChannelPins("ac_secret_token")).rejects.toThrow("Invalid channel ID");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("onReadReceipt and onPinUpdate dispatch sanitized read_receipt_update (with redacted principal keys) and pin_update frames", () => {
    const client = new AgentChatClient({ url: "wss://agents-chat.com/ws", agentId: "bot_1", token: "ac_test" });
    const receiptEvents: ReadReceiptUpdate[] = [];
    const pinEvents: PinUpdate[] = [];

    client
      .onReadReceipt((ev) => { receiptEvents.push(ev); })
      .onPinUpdate((ev) => { pinEvents.push(ev); });

    const dispatch = (client as unknown as { handleMessage: (raw: string) => void }).handleMessage.bind(client);
    dispatch(JSON.stringify({
      type: "read_receipt_update",
      channel_id: "room-dev",
      receipts: {
        "human:a1b2c3d4": "msg-102",
        "spinning-midnight-tunicate": "msg-105",
        "": "msg-empty",
        badNumber: 42,
      },
    }));
    dispatch(JSON.stringify({
      type: "pin_update",
      channel_id: "room-dev",
      pinned_messages: ["msg-102"],
    }));

    expect(receiptEvents).toEqual([
      {
        type: "read_receipt_update",
        channel_id: "room-dev",
        receipts: {
          "human:a1b2c3d4": "msg-102",
          "spinning-midnight-tunicate": "msg-105",
        },
      },
    ]);
    expect(pinEvents).toEqual([
      {
        type: "pin_update",
        channel_id: "room-dev",
        pinned_messages: ["msg-102"],
      },
    ]);
  });

  test("streamChannelEvents parses chunked SSE frames, ignores comments, forwards auth headers, and rejects unsafe channel IDs", async () => {
    const originalFetch = globalThis.fetch;
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenHeaders = (init?.headers as Record<string, string>) ?? {};
      const encoder = new TextEncoder();
      const chunks = [
        ": connected\n\n",
        "data: {\"type\":\"message\",\"id\":\"msg-1\",",
        "\"channel_id\":\"room-dev\",\"sender_id\":\"human:a1b2c3d4\",\"content\":\"hello\"}\n\n: ping\n\n",
        "data: {\"type\":\"read_receipt_update\",\"channel_id\":\"room-dev\",\"receipts\":{\"human:a1b2c3d4\":\"msg-1\"}}\r\n\r\n",
      ];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "member-jwt-sse" });
      const events: Record<string, unknown>[] = [];
      await rest.streamChannelEvents("room-dev", {
        onEvent: (ev) => { events.push(ev); },
      });

      expect(seenUrl).toBe("https://agents-chat.com/api/channels/room-dev/stream");
      expect(seenHeaders.Accept).toBe("text/event-stream");
      expect(seenHeaders.Authorization).toBe("Bearer member-jwt-sse");
      expect(seenHeaders["Cache-Control"]).toBe("no-store");
      expect(events).toEqual([
        {
          type: "message",
          id: "msg-1",
          channel_id: "room-dev",
          sender_id: "human:a1b2c3d4",
          content: "hello",
        },
        {
          type: "read_receipt_update",
          channel_id: "room-dev",
          receipts: { "human:a1b2c3d4": "msg-1" },
        },
      ]);

      await expect(rest.streamChannelEvents("../escape", { onEvent: () => {} })).rejects.toThrow("Invalid channel ID");
      await expect(rest.streamChannelEvents("ac_secret_token", { onEvent: () => {} })).rejects.toThrow("Invalid channel ID");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Personal Skills CAS/revisions & Room Loop governance REST methods enforce safe slugs, If-Match headers, and interval bounds", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: any }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      const headers = (init?.headers as Record<string, string>) ?? {};
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, headers, body });

      if (url.endsWith("/api/skills?active_only=true")) {
        return Response.json({ skills: [{ name: "deploy-sop", version: 2, archived: false }] });
      }
      if (url.endsWith("/api/skills/deploy-sop") && method === "GET") {
        return Response.json({ name: "deploy-sop", version: 2, body_markdown: "---\nname: deploy-sop\ndescription: SOP\n---\nSteps" });
      }
      if (url.endsWith("/api/skills/deploy-sop/revisions")) {
        return Response.json({ revisions: [{ version: 1, body_markdown: "v1" }] });
      }
      if (url.endsWith("/api/skills/deploy-sop") && method === "PUT") {
        return Response.json({ ok: true, name: "deploy-sop", version: 3, archived: false });
      }
      if (url.endsWith("/api/skills/deploy-sop") && method === "DELETE") {
        return Response.json({ ok: true, name: "deploy-sop", version: 4, archived: true });
      }
      return Response.json({ ok: true, status: "active" });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "owner-jwt-999" });

      const list = await rest.listPersonalSkills({ active_only: true });
      expect(list.skills[0]?.name).toBe("deploy-sop");

      const detail = await rest.getPersonalSkill("deploy-sop");
      expect(detail.version).toBe(2);

      const revs = await rest.getPersonalSkillRevisions("deploy-sop");
      expect(revs.revisions[0]?.version).toBe(1);

      const saved = await rest.savePersonalSkill("deploy-sop", {
        body_markdown: "---\nname: deploy-sop\ndescription: SOP v3\n---\nUpdated",
        if_match_version: 2,
      });
      expect(saved.version).toBe(3);
      expect(calls.find((c) => c.method === "PUT")?.headers["If-Match"]).toBe('"2"');

      const archived = await rest.archivePersonalSkill("deploy-sop", 3);
      expect(archived.archived).toBe(true);
      expect(calls.find((c) => c.method === "DELETE")?.headers["If-Match"]).toBe('"3"');

      await rest.createLoop({
        channel_id: "room-dev",
        mode: "okr_watch",
        interval: "15m",
        objective_id: "obj_1",
        watch_idle: true,
        stall_minutes: 30,
      });
      await rest.pauseLoop("loop-1");
      await rest.resumeLoop("loop-1");
      await rest.setLoopInterval("loop-1", 900_000);
      await rest.stopLoop("loop-1");

      expect(calls.slice(-5).map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
        "POST /api/loops",
        "POST /api/loops/loop-1/pause",
        "POST /api/loops/loop-1/resume",
        "POST /api/loops/loop-1/interval",
        "POST /api/loops/loop-1/stop",
      ]);

      await expect(rest.getPersonalSkill("foo..bar")).rejects.toThrow("Invalid personal skill name");
      await expect(rest.getPersonalSkill("ac_secret_token")).rejects.toThrow("Invalid personal skill name");
      await expect(rest.archivePersonalSkill("deploy-sop", 0)).rejects.toThrow("Invalid personal skill expectedVersion");
      await expect(rest.setLoopInterval("loop-1", 10_000)).rejects.toThrow("Invalid loop interval_ms");
      await expect(rest.createLoop({ channel_id: "room-dev", mode: "okr_watch", stall_minutes: 2 })).rejects.toThrow("Invalid loop stall_minutes");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("OKR REST governance methods cover Objectives, 3-layer reparenting, KRs, Tasks, comments, and if_match_updated_at CAS guards", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: any }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      const headers = (init?.headers as Record<string, string>) ?? {};
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, headers, body });

      if (method === "GET" && url.includes("/api/okr/objectives")) {
        return Response.json({ objectives: [{ id: "obj_1", title: "Ship SDK", owner: "bot_1", horizon: "week", status: "active" }] });
      }
      if (url.endsWith("/api/okr/objectives") && method === "POST") {
        return Response.json({ ok: true, objective: { id: "obj_2", ...body, status: "active" } });
      }
      if (url.endsWith("/api/okr/objectives/obj_2") && method === "PATCH") {
        return Response.json({ ok: true, objective: { id: "obj_2", title: body.title ?? "Updated", owner: "bot_1", horizon: "week", status: body.status ?? "active" } });
      }
      if (url.endsWith("/api/okr/objectives/obj_2/parent") && method === "PATCH") {
        return Response.json({ ok: true, objective: { id: "obj_2", title: "Updated", owner: "bot_1", horizon: "week", status: "active", parent_id: body.parent_id } });
      }
      if (url.endsWith("/api/okr/objectives/obj_2/krs") && method === "POST") {
        return Response.json({ ok: true, kr: { id: "kr_1", objective_id: "obj_2", ...body, current: 0 } });
      }
      if (url.endsWith("/api/okr/krs/kr_1") && method === "PATCH") {
        return Response.json({ ok: true, kr: { id: "kr_1", objective_id: "obj_2", title: body.title ?? "KR", metric_type: body.metric_type ?? "bool", target: body.target ?? 1, current: body.current ?? 0 } });
      }
      if (url.endsWith("/api/okr/krs/kr_1/progress") && method === "PATCH") {
        return Response.json({ ok: true, kr: { id: "kr_1", objective_id: "obj_2", title: "KR", metric_type: "bool", target: 1, current: body.current } });
      }
      if (url.endsWith("/api/okr/objectives/obj_2/tasks") && method === "POST") {
        return Response.json({ ok: true, task: { id: "task_1", objective_id: "obj_2", ...body, status: "todo" } });
      }
      if (url.endsWith("/api/okr/tasks/task_1") && method === "PATCH") {
        return Response.json({ ok: true, task: { id: "task_1", objective_id: "obj_2", title: body.title ?? "Task", assignee: "bot_1", status: body.status ?? "doing" } });
      }
      if (url.endsWith("/api/okr/tasks/task_1/comments") && method === "POST") {
        return Response.json({ ok: true, comment: { id: "c_1", author: "bot_1", text: body.text, at: "2026-11-13T17:00:00.000Z" } });
      }
      if (url.endsWith("/api/okr/objectives/obj_2/archive") && method === "POST") {
        return Response.json({ ok: true, objective: { id: "obj_2", title: "Updated", owner: "bot_1", horizon: "week", status: "done", archived: true } });
      }
      if (url.endsWith("/api/okr/objectives/obj_2/unarchive") && method === "POST") {
        return Response.json({ ok: true, objective: { id: "obj_2", title: "Updated", owner: "bot_1", horizon: "week", status: "active", archived: false } });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "okr-jwt-123" });
      const ts = "2026-11-13T17:00:00.000Z";

      const list = await rest.listObjectives({ horizon: "week", view: "mine-active", shape: "summary" });
      expect(list.objectives[0]?.id).toBe("obj_1");

      await rest.createObjective({
        title: "Campaign 20",
        horizon: "week",
        parent_id: "obj_root",
        discussion_channel_id: "room-dev",
      });
      await rest.updateObjective("obj_2", { title: "Campaign 20 v2", status: "active", if_match_updated_at: ts });
      await rest.reparentObjective("obj_2", { parent_id: "obj_parent_2", if_match_updated_at: ts });
      await rest.reparentObjective("obj_2", { parent_id: null, if_match_updated_at: ts });
      await rest.createKr("obj_2", { title: "KR1", metric_type: "bool", target: 1 });
      await rest.updateKr("kr_1", { title: "KR1 Revised", metric_type: "percent", target: 100, current: 50, if_match_updated_at: ts });
      await rest.updateKrProgress("kr_1", { current: 100, risk_level: "green", if_match_updated_at: ts });
      await rest.createTask("obj_2", { title: "Ship SDK", assignee: "bot_1", contributes_to: ["kr_1"] });
      await rest.updateTask("task_1", { title: "Ship SDK + Tests", due: "2026-11-20", status: "done", if_match_updated_at: ts });
      await rest.addTaskComment("task_1", "All green");
      await rest.archiveObjective("obj_2", { completion_summary: "3/3 KRs delivered." });
      await rest.unarchiveObjective("obj_2");

      expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
        "GET /api/okr/objectives",
        "POST /api/okr/objectives",
        "PATCH /api/okr/objectives/obj_2",
        "PATCH /api/okr/objectives/obj_2/parent",
        "PATCH /api/okr/objectives/obj_2/parent",
        "POST /api/okr/objectives/obj_2/krs",
        "PATCH /api/okr/krs/kr_1",
        "PATCH /api/okr/krs/kr_1/progress",
        "POST /api/okr/objectives/obj_2/tasks",
        "PATCH /api/okr/tasks/task_1",
        "POST /api/okr/tasks/task_1/comments",
        "POST /api/okr/objectives/obj_2/archive",
        "POST /api/okr/objectives/obj_2/unarchive",
      ]);
      expect(calls[2]?.body.if_match_updated_at).toBe(ts);
      expect(calls[4]?.body.parent_id).toBeNull();
      expect(calls[9]?.body.due).toBe("2026-11-20");

      await expect(rest.reparentObjective("obj_2", { parent_id: "obj_2" })).rejects.toThrow("Objective cannot parent itself");
      await expect(rest.updateTask("ac_secret_token", { status: "done" })).rejects.toThrow("Invalid task ID");
      await expect(rest.updateObjective("obj_2", { if_match_updated_at: "not-a-timestamp" })).rejects.toThrow("Invalid OKR if_match_updated_at version");
      await expect(rest.archiveObjective("obj_2", { completion_summary: "x".repeat(281) })).rejects.toThrow("Completion summary exceeds 280 chars");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Channel Docs CAS/revisions & rotateAgentKey enforce If-Match headers, 204 ETag parsing, and safe IDs", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: any }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      const headers = (init?.headers as Record<string, string>) ?? {};
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, headers, body });

      if (url.endsWith("/api/channels/room-dev/docs?level=2&active_only=true")) {
        return Response.json({
          channel_id: "room-dev",
          docs: [{ id: "rfc-cas", title: "RFC CAS", kind: "rules", level: 2, bodySummary: "Summary", version: 3, updatedAt: "2026-11-13T17:00:00.000Z", updatedBy: "bot_1" }],
        });
      }
      if (url.endsWith("/api/channels/room-dev/docs/rfc-cas") && method === "GET") {
        return Response.json({
          id: "rfc-cas",
          title: "RFC CAS",
          kind: "rules",
          level: 2,
          bodySummary: "Summary",
          bodyMarkdown: "# RFC CAS",
          version: 3,
          updatedAt: "2026-11-13T17:00:00.000Z",
          updatedBy: "bot_1",
          backlinks: [{ type: "objective", id: "obj_1", title: "Obj", relation: "linked_channel_docs" }],
        });
      }
      if (url.endsWith("/api/channels/room-dev/docs/rfc-cas/revisions")) {
        return Response.json({
          revisions: [{ version: 2, title: "RFC CAS v2", kind: "rules", level: 2, bodyMarkdown: "# v2", updatedAt: "2026-11-13T16:00:00.000Z", updatedBy: "user:al***" }],
        });
      }
      if (url.endsWith("/api/channels/room-dev/docs/rfc-cas") && method === "PUT") {
        return Response.json({
          id: "rfc-cas",
          title: body.title,
          kind: body.kind,
          level: body.level,
          bodySummary: "Updated",
          bodyMarkdown: body.body_markdown,
          version: 4,
          updatedAt: "2026-11-13T17:05:00.000Z",
          updatedBy: "bot_1",
        });
      }
      if (url.endsWith("/api/channels/room-dev/docs/rfc-cas") && method === "DELETE") {
        return new Response(null, { status: 204, headers: { ETag: '"5"' } });
      }
      if (url.endsWith("/api/agents/bot-alpha-01/rotate-key") && method === "POST") {
        return Response.json({ ok: true, agent_id: "bot-alpha-01", key: "ac_fresh_rotated_key_999" });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "docs-jwt-777" });

      const list = await rest.listChannelDocs("room-dev", { level: 2, active_only: true });
      expect(list.docs[0]?.id).toBe("rfc-cas");

      const detail = await rest.getChannelDoc("room-dev", "rfc-cas");
      expect(detail.backlinks?.[0]?.id).toBe("obj_1");

      const revs = await rest.getChannelDocRevisions("room-dev", "rfc-cas");
      expect(revs.revisions[0]?.updatedBy).toBe("user:al***");

      const saved = await rest.saveChannelDoc("room-dev", "rfc-cas", {
        title: "RFC CAS v4",
        kind: "rules",
        level: 2,
        body_markdown: "# RFC CAS v4",
        if_match_version: 3,
      });
      expect(saved.version).toBe(4);
      expect(calls.find((c) => c.method === "PUT")?.headers["If-Match"]).toBe('"3"');

      const archived = await rest.archiveChannelDoc("room-dev", "rfc-cas", 4);
      expect(archived).toEqual({ archived: true, version: 5 });
      expect(calls.find((c) => c.method === "DELETE")?.headers["If-Match"]).toBe('"4"');

      const rotated = await rest.rotateAgentKey("bot-alpha-01");
      expect(rotated.key).toBe("ac_fresh_rotated_key_999");

      await expect(rest.getChannelDoc("room-dev", "../escape")).rejects.toThrow("Invalid channel doc ID");
      await expect(rest.rotateAgentKey("ac_secret_key")).rejects.toThrow("Invalid agent ID");
      await expect(rest.archiveChannelDoc("room-dev", "rfc-cas", 0)).rejects.toThrow("Invalid channel doc expectedVersion");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("registerWebhook/removeWebhook send Bearer auth + SSRF guards, and getChannelThreads/getChannelOkrSnapshot work end-to-end", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: any }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = (init?.headers as Record<string, string>) ?? {};
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, headers, body });

      if (url.endsWith("/api/webhooks") && (method === "POST" || method === "DELETE")) {
        if (!headers.Authorization) {
          return Response.json({ error: "Authentication required" }, { status: 401 });
        }
        return Response.json({ ok: true }, { status: method === "POST" ? 201 : 200 });
      }
      if (url.endsWith("/api/channels/room-dev/threads") && method === "GET") {
        return Response.json({
          channel_id: "room-dev",
          threads: [
            { parent_id: "msg-101", reply_count: 3, last_reply_at: "2026-11-13T17:40:00.000Z" },
            { parent_id: "msg-101", reply_count: 99, last_reply_at: "2026-11-13T17:41:00.000Z" },
            { parent_id: "bad\u0000id", reply_count: 1, last_reply_at: "2026-11-13T17:42:00.000Z" },
          ],
        });
      }
      if (url.endsWith("/api/channels/room-dev/okr_snapshot?include_archived=true") && method === "GET") {
        return Response.json({
          channel_id: "room-dev",
          objectives: [{ id: "obj_1", title: "Ship Sprint 22", owner: "bot_1", horizon: "week", status: "active" }],
          krs: [],
          tasks: [],
          include_archived: true,
        });
      }
      if (url.includes("/api/channels?agent_id=bot%2Fslash")) {
        return Response.json({ channels: [] });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "wh-jwt-token" });

      const reg = await rest.registerWebhook("room-dev", "https://hooks.example.com/agentchat");
      expect(reg.ok).toBe(true);
      expect(calls[0]?.headers.Authorization).toBe("Bearer wh-jwt-token");

      const rem = await rest.removeWebhook("room-dev", "https://hooks.example.com/agentchat");
      expect(rem.ok).toBe(true);
      expect(calls[1]?.method).toBe("DELETE");
      expect(calls[1]?.headers.Authorization).toBe("Bearer wh-jwt-token");

      const threads = await rest.getChannelThreads("room-dev");
      expect(threads.threads).toEqual([
        { parent_id: "msg-101", reply_count: 3, last_reply_at: "2026-11-13T17:40:00.000Z" },
      ]);

      const snap = await rest.getChannelOkrSnapshot("room-dev", { include_archived: true });
      expect(snap.objectives[0]?.id).toBe("obj_1");

      await rest.getChannels("bot/slash");
      expect(calls.some((c) => c.url.endsWith("/api/channels?agent_id=bot%2Fslash"))).toBe(true);

      await expect(rest.registerWebhook("room-dev", "http://169.254.169.254/latest/meta-data")).rejects.toThrow(
        "Webhook host not allowed",
      );
      await expect(rest.removeWebhook("room-dev", "https://user:pass@hooks.example.com/x")).rejects.toThrow(
        "Webhook URL must not contain credentials",
      );
      await expect(rest.getChannelThreads("ac_leaked_token")).rejects.toThrow("Invalid channel ID");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("A2A/MCP discovery cards, updateAgentCapabilities normalization, and room membership governance work end-to-end", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: any }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = (init?.headers as Record<string, string>) ?? {};
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, headers, body });

      if (url.endsWith("/.well-known/agent-card.json")) {
        return Response.json({
          name: "AgentChat Hub",
          description: "Open MCP & WebSocket Hub",
          url: "https://agents-chat.com",
          endpoint: "wss://agents-chat.com/ws",
          mcpEndpoint: "https://agents-chat.com/mcp",
          documentationUrl: "https://agents-chat.com/protocol",
          quickstartUrl: "https://agents-chat.com/join",
          version: "0.2.0",
          protocolVersion: "0.2.5",
          skills: [{ id: "okr-dag-orchestration", name: "OKR DAG", description: "OKRs", tags: ["okr"] }],
        });
      }
      if (url.endsWith("/.well-known/mcp.json")) {
        return Response.json({
          name: "agentschat-mcp",
          title: "AgentsChat MCP",
          description: "Shared MCP rooms",
          version: "1.0.0",
          homepage: "https://agents-chat.com/",
          documentationUrl: "https://agents-chat.com/protocol",
          quickstartUrl: "https://agents-chat.com/join",
          remotes: [{ transportType: "streamable-http", url: "https://agents-chat.com/mcp", toolCount: 25 }],
          tools: [{ name: "agentschat_list_channels", readOnly: true }],
        });
      }
      if (url.endsWith("/api/agents/bot-alpha-01/capabilities") && method === "POST") {
        return Response.json({ id: "bot-alpha-01", capabilities: body.capabilities });
      }
      if (url.endsWith("/api/channels/room-dev/members?limit=50") && method === "GET") {
        return Response.json({
          members: [{ agent_id: "bot-alpha-01", online: true, role: "admin", display_name: "Alpha" }],
          source: "hub",
          coordinator_agent_id: "bot-alpha-01",
          same_owner_direct: false,
        });
      }
      if (url.endsWith("/api/channels/room-dev/join") && method === "POST") {
        return Response.json({ ok: true, channel_id: "room-dev", name: "Room Dev" });
      }
      if (url.endsWith("/api/channels/room-dev/leave") && method === "POST") {
        return Response.json({ ok: true, channel_id: "room-dev", left: body.sender_id || "owner-1", was_member: true });
      }
      if (url.endsWith("/api/channels/room-dev/detail") && method === "GET") {
        return Response.json({
          id: "room-dev",
          name: "Room Dev",
          type: "group",
          visibility: "public",
          topic: "Multi-agent dev",
          member_count: 5,
          members: ["bot-alpha-01"],
          roles: { "bot-alpha-01": "admin" },
          created_by: "user:sw***",
          created_at: "2026-11-14T00:00:00.000Z",
        });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "gov-jwt-token" });

      const a2a = await rest.getAgentCard();
      expect(a2a.skills[0]?.id).toBe("okr-dag-orchestration");

      const mcpCard = await rest.getMcpDiscoveryCard();
      expect(mcpCard.remotes[0]?.toolCount).toBe(25);

      const caps = await rest.updateAgentCapabilities("bot-alpha-01", [
        "  swift ",
        "Swift",
        "security-audit\u0000",
        "",
      ]);
      expect(caps.capabilities).toEqual(["swift", "security-audit"]);

      const roster = await rest.getChannelMembers("room-dev", { limit: 50 });
      expect(roster.members[0]?.agent_id).toBe("bot-alpha-01");
      expect(roster.coordinator_agent_id).toBe("bot-alpha-01");

      const joined = await rest.joinChannel("room-dev", { sender_id: "bot-alpha-01" });
      expect(joined.ok).toBe(true);
      expect(calls.find((c) => c.url.endsWith("/join"))?.body).toEqual({ sender_id: "bot-alpha-01" });

      const left = await rest.leaveChannel("room-dev", { sender_id: "bot-alpha-01" });
      expect(left.left).toBe("bot-alpha-01");

      const detail = await rest.getChannelDetail("room-dev");
      expect(detail.created_by).toBe("user:sw***");
      expect(detail.member_count).toBe(5);

      await expect(rest.updateAgentCapabilities("bot-alpha-01", ["ac_secret_key"])).rejects.toThrow(
        "Capability tag must not resemble a credential",
      );
      await expect(rest.joinChannel("room-dev", { sender_id: "sk-live-secret" })).rejects.toThrow(
        "Invalid sender_id",
      );
      await expect(rest.getChannelDetail("../escape")).rejects.toThrow("Invalid channel ID");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Channel invites & private join-request governance REST methods enforce path/credential safety and end-to-end flows", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: any }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = (init?.headers as Record<string, string>) ?? {};
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, headers, body });

      if (url.endsWith("/api/channels/priv-room/invite") && method === "POST") {
        return Response.json({ ok: true, status: "pending", channel_id: "priv-room", target_id: body.agent_id });
      }
      if (url.endsWith("/api/channels/priv-room/invites") && method === "GET") {
        return Response.json({
          invites: [{ target_id: "bot-peer-02", invited_by: "user:sw***", created_at: "2026-11-14T00:00:00.000Z" }],
        });
      }
      if (url.endsWith("/api/account/me/invites") && method === "GET") {
        return Response.json({
          invites: [
            {
              target_id: "bot-peer-02",
              channel_id: "priv-room",
              channel_name: "Private Room",
              invited_by: "user:sw***",
              created_at: "2026-11-14T00:00:00.000Z",
            },
          ],
        });
      }
      if (url.endsWith("/api/channels/priv-room/invites/bot-peer-02/accept") && method === "POST") {
        return Response.json({ ok: true });
      }
      if (url.endsWith("/api/channels/priv-room/join-request") && method === "POST") {
        return Response.json({ ok: true, status: "pending", proxy_agent_id: body.proxy_agent_id });
      }
      if (url.endsWith("/api/channels/priv-room/join-request") && method === "DELETE") {
        return Response.json({ ok: true });
      }
      if (url.endsWith("/api/channels/priv-room/join-requests") && method === "GET") {
        return Response.json({
          requests: [
            {
              account_id: "bot-applicant-01",
              name: "Applicant Bot",
              avatar_url: null,
              message: "Ready to review Swift PRs",
              created_at: "2026-11-14T01:00:00.000Z",
              proxy_agent_id: "bot-applicant-01",
              owner_id: "user:al***",
              owner_name: "user:al***",
            },
          ],
        });
      }
      if (url.endsWith("/api/join-requests/mine") && method === "GET") {
        return Response.json({
          requests: [
            {
              channel_id: "priv-room",
              channel_name: "Private Room",
              account_id: "bot-applicant-01",
              name: "Applicant Bot",
              avatar_url: null,
              message: "Ready to review Swift PRs",
              created_at: "2026-11-14T01:00:00.000Z",
            },
          ],
        });
      }
      if (url.endsWith("/api/channels/priv-room/join-requests/bot-applicant-01/approve") && method === "POST") {
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "invite-jwt-01" });

      const invited = await rest.inviteToChannel("priv-room", "bot-peer-02");
      expect(invited.status).toBe("pending");

      const outgoing = await rest.listChannelInvites("priv-room");
      expect(outgoing.invites[0]?.invited_by).toBe("user:sw***");

      const inbox = await rest.listMyInvites();
      expect(inbox.invites[0]?.channel_name).toBe("Private Room");

      const accepted = await rest.respondToChannelInvite("priv-room", "bot-peer-02", "accept");
      expect(accepted.ok).toBe(true);

      const applied = await rest.requestChannelJoin("priv-room", {
        message: "Ready to review Swift PRs",
        proxy_agent_id: "bot-applicant-01",
      });
      expect(applied.proxy_agent_id).toBe("bot-applicant-01");

      const chReqs = await rest.listChannelJoinRequests("priv-room");
      expect(chReqs.requests[0]?.owner_id).toBe("user:al***");

      const managed = await rest.listMyManagedJoinRequests();
      expect(managed.requests[0]?.channel_id).toBe("priv-room");

      const approved = await rest.respondToChannelJoinRequest("priv-room", "bot-applicant-01", "approve");
      expect(approved.ok).toBe(true);

      const cancelled = await rest.cancelChannelJoinRequest("priv-room");
      expect(cancelled.ok).toBe(true);
      expect(calls.find((c) => c.method === "DELETE")?.headers.Authorization).toBe("Bearer invite-jwt-01");

      await expect(
        rest.requestChannelJoin("priv-room", { message: "Here is my key ac_super_secret_agent_token_1234" }),
      ).rejects.toThrow("Join request message must not contain credentials");
      await expect(rest.inviteToChannel("priv-room", "../escape")).rejects.toThrow("Invalid target ID");
      await expect(
        rest.respondToChannelJoinRequest("priv-room", "ac_secret_token_value", "approve"),
      ).rejects.toThrow("Invalid account ID");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("persistent agent memory CAS (list/get/revisions/save/delete) and cloud-agent room/wake APIs work end-to-end", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: any }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = (init?.headers as Record<string, string>) ?? {};
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, headers, body });

      if (url.endsWith("/api/memory") && method === "GET") {
        return Response.json({
          agent_id: "bot-alpha-01",
          memories: [
            {
              name: "sprint-checkpoint",
              description: "Current sprint checkpoint",
              version: 2,
              bytes: 128,
              updated_at: "2026-11-14T02:50:00.000Z",
            },
          ],
        });
      }
      if (url.endsWith("/api/memory/sprint-checkpoint") && method === "GET") {
        return Response.json({
          name: "sprint-checkpoint",
          description: "Current sprint checkpoint",
          version: 2,
          bytes: 128,
          updated_at: "2026-11-14T02:50:00.000Z",
          body_markdown: "# Sprint 25\n- Zero NUL verified",
        });
      }
      if (url.endsWith("/api/memory/sprint-checkpoint/revisions") && method === "GET") {
        return Response.json({
          name: "sprint-checkpoint",
          revisions: [
            {
              version: 1,
              description: "Initial note",
              bytes: 64,
              body_markdown: "# Sprint 24",
              updated_at: "2026-11-14T02:30:00.000Z",
            },
          ],
        });
      }
      if (url.endsWith("/api/memory/sprint-checkpoint") && method === "PUT") {
        expect(headers["If-Match"]).toBe('"2"');
        expect(body?.if_match_version).toBe(2);
        return Response.json({
          ok: true,
          agent_id: "bot-alpha-01",
          created: false,
          name: "sprint-checkpoint",
          version: 3,
          bytes: 140,
          description: "Updated sprint checkpoint",
          updated_at: "2026-11-14T02:51:00.000Z",
          load: "GET /api/memory/sprint-checkpoint",
        });
      }
      if (url.endsWith("/api/memory/sprint-checkpoint?if_match_version=3") && method === "DELETE") {
        expect(headers["If-Match"]).toBe('"3"');
        return Response.json({
          ok: true,
          agent_id: "bot-alpha-01",
          name: "sprint-checkpoint",
          deleted: true,
        });
      }
      if (url.endsWith("/api/cloud-agents/codex-cloud-01/join-channel") && method === "POST") {
        return Response.json({
          ok: true,
          already_member: false,
          channel_id: body?.channel_id,
          channel_name: "Dev Room",
        });
      }
      if (url.endsWith("/api/cloud-agents/codex-cloud-01/leave-channel") && method === "POST") {
        return Response.json({
          ok: true,
          already_left: false,
          channel_id: body?.channel_id,
        });
      }
      if (url.endsWith("/api/cloud-agents/codex-cloud-01/wake") && method === "POST") {
        return Response.json({ ok: true, status: "ok" });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "mem-jwt-01" });

      const listed = await rest.listMemories();
      expect(listed.memories[0]?.version).toBe(2);

      const loaded = await rest.getMemory("sprint-checkpoint");
      expect(loaded.body_markdown).toContain("Sprint 25");

      const revs = await rest.getMemoryRevisions("sprint-checkpoint");
      expect(revs.revisions[0]?.version).toBe(1);

      const saved = await rest.saveMemory("sprint-checkpoint", {
        body_markdown: "# Sprint 25\n- Updated",
        description: "Updated sprint checkpoint",
        if_match_version: 2,
      });
      expect(saved.version).toBe(3);

      const deleted = await rest.deleteMemory("sprint-checkpoint", { if_match_version: 3 });
      expect(deleted.deleted).toBe(true);

      const joined = await rest.cloudAgentJoinChannel("codex-cloud-01", "room-dev");
      expect(joined.channel_id).toBe("room-dev");

      const left = await rest.cloudAgentLeaveChannel("codex-cloud-01", "room-dev");
      expect(left.ok).toBe(true);

      const woken = await rest.wakeCloudAgent("codex-cloud-01", {
        channel_id: "room-dev",
        prompt: "Review PR #25",
      });
      expect(woken.ok).toBe(true);

      await expect(
        rest.saveMemory("sprint-checkpoint", { body_markdown: "Token ac_super_secret_agent_token_1234" }),
      ).rejects.toThrow("Memory must not contain API keys, tokens, or private keys");
      await expect(rest.deleteMemory("sprint-checkpoint", { if_match_version: 0 })).rejects.toThrow(
        "Memory delete if_match_version must be an integer >= 1",
      );
      await expect(rest.cloudAgentLeaveChannel("codex-cloud-01", "welcome")).rejects.toThrow(
        "Default channel welcome cannot be removed",
      );
      await expect(rest.cloudAgentJoinChannel("codex-cloud-01", "dm-abc123")).rejects.toThrow(
        "Invalid group channel ID",
      );
      await expect(
        rest.wakeCloudAgent("codex-cloud-01", { prompt: "Leak sk-proj-SECRETTOKENVALUE123456" }),
      ).rejects.toThrow("Wake prompt must not contain credentials");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("AgentChatREST supports owner-scoped Cloud Agent inventory, tuning, working memory CAS, and recovery", async () => {
    const originalFetch = globalThis.fetch;
    const seen: Array<{ method: string; url: string; headers: Record<string, string>; body: any }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      seen.push({ method, url, headers, body });

      if (url.includes("/api/cloud-agents?") && method === "GET") {
        return Response.json({
          agents: [
            {
              agent_id: "codex-cloud-01",
              display_name: "Codex Staff",
              is_host: false,
              status: "active",
              memory_summary: { note_count: 2, total_bytes: 1420, updated_at: "2026-11-14T03:00:00Z" },
              loop_summary: { active_count: 1, paused_count: 0, total_count: 1, okr_wake_count: 1 },
            },
          ],
          sandbox_enabled: true,
          sandbox_subscription_runtimes: ["codex", "claude", "gemini"],
        });
      }
      if (url.endsWith("/api/cloud-agents/codex-cloud-01") && method === "PATCH") {
        return Response.json({
          ok: true,
          agent: {
            agent_id: "codex-cloud-01",
            display_name: body?.display_name,
            capabilities: body?.capabilities,
            effort: body?.effort,
            updated_at: "2026-11-14T03:05:00Z",
          },
        });
      }
      if (url.endsWith("/api/cloud-agents/codex-cloud-01/memory") && method === "GET") {
        return Response.json({
          agent_id: "codex-cloud-01",
          memories: [
            {
              name: "runbook",
              description: "Incident runbook",
              version: 4,
              bytes: 128,
              updated_at: "2026-11-14T03:01:00Z",
            },
          ],
          max_docs: 20,
          max_body_bytes: 256000,
        });
      }
      if (url.endsWith("/api/cloud-agents/codex-cloud-01/memory/runbook") && method === "GET") {
        return Response.json({
          agent_id: "codex-cloud-01",
          memory: {
            name: "runbook",
            description: "Incident runbook",
            version: 4,
            bytes: 128,
            updated_at: "2026-11-14T03:01:00Z",
            body_markdown: "# Runbook\n- Verify cross-pod parity",
          },
        });
      }
      if (url.endsWith("/api/cloud-agents/codex-cloud-01/memory/runbook/revisions") && method === "GET") {
        return Response.json({
          name: "runbook",
          revisions: [
            {
              version: 3,
              description: "Prior runbook",
              bytes: 96,
              body_markdown: "# Runbook\n- Draft",
              updated_at: "2026-11-14T02:30:00Z",
            },
          ],
        });
      }
      if (url.endsWith("/api/cloud-agents/codex-cloud-01/memory/runbook") && method === "PUT") {
        expect(headers["if-match"]).toBe('"4"');
        expect(Object.keys(body).sort()).toEqual(["body_markdown", "description", "if_match_version"]);
        return Response.json({
          ok: true,
          agent_id: "codex-cloud-01",
          created: false,
          memory: {
            name: "runbook",
            description: body.description,
            version: 5,
            bytes: 140,
            updated_at: "2026-11-14T03:06:00Z",
            body_markdown: body.body_markdown,
          },
        });
      }
      if (url.includes("/api/cloud-agents/codex-cloud-01/memory/runbook?") && method === "DELETE") {
        expect(headers["if-match"]).toBe('"5"');
        return Response.json({
          ok: true,
          agent_id: "codex-cloud-01",
          name: "runbook",
          deleted: true,
        });
      }
      if (url.endsWith("/api/cloud-agents/codex-cloud-01/recover") && method === "POST") {
        return Response.json({ ok: true, recovered: true, container_id: "sbx-01" });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "owner-jwt-01" });

      const fleet = await rest.listCloudAgents({
        host_environment_id: "env-prod-01",
        parent_agent_id: "host-01",
      });
      expect(fleet.agents[0]?.memory_summary?.note_count).toBe(2);
      expect(seen[0]?.url).toContain("host_environment_id=env-prod-01");
      expect(seen[0]?.url).toContain("parent_agent_id=host-01");
      expect(seen[0]?.headers["cache-control"]).toBe("no-store");

      const tuned = await rest.tuneCloudAgent("codex-cloud-01", {
        display_name: "Codex Staff v2",
        capabilities: ["typescript", "security-audit"],
        effort: "high",
        if_match_updated_at: "2026-11-14T03:00:00Z",
      });
      expect(tuned.agent.display_name).toBe("Codex Staff v2");
      expect(seen[1]?.headers["if-match"]).toBe("2026-11-14T03:00:00Z");

      const memList = await rest.listCloudAgentMemories("codex-cloud-01");
      expect(memList.max_docs).toBe(20);
      expect(memList.memories[0]?.name).toBe("runbook");

      const memDetail = await rest.getCloudAgentMemory("codex-cloud-01", "runbook");
      expect(memDetail.memory.body_markdown).toContain("cross-pod parity");

      const memRevs = await rest.getCloudAgentMemoryRevisions("codex-cloud-01", "runbook");
      expect(memRevs.revisions[0]?.version).toBe(3);

      const memSaved = await rest.saveCloudAgentMemory("codex-cloud-01", "runbook", {
        body_markdown: "# Runbook\n- Verify cross-pod parity + SSE suppression",
        description: "Updated incident runbook",
        if_match_version: 4,
      });
      expect(memSaved.memory.version).toBe(5);

      const memDeleted = await rest.deleteCloudAgentMemory("codex-cloud-01", "runbook", {
        if_match_version: 5,
      });
      expect(memDeleted.deleted).toBe(true);

      const recovered = await rest.recoverCloudAgent("codex-cloud-01");
      expect(recovered.ok).toBe(true);
      expect(seen[seen.length - 1]?.body).toEqual({});

      await expect(rest.listCloudAgentMemories("ac_live_secret_token_value")).rejects.toThrow(
        "Invalid cloud agent ID",
      );
      await expect(
        rest.saveCloudAgentMemory("codex-cloud-01", "../escape", { body_markdown: "nope" }),
      ).rejects.toThrow("Invalid memory name");
      await expect(
        rest.saveCloudAgentMemory("codex-cloud-01", "runbook", {
          body_markdown: "Leak ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
        }),
      ).rejects.toThrow("Memory must not contain API keys, tokens, or private keys");
      await expect(
        rest.deleteCloudAgentMemory("codex-cloud-01", "runbook", { if_match_version: 0 }),
      ).rejects.toThrow("Memory delete if_match_version must be an integer >= 1");
      await expect(
        rest.tuneCloudAgent("codex-cloud-01", { capabilities: ["ac_live_secret_token_1234"] }),
      ).rejects.toThrow("Capability tag must not contain credentials");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("3-layer WorkspaceGraph parent_id/contains contract plus getMe, listMyIdentities, listOwnedAgents, and optional-agent myChannels work end-to-end", async () => {
    const originalFetch = globalThis.fetch;
    const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
      seen.push({ url, method, headers });

      if (url.endsWith("/api/workspace/graph?scope=agent&id=codex-cloud-01")) {
        return Response.json({
          scope: { type: "agent", id: "codex-cloud-01" },
          nodes: [
            { type: "objective", id: "obj_root", title: "Q4 Reliability", status: "active" },
            { type: "objective", id: "obj_child", title: "Sprint 27", status: "active", parent_id: "obj_root" },
            { type: "task", id: "task_leaf", title: "Ship graph hierarchy", owner: "codex-cloud-01", ready: true },
          ],
          edges: [
            { from: ["objective", "obj_root"], to: ["objective", "obj_child"], type: "contains" },
            { from: ["objective", "obj_child"], to: ["task", "task_leaf"], type: "contains" },
          ],
          sections: [{ id: "okr", title: "OKR", summary: { active_objectives: 2, active_tasks: 1, ready_tasks: 1 } }],
          as_of: "2026-11-14T03:30:00.000Z",
          note: "3-layer hierarchy",
        });
      }
      if (url.endsWith("/api/channels/mine")) {
        return Response.json({
          channels: [
            { id: "room-dev", name: "AgentChatDev", type: "group", role: "admin", member_count: 6 },
            { id: "dm-123", type: "direct", peer_id: "codex-cloud-01", peer_name: "Codex Staff" },
          ],
        });
      }
      if (url.endsWith("/api/channels/mine?agent_id=codex-cloud-01")) {
        return Response.json({
          channels: [{ id: "room-dev", name: "AgentChatDev", type: "group", role: "member", member_count: 6 }],
        });
      }
      if (url.endsWith("/api/account/me")) {
        return Response.json({
          id: "owner@example.com",
          name: "Owner",
          type: "human",
          privateMode: false,
          agents: [{ id: "codex-cloud-01", name: "Codex Staff", type: "agent", claimedAt: "2026-11-01T00:00:00Z" }],
        });
      }
      if (url.endsWith("/api/account/me/identities")) {
        return Response.json({
          identities: [
            { id: "owner@example.com", name: "Owner", type: "human", avatar_url: null, is_self: true },
            {
              id: "codex-cloud-01",
              name: "Codex Staff",
              type: "agent",
              avatar_url: null,
              is_self: false,
              online: true,
              in_welcome: true,
              claimed_at: "2026-11-01T00:00:00Z",
            },
          ],
        });
      }
      if (url.endsWith("/api/account/owner%40example.com/agents")) {
        return Response.json({
          agents: [{ agentId: "codex-cloud-01", ownerId: "owner@example.com", claimedAt: "2026-11-01T00:00:00Z" }],
        });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "owner-jwt-27" });

      const graph = await rest.getWorkspaceGraph("agent", "codex-cloud-01");
      expect(graph.nodes.find((n) => n.id === "obj_child")?.parent_id).toBe("obj_root");
      expect(graph.edges[0]).toEqual({
        from: ["objective", "obj_root"],
        to: ["objective", "obj_child"],
        type: "contains",
      });
      expect(graph.note).toBe("3-layer hierarchy");

      const selfRooms = await rest.myChannels();
      expect(selfRooms).toHaveLength(2);
      expect(selfRooms[1]?.peer_name).toBe("Codex Staff");
      expect(seen[1]?.headers["authorization"]).toBe("Bearer owner-jwt-27");
      expect(seen[1]?.headers["cache-control"]).toBe("no-store");

      const childRooms = await rest.myChannels("codex-cloud-01");
      expect(childRooms).toHaveLength(1);
      expect(childRooms[0]?.id).toBe("room-dev");

      const me = await rest.getMe();
      expect(me.agents?.[0]?.id).toBe("codex-cloud-01");

      const identities = await rest.listMyIdentities();
      expect(identities.identities).toHaveLength(2);
      expect(identities.identities[1]?.online).toBe(true);

      const owned = await rest.listOwnedAgents("owner@example.com");
      expect(owned.agents[0]?.agentId).toBe("codex-cloud-01");

      await expect(rest.myChannels("ac_live_secret_token_value")).rejects.toThrow("Invalid agent ID");
      await expect(rest.myChannels("../escape")).rejects.toThrow("Invalid agent ID");
      await expect(rest.listOwnedAgents("sk-live-secret-token")).rejects.toThrow("Invalid owner ID");
      await expect(rest.listOwnedAgents("../escape")).rejects.toThrow("Invalid owner ID");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Owner Cloud Agent loop lifecycle, getMyEntitlements, and kickChannelMember enforce strict input/secret guards", async () => {
    const originalFetch = globalThis.fetch;
    const seen: Array<{ url: string; method: string; headers: Record<string, string>; body?: any }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ url, method, headers, body });

      if (url.endsWith("/api/cloud-agents/codex-cloud-01/loops") && method === "GET") {
        return Response.json({
          loops: [
            {
              loop_id: "loop_abc12345",
              agent_id: "codex-cloud-01",
              channel_id: "room-dev",
              channel_name: "AgentChatDev",
              prompt: "okr:obj_mwfdxgql",
              interval_ms: 300000,
              next_tick_ms: 1763092000000,
              last_tick_at: null,
              created_at: 1763091700000,
              expires_at: null,
              status: "active",
              mode: "okr_wake",
              objective_id: "obj_mwfdxgql",
            },
          ],
          total: 1,
        });
      }
      if (url.endsWith("/api/cloud-agents/codex-cloud-01/loops/objectives?channel_id=room-dev") && method === "GET") {
        return Response.json({
          ok: true,
          agent_id: "codex-cloud-01",
          channel_id: "room-dev",
          channel_name: "AgentChatDev",
          objectives: [
            {
              objective_id: "obj_mwfdxgql",
              title: "Sprint 28",
              status: "active",
              horizon: "week",
              owner_handle: "spinning-midnight-tunicate",
              updated_at: "2026-11-14T03:44:00Z",
              total_tasks: 3,
              open_tasks: 2,
              assigned_open_tasks: 1,
              ready_assigned_tasks: 1,
            },
          ],
        });
      }
      if (url.endsWith("/api/cloud-agents/codex-cloud-01/loops") && method === "POST") {
        return Response.json({
          ok: true,
          loop: {
            loop_id: "loop_watch999",
            agent_id: "codex-cloud-01",
            channel_id: body.channel_id,
            channel_name: "AgentChatDev",
            prompt: "okr-watch:obj_mwfdxgql",
            interval_ms: 900000,
            next_tick_ms: 1763092600000,
            last_tick_at: null,
            created_at: 1763091700000,
            expires_at: null,
            status: "active",
            mode: body.mode,
            objective_id: body.objective_id,
            stall_minutes: body.stall_minutes,
          },
        });
      }
      if (url.endsWith("/api/cloud-agents/codex-cloud-01/loops/loop_watch999/pause") && method === "POST") {
        return Response.json({ ok: true, loop_id: "loop_watch999", agent_id: "codex-cloud-01", status: "paused" });
      }
      if (url.endsWith("/api/cloud-agents/codex-cloud-01/loops/loop_watch999/resume") && method === "POST") {
        return Response.json({
          ok: true,
          loop_id: "loop_watch999",
          agent_id: "codex-cloud-01",
          status: "active",
          next_tick_ms: 1763093000000,
        });
      }
      if (url.endsWith("/api/cloud-agents/codex-cloud-01/loops/loop_watch999/interval") && method === "POST") {
        return Response.json({
          ok: true,
          loop_id: "loop_watch999",
          agent_id: "codex-cloud-01",
          interval_ms: 1800000,
          next_tick_ms: 1763093500000,
        });
      }
      if (url.endsWith("/api/cloud-agents/codex-cloud-01/loops/loop_watch999") && method === "DELETE") {
        return Response.json({ ok: true, stopped: "loop_watch999", agent_id: "codex-cloud-01" });
      }
      if (url.endsWith("/api/me/entitlements") && method === "GET") {
        return Response.json({
          tier: "vip",
          key_scope: "full",
          owner_account_id: "user:sw***",
          lifetime_number: null,
          entitlements: {
            loops: { vip_gated: false, allowed: true, trial_days_left: null, per_agent_cap: 5, active: 2 },
            owned_agents: { cap: 20, used: 4 },
            public_channels_owned: { cap: null, used: 1 },
          },
        });
      }
      if (url.endsWith("/api/channels/room-dev/kick") && method === "POST") {
        return Response.json({ ok: true, kicked_ref: body.target_ref ?? body.agent_id });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "owner-jwt-28" });

      const list = await rest.listCloudAgentLoops("codex-cloud-01");
      expect(list.loops[0]?.loop_id).toBe("loop_abc12345");
      expect(seen[0]?.headers["cache-control"]).toBe("no-store");

      const objs = await rest.listCloudAgentLoopObjectives("codex-cloud-01", "room-dev");
      expect(objs.objectives[0]?.ready_assigned_tasks).toBe(1);

      const created = await rest.createCloudAgentLoop("codex-cloud-01", {
        channel_id: "room-dev",
        mode: "okr_watch",
        interval: "15m",
        objective_id: "obj_mwfdxgql",
        watch_idle: true,
        stall_minutes: 30,
      });
      expect(created.loop.loop_id).toBe("loop_watch999");

      const paused = await rest.pauseCloudAgentLoop("codex-cloud-01", "loop_watch999");
      expect(paused.status).toBe("paused");

      const resumed = await rest.resumeCloudAgentLoop("codex-cloud-01", "loop_watch999");
      expect(resumed.status).toBe("active");

      const retuned = await rest.setCloudAgentLoopInterval("codex-cloud-01", "loop_watch999", { interval: "30m" });
      expect(retuned.interval_ms).toBe(1800000);

      const stopped = await rest.stopCloudAgentLoop("codex-cloud-01", "loop_watch999");
      expect(stopped.stopped).toBe("loop_watch999");

      const ent = await rest.getMyEntitlements();
      expect(ent.tier).toBe("vip");
      expect(ent.entitlements.loops.allowed).toBe(true);

      const kicked = await rest.kickChannelMember("room-dev", { target_ref: "mr_hmac_ref_01" });
      expect(kicked.kicked_ref).toBe("mr_hmac_ref_01");

      await expect(
        rest.createCloudAgentLoop("codex-cloud-01", {
          channel_id: "arena-duel-1",
          interval: "5m",
          prompt: "hello",
        }),
      ).rejects.toThrow("Invalid channel ID");
      await expect(
        rest.createCloudAgentLoop("codex-cloud-01", {
          channel_id: "room-dev",
          interval: "5m",
          prompt: "Leak sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
        }),
      ).rejects.toThrow("Loop prompt must not contain API keys, tokens, or private keys");
      await expect(rest.pauseCloudAgentLoop("codex-cloud-01", "bad_id")).rejects.toThrow("Invalid cloud loop ID");
      await expect(
        rest.kickChannelMember("room-dev", { target_ref: "mr_1", agent_id: "bot_1" } as any),
      ).rejects.toThrow("Provide exactly one of target_ref or agent_id");
      await expect(rest.kickChannelMember("room-dev", { agent_id: "ac_live_secret_token_value" })).rejects.toThrow(
        "Invalid agent ID",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("getMyLoops(?agent_id/include_owned), createOkrWatchLoop, delegated createLoop(agent_id), and getChannelOkrSnapshot loop_summary work end-to-end", async () => {
    const originalFetch = globalThis.fetch;
    const seen: Array<{ url: string; method: string; headers: Record<string, string>; body?: any }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ url, method, headers, body });

      if (url.includes("/api/loops/mine")) {
        return Response.json({
          loops: [
            {
              loop_id: "loop_owned_1",
              agent_id: "codex-cloud-01",
              channel_id: "room-dev",
              prompt: "okr:obj_29",
              interval_ms: 300_000,
              next_tick_ms: 1700000300000,
              last_tick_at: null,
              created_at: 1700000000000,
              status: "active",
              mode: "okr_wake",
              objective_id: "obj_29",
            },
          ],
          total: 1,
        });
      }
      if (url.endsWith("/api/loops/okr-watch") && method === "POST") {
        return Response.json({
          ok: true,
          deduplicated: true,
          loop_id: "loop_watch_29",
          mode: "okr_watch",
          objective_id: body.objective_id,
          watch_idle: Boolean(body.watch_idle),
          watch_supply: Boolean(body.watch_supply),
          stall_minutes: body.stall_minutes ?? 30,
        });
      }
      if (url.endsWith("/api/loops") && method === "POST") {
        return Response.json({
          ok: true,
          deduplicated: false,
          loop_id: "loop_wake_29",
          mode: body.mode,
          objective_id: body.objective_id,
        });
      }
      if (url.includes("/api/channels/room-dev/okr_snapshot")) {
        return Response.json({
          channel_id: "room-dev",
          objectives: [],
          krs: [],
          tasks: [],
          include_archived: true,
          loop_summary: {
            active_loop_count: 2,
            my_active_loop_count: 1,
            okr_wake_objective_ids: ["obj_29"],
            okr_watch_objective_ids: ["obj_29"],
            unarmed_objective_ids: [],
          },
        });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "owner-jwt-29" });

      const mine = await rest.getMyLoops({ agent_id: "codex-cloud-01", include_owned: true });
      expect(mine.total).toBe(1);
      expect(mine.loops[0]?.agent_id).toBe("codex-cloud-01");
      expect(seen[0]?.url).toContain("/api/loops/mine?agent_id=codex-cloud-01&include_owned=1");
      expect(seen[0]?.headers["cache-control"]).toBe("no-store");

      const watchRes = await rest.createOkrWatchLoop({
        channel_id: "room-dev",
        objective_id: "obj_29",
        agent_id: "codex-cloud-01",
        interval_ms: 300_000,
        watch_idle: true,
        watch_supply: false,
        stall_minutes: 25,
      });
      expect(watchRes.deduplicated).toBe(true);
      expect(watchRes.loop_id).toBe("loop_watch_29");
      expect(seen[1]?.body).toEqual({
        channel_id: "room-dev",
        objective_id: "obj_29",
        agent_id: "codex-cloud-01",
        interval_ms: 300_000,
        watch_idle: true,
        watch_supply: false,
        stall_minutes: 25,
      });

      const delegatedWake = await rest.createLoop({
        channel_id: "room-dev",
        agent_id: "codex-cloud-01",
        mode: "okr_wake",
        interval: "5m",
        objective_id: "obj_29",
      });
      expect(delegatedWake.loop_id).toBe("loop_wake_29");
      expect(seen[2]?.body.agent_id).toBe("codex-cloud-01");

      const snap = await rest.getChannelOkrSnapshot("room-dev", { include_archived: true });
      expect(snap.loop_summary?.active_loop_count).toBe(2);
      expect(seen[3]?.headers["cache-control"]).toBe("no-store");

      await expect(rest.getMyLoops({ agent_id: "ac_live_secret" })).rejects.toThrow("Invalid agent ID");
      await expect(
        rest.createOkrWatchLoop({ channel_id: "arena-1", objective_id: "obj_29" }),
      ).rejects.toThrow("Invalid channel ID");
      await expect(
        rest.createOkrWatchLoop({ channel_id: "room-dev", objective_id: "bad" }),
      ).rejects.toThrow("Invalid objective ID");
      await expect(
        rest.createOkrWatchLoop({ channel_id: "room-dev", objective_id: "obj_29", stall_minutes: 2 }),
      ).rejects.toThrow("Invalid loop stall_minutes");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("REST complete OKR DAG blockers/blocks, task comments list, progress ping, openOkrThread, setOkrLinks, and transferObjective enforce strict validation and no-store", async () => {
    const seen: Array<{ url: string; method: string; headers: Record<string, string>; body?: any }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
      }
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      seen.push({ url, method, headers, body });

      if (url.endsWith("/api/okr/tasks/task_30/blockers") && method === "GET") {
        return Response.json({ ok: true, task_id: "task_30", blockers: ["task_29a", "task_29b"] });
      }
      if (url.endsWith("/api/okr/tasks/task_30/blocks") && method === "GET") {
        return Response.json({ ok: true, task_id: "task_30", blocks: ["task_31"] });
      }
      if (url.endsWith("/api/okr/tasks/task_30/comments?limit=20") && method === "GET") {
        return Response.json({
          ok: true,
          task_id: "task_30",
          objective_id: "obj_30",
          comment_count: 1,
          truncated: false,
          comments: [{ id: "c_1", author: "spinning-midnight-tunicate", kind: "spec", text: "[SPEC] Ship it", at: "2026-11-13T20:30:00Z" }],
        });
      }
      if (url.endsWith("/api/okr/tasks/task_30/progress") && method === "POST") {
        return Response.json({ ok: true, task_id: "task_30", last_progress_at: "2026-11-13T20:31:00Z", commented: Boolean(body?.note) });
      }
      if (url.endsWith("/api/okr/threads") && method === "POST") {
        return Response.json({ ok: true, channel_id: "okr-obj_30", already_existed: false, seeded_members: ["spinning-midnight-tunicate"] }, { status: 201 });
      }
      if (url.endsWith("/api/okr/links/objective/obj_30") && method === "PATCH") {
        return Response.json({
          ok: true,
          objective: {
            id: "obj_30",
            title: "Campaign 30",
            owner: "spinning-midnight-tunicate",
            horizon: "week",
            status: "active",
            discussion_channel_id: body.discussion_channel_id,
            narrative: body.narrative,
          },
        });
      }
      if (url.endsWith("/api/okr/objectives/obj_30/transfer") && method === "POST") {
        return Response.json({
          ok: true,
          objective: {
            id: "obj_30",
            title: "Campaign 30",
            owner: body.new_owner,
            horizon: "week",
            status: "active",
          },
        });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "owner-jwt-30" });

      const blockers = await rest.getTaskBlockers("task_30");
      expect(blockers.blockers).toEqual(["task_29a", "task_29b"]);
      expect(seen[0]?.headers["cache-control"]).toBe("no-store");

      const blocks = await rest.getTaskBlocks("task_30");
      expect(blocks.blocks).toEqual(["task_31"]);

      const comments = await rest.listTaskComments("task_30", { limit: 20 });
      expect(comments.comments[0]?.kind).toBe("spec");

      const prog = await rest.logTaskProgress("task_30", { note: "Halfway green", wake_id: "wake_1" });
      expect(prog.commented).toBe(true);
      expect(seen[3]?.body).toEqual({ note: "Halfway green", wake_id: "wake_1" });

      const thread = await rest.openOkrThread({ target_type: "objective", target_id: "obj_30" });
      expect(thread.channel_id).toBe("okr-obj_30");

      const linked = await rest.setOkrLinks("objective", "obj_30", {
        discussion_channel_id: "room-dev",
        narrative: "Unified working-memory supervision",
        linked_docs: ["docs/ARCH.md"],
        linked_channel_docs: [{ channel_id: "room-dev", doc_id: "spec-30" }],
        if_match_updated_at: "2026-11-13T20:25:59.845Z",
      });
      expect(linked.objective?.discussion_channel_id).toBe("room-dev");

      const transferred = await rest.transferObjective("obj_30", { new_owner: "codex-staff-engineer-ca7590" });
      expect(transferred.objective.owner).toBe("codex-staff-engineer-ca7590");

      // Strict client-side guards
      await expect(rest.logTaskProgress("task_30", { note: "Leak ac_live_secret_token_123456" })).rejects.toThrow("secrets");
      await expect(rest.addTaskComment("task_30", "Leak sk-proj-1234567890abcdef")).rejects.toThrow("secrets");
      await expect(rest.setOkrLinks("task", "task_30", { narrative: "Wrong target" })).rejects.toThrow("only supported on objective");
      await expect(rest.setOkrLinks("objective", "obj_30", { discussion_channel_id: "dm-secret" })).rejects.toThrow("direct message");
      await expect(rest.transferObjective("obj_30", { new_owner: "ac_live_secret_token_123456" })).rejects.toThrow("Invalid new_owner");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("REST myChannels(include_owned), getChannelCollaborationRoster, createStoryArtifact, and hardened webhook SSRF/secret guards work end-to-end", async () => {
    const seen: Array<{ url: string; method: string; headers: Record<string, string>; body?: any }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
      }
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      seen.push({ url, method, headers, body });

      if (url.endsWith("/api/channels/mine?include_owned=1") && method === "GET") {
        return Response.json({
          channels: [
            {
              id: "room-priv-31",
              name: "Private Bot Sprint",
              type: "group",
              visibility: "private",
              delegated_via_agent_id: "codex-cloud-01",
              delegated_read_only: true,
            },
          ],
        });
      }
      if (url.endsWith("/api/channels/room-priv-31/members?view=collaboration&limit=25") && method === "GET") {
        return Response.json({
          members: [
            {
              agent_id: "codex-cloud-01",
              member_ref: "mr_" + "a".repeat(64),
              type: "agent",
              display_name: "Codex Cloud",
              role: "member",
              online: true,
              capabilities: ["typescript", "security-audit"],
              is_self: false,
              can_mention: true,
              can_kick: true,
              can_set_coordinator: true,
              ownership_scope: "owned",
              cloud_health: {
                runtime_type: "codex",
                status: "active",
                auth_mode: "subscription",
                subscription_pending: false,
                last_wake_status: "ok",
                last_duration_ms: 4200,
                last_wake_at: "2026-11-13T20:45:00Z",
              },
            },
          ],
          viewer: { role: "admin", is_member: true, can_kick: true, can_set_coordinator: true },
          coordinator_ref: "mr_" + "a".repeat(64),
          source: "collaboration",
        });
      }
      if (url.endsWith("/api/stories/artifact") && method === "POST") {
        return Response.json({
          artifact_id: "story_abc12345",
          cover_png_url: null,
          full_story_png_url: null,
          story_json: {
            id: "story_abc12345",
            channel: { id: body.channel_id, name: "AgentChatDev" },
            source_message_ids: body.message_ids,
            story_type: body.story_type,
            title: body.title,
            summary: body.summary,
            outcome: body.outcome,
            cast: [{ id: "codex-cloud-01", name: "Codex", role: "Auditor" }],
            turns: [],
            created_by_agent_id: "spinning-midnight-tunicate",
            created_by_account_id: "human:a1b2c3d4",
            created_at: "2026-11-13T20:48:00Z",
            qr_target: body.qr_target ?? "https://agents-chat.com/lobby?blueprint=cross-review",
            watermark: "Powered by AgentsChat · agents-chat.com/lobby?blueprint=cross-review",
          },
          blueprint_id: "cross-review",
          blueprint_url: "https://agents-chat.com/lobby?blueprint=cross-review",
          suggested_captions: { x: "Shipped!", threads: "Shipped!", wechat: "Shipped!", tiktok_hook: "Shipped!" },
          caption_blocked: { x: false, threads: false, wechat: false, tiktok_hook: false },
          rendering_status: "pending",
        });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "owner-jwt-31" });

      const ownedChs = await rest.myChannels({ include_owned: true });
      expect(ownedChs[0]?.delegated_via_agent_id).toBe("codex-cloud-01");
      expect(ownedChs[0]?.delegated_read_only).toBe(true);
      expect(seen[0]?.headers["cache-control"]).toBe("no-store");

      const roster = await rest.getChannelCollaborationRoster("room-priv-31", { limit: 25 });
      expect(roster.source).toBe("collaboration");
      expect(roster.members[0]?.cloud_health?.last_wake_status).toBe("ok");
      expect(seen[1]?.headers["cache-control"]).toBe("no-store");

      const story = await rest.createStoryArtifact({
        channel_id: "room-dev",
        message_ids: ["msg-1", "msg-2", "msg-1", "msg-3"],
        story_type: "debug_war_room",
        title: "Zero-leak cross-pod convergence",
        summary: "Four agents fixed cross-pod SSE revocation in 6 minutes.",
        outcome: "All 191 tests green.",
        qr_target: "https://agents-chat.com/lobby?blueprint=cross-review",
      });
      expect(story.artifact_id).toBe("story_abc12345");
      expect(seen[2]?.body.message_ids).toEqual(["msg-1", "msg-2", "msg-3"]);

      // Validation & SSRF/secret guards
      await expect(
        rest.createStoryArtifact({ channel_id: "dm-secret", message_ids: ["m1", "m2", "m3"], story_type: "build_log" }),
      ).rejects.toThrow("direct message");
      await expect(
        rest.createStoryArtifact({ channel_id: "room-dev", message_ids: ["m1", "m2"], story_type: "build_log" }),
      ).rejects.toThrow("between 3 and 8");
      await expect(
        rest.createStoryArtifact({
          channel_id: "room-dev",
          message_ids: ["m1", "m2", "m3"],
          story_type: "build_log",
          title: "Leak ac_live_secret_token_123456",
        }),
      ).rejects.toThrow("secrets");
      await expect(rest.registerWebhook("room-dev", "http://[fd00::1]:8080/hook")).rejects.toThrow("Webhook host not allowed");
      await expect(rest.registerWebhook("room-dev", "http://[fe80::1]/hook")).rejects.toThrow("Webhook host not allowed");
      await expect(rest.registerWebhook("room-dev", "http://100.64.0.5/hook")).rejects.toThrow("Webhook host not allowed");
      await expect(rest.registerWebhook("room-dev", "http://[::ffff:127.0.0.1]/hook")).rejects.toThrow("Webhook host not allowed");
      await expect(
        rest.registerWebhook("room-dev", "https://hooks.example.com/cb?token=ac_live_secret_123456"),
      ).rejects.toThrow("secrets");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("discover, getOnlineAgents, discoverChannels attach Bearer + no-store, and Cloud Catalog/Models/ProbeModels enforce HTTPS SSRF guards", async () => {
    const originalFetch = globalThis.fetch;
    const seen: Array<{ url: string; method: string; headers: Record<string, string>; body?: any }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ url, method, headers, body });

      if (!headers.authorization) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      if (url.includes("/api/agents?")) {
        return Response.json({
          agents: [
            { agent_id: "codex-1", display_name: "Codex", capabilities: ["swift", "typescript"], reputation: 100, status: "online" },
          ],
        });
      }
      if (url.includes("/api/discover?")) {
        return Response.json({
          agents: [
            { agent_id: "codex-1", display_name: "Codex", capabilities: ["swift", "typescript"], reputation: 100, status: "online" },
          ],
        });
      }
      if (url.includes("/api/channels/discover?")) {
        return Response.json({
          channels: [{ id: "ch_swift", name: "Swift Guild", type: "group", visibility: "public", member_count: 12 }],
        });
      }
      if (url.endsWith("/api/cloud-agents/catalog")) {
        return Response.json({
          ok: true,
          catalog: { harnesses: [{ id: "codex", name: "Codex", badge: "CLI", icon: "terminal", description: "Codex", config_files: [], default_model: "deepseek-flash", default_provider: "managed-deepseek" }], efforts: [], managed_models: [], providers: [] },
          sandbox_enabled: true,
          sandbox_subscription_runtimes: ["codex", "claude", "agy"],
          models_dev: { source: "models.dev", url: "https://models.dev/api.json", synced_at: "2026-11-14T00:00:00Z", total_models: 42, providers: [], subscription_cli_models: { codex: [], claude: [], agy: [] } },
        });
      }
      if (url.endsWith("/api/cloud-agents/models")) {
        return Response.json({
          ok: true,
          source: "models.dev",
          url: "https://models.dev/api.json",
          synced_at: "2026-11-14T00:00:00Z",
          total_models: 42,
          providers: [],
          subscription_cli_models: { codex: [{ id: "gpt-5.4", name: "GPT-5.4", kind: "model" }], claude: [], agy: [] },
        });
      }
      if (url.endsWith("/api/cloud-agents/probe-models") && method === "POST") {
        return Response.json({
          ok: true,
          count: 2,
          models: [
            { id: "glm-5.3", name: "GLM-5.3" },
            { id: "deepseek-v4", name: "DeepSeek V4" },
          ],
        });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      // Client without constructor bearerToken — verifies per-call bearerToken override works on all 6 endpoints!
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com" });

      const online = await rest.getOnlineAgents({ status: "online", limit: 25, offset: 0, bearerToken: "tok_override_32" });
      expect(online[0]?.agent_id).toBe("codex-1");
      expect(seen[0]?.url).toBe("https://agents-chat.com/api/agents?status=online&limit=25&offset=0");
      expect(seen[0]?.headers.authorization).toBe("Bearer tok_override_32");
      expect(seen[0]?.headers["cache-control"]).toBe("no-store");

      const discovered = await rest.discover(["swift", "typescript"], 15, {
        q: "codex",
        online_only: true,
        bearerToken: "tok_override_32",
      });
      expect(discovered[0]?.agent_id).toBe("codex-1");
      expect(seen[1]?.url).toContain("capabilities=swift%2Ctypescript");
      expect(seen[1]?.url).toContain("q=codex");
      expect(seen[1]?.url).toContain("online_only=1");
      expect(seen[1]?.headers["cache-control"]).toBe("no-store");

      const pubRooms = await rest.discoverChannels("swift", 10, {
        agent_id: "codex-1",
        bearerToken: "tok_override_32",
      });
      expect(pubRooms[0]?.id).toBe("ch_swift");
      expect(seen[2]?.url).toBe("https://agents-chat.com/api/channels/discover?q=swift&limit=10&agent_id=codex-1");
      expect(seen[2]?.headers["cache-control"]).toBe("no-store");

      const catalog = await rest.getCloudAgentCatalog({ bearerToken: "tok_override_32" });
      expect(catalog.sandbox_subscription_runtimes).toContain("codex");
      expect(seen[3]?.headers["cache-control"]).toBe("no-store");

      const models = await rest.getCloudAgentModels({ bearerToken: "tok_override_32" });
      expect(models.subscription_cli_models.codex[0]?.id).toBe("gpt-5.4");
      expect(seen[4]?.headers["cache-control"]).toBe("no-store");

      const probed = await rest.probeCloudEndpointModels(
        { base_url: "https://open.bigmodel.cn/api/anthropic", agent_id: "codex-1" },
        { bearerToken: "tok_override_32" },
      );
      expect(probed.count).toBe(2);
      expect(seen[5]?.headers["cache-control"]).toBe("no-store");

      const callCountBeforeGuards = seen.length;
      await expect(rest.probeCloudEndpointModels({ base_url: "http://api.openai.com/v1" })).rejects.toThrow("HTTPS");
      await expect(rest.probeCloudEndpointModels({ base_url: "https://127.0.0.1/v1" })).rejects.toThrow("Private");
      await expect(rest.probeCloudEndpointModels({ base_url: "https://[fd00::1]/v1" })).rejects.toThrow("Private");
      await expect(rest.probeCloudEndpointModels({ base_url: "https://[::ffff:10.0.0.5]/v1" })).rejects.toThrow("Private");
      await expect(rest.probeCloudEndpointModels({ base_url: "https://api.example.com/v1?key=abc" })).rejects.toThrow("query");
      await expect(rest.discoverChannels("ok", 10, { agent_id: "ac_live_secret_token_123456" })).rejects.toThrow("Invalid agent ID");
      expect(seen.length).toBe(callCountBeforeGuards);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("search(include_owned), getMessages, sendMessage attach Bearer + no-store, and Arena lifecycle contracts enforce strict guards", async () => {
    const originalFetch = globalThis.fetch;
    const seen: Array<{ url: string; method: string; headers: Record<string, string>; body?: any }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ url, method, headers, body });

      if (!headers.authorization) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      if (url.includes("/api/search?")) {
        return Response.json({
          messages: [{ id: "m_hit_1", channel_id: "room-war", sender_id: "codex-1", sender_type: "agent", content: "Resolved!", content_type: "text", timestamp: "2026-11-14T05:00:00Z" }],
        });
      }
      if (url.includes("/api/channels/room-war/messages") && method === "GET") {
        return Response.json({
          messages: [{ id: "m_1", channel_id: "room-war", sender_id: "codex-1", sender_type: "agent", content: "Hello", content_type: "text", timestamp: "2026-11-14T05:00:00Z" }],
        });
      }
      if (url.endsWith("/api/channels/room-war/messages") && method === "POST") {
        return Response.json({ ok: true, id: "m_sent_1" });
      }
      if (url.endsWith("/api/arenas") && method === "POST") {
        return Response.json({
          ok: true,
          arena: {
            channel_id: "arena-abc12345",
            topic: body.topic,
            opponents: body.opponents,
            rounds: body.rounds ?? 6,
            current_round: 0,
            turn: 0,
            round_deadline_ms: 1794339999000,
            state: "created",
            created_by: "user:ow***",
            created_at: "2026-11-14T05:20:00Z",
          },
        });
      }
      if (url.endsWith("/api/arenas/arena-abc12345") && method === "GET") {
        return Response.json({
          arena: {
            channel_id: "arena-abc12345",
            topic: "Monolith vs Microservices",
            opponents: ["codex-1", "claude-2"],
            rounds: 6,
            current_round: 1,
            turn: 1,
            round_deadline_ms: 1794339999000,
            state: "running",
            created_by: "user:ow***",
            created_at: "2026-11-14T05:20:00Z",
          },
        });
      }
      if (url.endsWith("/api/arenas/arena-abc12345/tick") && method === "POST") {
        return Response.json({
          ok: true,
          action: "tick",
          arena: {
            channel_id: "arena-abc12345",
            topic: "Monolith vs Microservices",
            opponents: ["codex-1", "claude-2"],
            rounds: 6,
            current_round: 1,
            turn: 1,
            round_deadline_ms: 1794339999000,
            state: "running",
            created_by: "user:ow***",
            created_at: "2026-11-14T05:20:00Z",
          },
        });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com" });

      const hits = await rest.search("Resolved", undefined, 20, {
        include_owned: true,
        bearerToken: "tok_33",
      });
      expect(hits[0]?.id).toBe("m_hit_1");
      expect(seen[0]?.url).toBe("https://agents-chat.com/api/search?q=Resolved&limit=20&include_owned=1");
      expect(seen[0]?.headers["cache-control"]).toBe("no-store");

      const msgs = await rest.getMessages("room-war", 30, "m_9", undefined, { bearerToken: "tok_33" });
      expect(msgs[0]?.id).toBe("m_1");
      expect(seen[1]?.headers["cache-control"]).toBe("no-store");

      const sent = await rest.sendMessage("room-war", "codex-1", "Ship it!", "agent", { bearerToken: "tok_33" });
      expect(sent.id).toBe("m_sent_1");
      expect(seen[2]?.headers["cache-control"]).toBe("no-store");

      const created = await rest.createArena({
        topic: "Monolith vs Microservices",
        opponents: ["codex-1", "claude-2"],
        rounds: 4,
        bearerToken: "tok_33",
      });
      expect(created.arena.channel_id).toBe("arena-abc12345");

      const fetched = await rest.getArena("arena-abc12345", { bearerToken: "tok_33" });
      expect(fetched.arena.state).toBe("running");

      const advanced = await rest.advanceArena("arena-abc12345", "tick", {
        idempotencyKey: "idem-round1-turn1",
        bearerToken: "tok_33",
      });
      expect(advanced.action).toBe("tick");
      expect(seen[5]?.headers["x-idempotency-key"]).toBe("idem-round1-turn1");

      const beforeGuards = seen.length;
      await expect(rest.search("sk-proj-1234567890abcdefghijklmno")).rejects.toThrow("secrets");
      await expect(rest.createArena({ topic: "Same bot", opponents: ["codex-1", "codex-1"] })).rejects.toThrow("distinct");
      await expect(rest.createArena({ topic: "Leak ac_live_secret_12345678", opponents: ["codex-1", "claude-2"] })).rejects.toThrow("secrets");
      await expect(rest.getMessages("../escape")).rejects.toThrow("Invalid channel ID");
      expect(seen.length).toBe(beforeGuards);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("AgentChatREST iterateChannelEvents yields live SSE frames with immediate mid-read AbortSignal wakeup and no-store supervision detail/join/join-request guards", async () => {
    const originalFetch = globalThis.fetch;
    const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    let readerCancelled = false;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      if (init?.headers) {
        new Headers(init.headers).forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      }
      seen.push({ url, method, headers });

      if (url.endsWith("/api/channels/room-supervised/stream")) {
        const enc = new TextEncoder();
        let step = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            step++;
            if (step === 1) {
              controller.enqueue(enc.encode(': keepalive\r\n\r\ndata: {"type":"message","id":"m1"}\r\n\r\ndata: {"type":"thread_'));
              return;
            }
            if (step === 2) {
              controller.enqueue(enc.encode('reply","id":"r1"}\n\n'));
              return;
            }
            // Step 3 intentionally hangs to prove AbortSignal wakes pending reader.read() immediately
            return new Promise<void>(() => {});
          },
          cancel() {
            readerCancelled = true;
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (url.endsWith("/api/channels/room-supervised/detail")) {
        return Response.json({
          id: "room-supervised",
          name: "Supervised War Room",
          type: "project",
          visibility: "private",
          topic: "Live supervision",
          member_count: 3,
          read_only: true,
          created_at: "2026-11-14T00:00:00Z",
        });
      }
      if (url.endsWith("/api/channels/room-supervised/join")) {
        return Response.json({ ok: true, channel_id: "room-supervised", joined: true });
      }
      if (url.endsWith("/api/channels/room-supervised/join-request")) {
        return Response.json({ ok: true, status: "pending" });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "tok_stream_34" });
      const ac = new AbortController();
      const collected: Array<Record<string, unknown>> = [];

      for await (const evt of rest.iterateChannelEvents("room-supervised", { signal: ac.signal })) {
        collected.push(evt);
        if (collected.length === 2) {
          setTimeout(() => ac.abort(), 5);
        }
      }

      expect(collected).toEqual([
        { type: "message", id: "m1" },
        { type: "thread_reply", id: "r1" },
      ]);
      expect(readerCancelled).toBe(true);
      expect(seen[0]?.headers["cache-control"]).toBe("no-store");
      expect(seen[0]?.headers.authorization).toBe("Bearer tok_stream_34");

      const detail = await rest.getChannelDetail("room-supervised");
      expect(detail.read_only).toBe(true);
      expect(seen[1]?.headers["cache-control"]).toBe("no-store");

      await rest.joinChannel("room-supervised");
      expect(seen[2]?.headers["cache-control"]).toBe("no-store");

      const reqJoin = await rest.requestChannelJoin("room-supervised", { message: "Owner joining war room" });
      expect(reqJoin.status).toBe("pending");
      expect(seen[3]?.headers["cache-control"]).toBe("no-store");

      const beforeSecret = seen.length;
      await expect(
        rest.requestChannelJoin("room-supervised", { message: "Key agent_key_secret_987654321" }),
      ).rejects.toThrow("credentials");
      await expect(
        rest.requestChannelJoin("room-supervised", { message: "PAT github_pat_1234567890abcdefghijklm" }),
      ).rejects.toThrow("credentials");
      expect(seen.length).toBe(beforeSecret);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("parseSseFrames pure parser & full OkrUpdated/TaskAssigned/OkrThreadOpened WS event contracts", async () => {
    const { parseSseFrames: parseFrames } = await import("../src/index");
    const chunk1 = parseFrames(
      ': keepalive\r\n\r\nevent: message\r\ndata: {"type":"okr_updated","kind":"kr_progress","objective_id":"obj_35","kr_id":"kr_1","current":1,"discussion_channel_id":"room-dev"}\r\n\r\ndata: {"type":"okr_updated",',
    );
    expect(chunk1.events).toEqual([
      {
        type: "okr_updated",
        kind: "kr_progress",
        objective_id: "obj_35",
        kr_id: "kr_1",
        current: 1,
        discussion_channel_id: "room-dev",
      },
    ]);
    expect(chunk1.rest).toBe('data: {"type":"okr_updated",');

    const chunk2 = parseFrames(
      `${chunk1.rest}"kind":"comment_added","objective_id":"obj_35","task_id":"task_1","author":"codex-bot"}\n\ndata: not-json\n\ndata: [1,2,3]\n\n`,
    );
    expect(chunk2.events).toEqual([
      {
        type: "okr_updated",
        kind: "comment_added",
        objective_id: "obj_35",
        task_id: "task_1",
        author: "codex-bot",
      },
    ]);
    expect(chunk2.rest).toBe("");

    // Over-cap buffer protection resets runaway unterminated buffer cleanly
    const capped = parseFrames("data: " + "x".repeat(512), 128);
    expect(capped.events).toEqual([]);
    expect(capped.rest).toBe("");

    // AgentChatClient dispatches all extended OkrUpdatedMessage, TaskAssignedMessage (single-PATCH reassign+done), and OkrThreadOpenedMessage frames
    const client = new AgentChatClient({ url: "ws://127.0.0.1:9999/ws", agentId: "sdk-agent-35" });
    const okrUpdates: OkrUpdatedMessage[] = [];
    const assigned: TaskAssignedMessage[] = [];
    const openedThreads: Array<Record<string, unknown>> = [];

    client
      .onOkrUpdated((m) => { okrUpdates.push(m); })
      .onTaskAssigned((m) => { assigned.push(m); })
      .onOkrThreadOpened((m) => { openedThreads.push(m as unknown as Record<string, unknown>); });

    const dispatch = (frame: Record<string, unknown>) =>
      (client as unknown as { handleMessage: (raw: string) => void }).handleMessage(JSON.stringify(frame));

    dispatch({
      type: "okr_updated",
      kind: "kr_progress",
      objective_id: "obj_35",
      kr_id: "kr_35",
      current: 1,
      discussion_channel_id: "room-dev",
    });
    dispatch({
      type: "task_assigned",
      kind: "task_update",
      task_id: "task_35",
      objective_id: "obj_35",
      status: "done",
      discussion_channel_id: "room-dev",
    });
    dispatch({
      type: "okr_thread_opened",
      target_type: "objective",
      target_id: "obj_35",
      channel_id: "room-dev",
      opened_by: "spinning-midnight-tunicate",
    });

    expect(okrUpdates[0]?.current).toBe(1);
    expect(okrUpdates[0]?.kind).toBe("kr_progress");
    expect(assigned[0]?.status).toBe("done");
    expect(assigned[0]?.discussion_channel_id).toBe("room-dev");
    expect(openedThreads).toEqual([
      {
        type: "okr_thread_opened",
        target_type: "objective",
        target_id: "obj_35",
        channel_id: "room-dev",
        opened_by: "spinning-midnight-tunicate",
      },
    ]);
  });

  test("classifyOkrCommentKind, structured OkrTaskItem TaskEvidence/upstream_handoffs, and updateOkrTask append_evidence validation", async () => {
    const { classifyOkrCommentKind } = await import("../src/index");
    expect(classifyOkrCommentKind("[SPEC 1/2] Implement point-read fastpath")).toBe("spec");
    expect(classifyOkrCommentKind("[HANDOFF] Shipped commit 0180dfa1")).toBe("handoff");
    expect(classifyOkrCommentKind("[REVIEW] LGTM 0 NUL")).toBe("review");
    expect(classifyOkrCommentKind("[BLOCKER] Waiting on upstream")).toBe("blocker");
    expect(classifyOkrCommentKind("General progress ping")).toBe("note");

    const originalFetch = globalThis.fetch;
    const seen: Array<{ url: string; method: string; headers: Record<string, string>; body: any }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      seen.push({ url: String(input), method: init?.method || "GET", headers, body });

      if (String(input).endsWith("/api/channels/room-dev/okr_snapshot")) {
        return Response.json({
          channel_id: "room-dev",
          objectives: [],
          krs: [],
          tasks: [
            {
              id: "task_36",
              objective_id: "obj_36",
              title: "Verify structured TaskEvidence",
              assignee: "codex-staff-engineer-ca7590",
              status: "todo",
              ready: true,
              unresolved_depends_on: [],
              comment_count: 2,
              evidence: [{ kind: "commit", ref: "0180dfa1", note: "Merged KR1", by: "codex-bot", at: "2026-11-14T06:17:00Z" }],
              recent_comments: [{ id: "c1", author: "lead", kind: "spec", text: "[SPEC] Full 2000 chars", at: "2026-11-14T06:21:00Z" }],
              upstream_handoffs: [
                {
                  task_id: "task_35",
                  title: "Upstream sprint",
                  status: "done",
                  author: "codex-bot",
                  kind: "handoff",
                  text: "All tests green",
                  at: "2026-11-14T06:18:00Z",
                  evidence: [{ kind: "probe", ref: "https://agents-chat.com/health" }],
                },
              ],
            },
          ],
        });
      }
      return Response.json({
        ok: true,
        task: {
          id: "task_36",
          objective_id: "obj_36",
          title: "Verify structured TaskEvidence",
          assignee: "codex-staff-engineer-ca7590",
          status: "done",
          evidence: [{ kind: "commit", ref: "0180dfa1", note: "Verified" }],
        },
      });
    }) as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "tok_sdk_36" });
      const snap = await rest.getChannelOkrSnapshot("room-dev");
      expect(snap.tasks[0]?.ready).toBe(true);
      expect(snap.tasks[0]?.upstream_handoffs?.[0]?.task_id).toBe("task_35");
      expect((snap.tasks[0]?.evidence?.[0] as { kind?: string })?.kind).toBe("commit");

      const updated = await rest.updateTask("task_36", {
        status: "done",
        append_evidence: [{ kind: "commit", ref: " 0180dfa1 ", note: " Verified " }],
      });
      expect(updated.ok).toBe(true);
      expect(seen[1]?.headers["cache-control"]).toBe("no-store");
      expect(seen[1]?.body).toEqual({
        status: "done",
        append_evidence: [{ kind: "commit", ref: "0180dfa1", note: "Verified" }],
      });

      const beforeInvalid = seen.length;
      await expect(
        rest.updateOkrTask("task_36", {
          append_evidence: [{ kind: "commit", ref: "ac_live_secret_1234567890" }],
        }),
      ).rejects.toThrow("credentials");
      await expect(
        rest.updateOkrTask("task_36", {
          append_evidence: [],
        }),
      ).rejects.toThrow("Invalid task evidence list");
      expect(seen.length).toBe(beforeInvalid);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("isValidCollaborationRoster enforces opaque member_ref, delegated read-only viewer invariants, and getChannelBrief blocks secrets/PII", async () => {
    const refA = "mr_" + "a".repeat(64);
    const refB = "mr_" + "b".repeat(64);

    const validDelegated = {
      source: "collaboration" as const,
      viewer: {
        role: "member" as const,
        is_member: false,
        can_kick: false,
        can_set_coordinator: false,
        delegated_read_only: true,
        delegated_via_agent_id: "codex-staff-engineer-ca7590",
      },
      coordinator_ref: refA,
      members: [
        {
          agent_id: "codex-staff-engineer-ca7590",
          member_ref: refA,
          type: "agent" as const,
          display_name: "Codex Staff Engineer",
          role: "member" as const,
          online: true,
          capabilities: ["typescript", "security-audit"],
          is_self: false,
          can_mention: false,
          can_kick: false,
          can_set_coordinator: false,
          ownership_scope: "owned" as const,
        },
        {
          agent_id: refB,
          member_ref: refB,
          type: "user" as const,
          display_name: "user:sw***",
          role: "admin" as const,
          online: true,
          capabilities: [],
          is_self: false,
          can_mention: false,
          can_kick: false,
          can_set_coordinator: false,
        },
      ],
    };
    expect(isValidCollaborationRoster(validDelegated)).toBe(true);

    // Reject raw email leak on user row, escalated delegated flags, or secret agent_id
    expect(
      isValidCollaborationRoster({
        ...validDelegated,
        members: [{ ...validDelegated.members[1], agent_id: "owner@example.com" }],
      }),
    ).toBe(false);
    expect(
      isValidCollaborationRoster({
        ...validDelegated,
        viewer: { ...validDelegated.viewer, can_kick: true },
      }),
    ).toBe(false);
    expect(
      isValidCollaborationRoster({
        ...validDelegated,
        members: [{ ...validDelegated.members[0], can_mention: true }],
      }),
    ).toBe(false);
    expect(
      isValidCollaborationRoster({
        ...validDelegated,
        viewer: { ...validDelegated.viewer, delegated_via_agent_id: "ac_live_secret" },
      }),
    ).toBe(false);

    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({
          channel_id: "_ops-room",
          channel: { id: "_ops-room", type: "group" },
          agents: [],
          personal_skills_unavailable: true,
        } satisfies ChannelBrief),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "tok_37" });
      const brief = await rest.getChannelBrief("_ops-room");
      expect(brief.personal_skills_unavailable).toBe(true);
      expect(fetchCount).toBe(1);

      for (const bad of ["agent_key_12345", "ghp_secret123", "eyJhbGciOiJIUzI1NiJ9", "user@example.com", "+86 13800138000", "a..b"]) {
        await expect(rest.getChannelBrief(bad)).rejects.toThrow("Invalid channel ID");
        await expect(rest.getChannelCollaborationRoster(bad)).rejects.toThrow("Invalid channel ID");
      }
      expect(fetchCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("summarizeWorkspaceGraphReadiness & hardened getWorkspaceGraph validate unresolved_edges, ?since= deltas, and zero-egress secret/PII guards", async () => {
    const graph: WorkspaceGraph = {
      scope: { type: "channel", id: "room-dev" },
      nodes: [
        { type: "channel", id: "room-dev" },
        { type: "objective", id: "obj_38", title: "Campaign 38", status: "active" },
        { type: "task", id: "task_ready_1", title: "Ship GEO corpus", owner: "spinning-midnight-tunicate", ready: true, evidence_count: 1 },
        { type: "task", id: "ac_secret_leak_id", title: "Hostile task id", ready: true },
        { type: "task", id: "owner@example.com", title: "PII task id", ready: true },
        { type: "task", id: "task_waiting", title: "Wait on archived dep", ready: false },
      ],
      edges: [
        { from: ["task", "task_waiting"], to: ["task", "task_ready_1"], type: "depends_on" },
      ],
      sections: [
        {
          id: "okr",
          title: "OKR",
          summary: {
            active_objectives: 1,
            active_tasks: 2,
            doing_tasks: 1,
            ready_tasks: 1,
            blocked_tasks: 0,
            evidence_tasks: 1,
            active_loops: 2,
            unarmed_objectives: 0,
          },
        },
        {
          id: "docs",
          title: "Docs",
          summary: { docs_count: 4, skills_count: 2 },
        },
        {
          id: "dag",
          title: "DAG",
          summary: {
            blocked_tasks: 0,
            blocker_tasks: 1,
            critical_edges: 1,
            ready_tasks: 1,
            unresolved_edges: 3,
            evidence_tasks: 1,
          },
        },
      ],
      as_of: "2026-11-14T07:00:00.000Z",
      since: "2026-11-14T06:55:00.000Z",
      referenced_unchanged_ids: ["obj_parent", "ac_live_secret", "user@example.com", "doc_sop"],
    };

    const summary = summarizeWorkspaceGraphReadiness(graph);
    expect(summary).toEqual({
      scope_type: "channel",
      scope_id: "room-dev",
      active_objectives: 1,
      active_tasks: 2,
      doing_tasks: 1,
      ready_tasks: 1,
      blocked_tasks: 0,
      blocker_tasks: 1,
      unresolved_edges: 3,
      evidence_tasks: 1,
      docs_count: 4,
      skills_count: 2,
      active_loops: 2,
      unarmed_objectives: 0,
      ready_task_ids: ["task_ready_1"],
      is_incremental: true,
      unchanged_reference_count: 2,
    });

    // Reject hostile or malformed graph scopes
    expect(summarizeWorkspaceGraphReadiness(null)).toBeNull();
    expect(
      summarizeWorkspaceGraphReadiness({
        ...graph,
        scope: { type: "channel", id: "ac_live_secret" },
      }),
    ).toBeNull();
    expect(
      summarizeWorkspaceGraphReadiness({
        ...graph,
        scope: { type: "agent", id: "owner@example.com" },
      }),
    ).toBeNull();

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json(graph);
    }) as unknown as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "tok_38" });
      for (const badId of [
        "agent_key_12345",
        "ghp_secret123",
        "github_pat_abc123",
        "AIzaSySecretKey",
        "eyJhbGciOiJIUzI1NiJ9.payload.sig",
        "owner@example.com",
        "+86 13800138000",
        "room/../escape",
      ]) {
        await expect(rest.getWorkspaceGraph("channel", badId)).rejects.toThrow("Invalid workspace graph ID");
      }
      for (const badSince of ["2026", "1731548400000", "2026-11-14", "not-an-iso"]) {
        await expect(rest.getWorkspaceGraph("channel", "room-dev", { since: badSince })).rejects.toThrow(
          "Invalid workspace graph since timestamp",
        );
      }
      expect(fetchCalls).toBe(0);

      const okGraph = await rest.getWorkspaceGraph("channel", "room-dev", {
        since: "2026-11-14T06:55:00.000Z",
      });
      expect(fetchCalls).toBe(1);
      expect(summarizeWorkspaceGraphReadiness(okGraph)?.unresolved_edges).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("resolveInheritedObjectiveChannel, computeLocalTaskActionability, and OKR entity ID secret/PII guards", async () => {
    const objectives = [
      { id: "obj_root", discussion_channel_id: "room-main" },
      { id: "obj_child", parent_id: "obj_root" },
      { id: "obj_grandchild", parent_id: "obj_child" },
      { id: "obj_dm_override", parent_id: "obj_root", discussion_channel_id: "dm-private-chat" },
      { id: "obj_cycle_a", parent_id: "obj_cycle_b" },
      { id: "obj_cycle_b", parent_id: "obj_cycle_a" },
    ];
    expect(resolveInheritedObjectiveChannel("obj_grandchild", objectives)).toBe("room-main");
    // Explicit DM override on child must never fall through to public parent room
    expect(resolveInheritedObjectiveChannel("obj_dm_override", objectives)).toBeNull();
    // Cycles terminate safely
    expect(resolveInheritedObjectiveChannel("obj_cycle_a", objectives)).toBeNull();
    expect(resolveInheritedObjectiveChannel("ac_live_secret", objectives)).toBeNull();

    // Local + archived external dependency actionability
    const actionability = computeLocalTaskActionability(
      [
        { id: "t_done", status: "done" },
        { id: "t_ready_archived_dep", status: "todo", depends_on: ["t_done", "t_archived_up"] },
        { id: "t_waiting", status: "todo", depends_on: ["t_ready_archived_dep", "t_missing_ext"] },
        { id: "t_doing_blocked", status: "doing", unresolved_depends_on: ["t_missing_ext"] },
        { id: "ac_bad_task_id", status: "todo" },
      ],
      { t_archived_up: "done" },
    );
    expect(actionability).toEqual({
      ready_task_ids: ["t_ready_archived_dep"],
      waiting_task_ids: ["t_waiting", "t_doing_blocked"],
      unresolved_edge_count: 3,
    });

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json({ ok: true, blockers: [], blocks: [], comments: [] });
    }) as unknown as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "tok_39" });
      for (const badId of [
        "agent_key_secret",
        "ghp_secret123",
        "github_pat_abc",
        "AIzaSyKey123",
        "eyJhbGciOiJIUzI1NiJ9.payload.sig",
        "owner@example.com",
        "13800138000",
        "task..escape",
      ]) {
        await expect(rest.getTaskBlockers(badId)).rejects.toThrow("Invalid task ID");
        await expect(rest.getTaskBlocks(badId)).rejects.toThrow("Invalid task ID");
        await expect(rest.listTaskComments(badId)).rejects.toThrow("Invalid task ID");
        await expect(rest.listObjectives({ owner: badId })).rejects.toThrow("Invalid OKR owner");
      }
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("summarizeChannelOkrSnapshot aggregates 3-layer inherited sub-Objectives, filters foreign overrides, and getChannelOkrSnapshot/listCloudAgentLoopObjectives block secret/PII/DM IDs", async () => {
    const summary = summarizeChannelOkrSnapshot({
      channel_id: "room-dev",
      objectives: [
        { id: "obj_root", status: "active", archived: false, discussion_channel_id: "room-dev" },
        { id: "obj_sub", status: "active", archived: false, parent_id: "obj_root" },
        { id: "obj_leaf", status: "active", archived: false, parent_id: "obj_sub" },
        { id: "obj_foreign_child", status: "active", archived: false, parent_id: "obj_root", discussion_channel_id: "secret-thread" },
        { id: "obj_archived_root", status: "done", archived: true, discussion_channel_id: "room-dev" },
        { id: "obj_under_archived", status: "active", archived: false, parent_id: "obj_archived_root" },
      ],
      krs: [
        { id: "kr_1", objective_id: "obj_leaf", metric_type: "bool", current: 1, target: 1 },
        { id: "kr_2", objective_id: "obj_sub", metric_type: "count", current: 1, target: 3 },
        { id: "kr_foreign", objective_id: "obj_foreign_child", metric_type: "bool", current: 1, target: 1 },
      ],
      tasks: [
        { id: "t_ready", objective_id: "obj_leaf", status: "todo", ready: true },
        { id: "t_wait", objective_id: "obj_sub", status: "todo", depends_on: ["t_ready"], unresolved_depends_on: ["t_ready"] },
        { id: "t_foreign", objective_id: "obj_foreign_child", status: "todo", ready: true },
      ],
      loop_summary: {
        active_loop_count: 1,
        my_active_loop_count: 1,
        okr_wake_objective_ids: ["obj_root"],
        okr_watch_objective_ids: [],
        unarmed_objective_ids: ["obj_sub", "obj_leaf", "obj_foreign_child", "ac_live_secret"],
      },
    });
    expect(summary).toEqual({
      channel_id: "room-dev",
      active_objective_ids: ["obj_root", "obj_sub", "obj_leaf"],
      unarmed_objective_ids: ["obj_sub", "obj_leaf"],
      total_krs: 2,
      completed_krs: 1,
      ready_task_ids: ["t_ready"],
      waiting_task_ids: ["t_wait"],
      unresolved_edge_count: 1,
    });

    // Degraded note or DM channel snapshots return null
    expect(summarizeChannelOkrSnapshot({ channel_id: "room-dev", objectives: [], tasks: [], note: "degraded" })).toBeNull();
    expect(summarizeChannelOkrSnapshot({ channel_id: "dm-private", objectives: [], tasks: [] })).toBeNull();

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json({ channel_id: "room-dev", objectives: [], krs: [], tasks: [] });
    }) as unknown as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "tok_40" });
      for (const badId of [
        "agent_key_secret",
        "ghp_secret123",
        "github_pat_abc",
        "AIzaSyKey123",
        "eyJhbGciOiJIUzI1NiJ9.payload.sig",
        "owner@example.com",
        "13800138000",
        "room..escape",
      ]) {
        await expect(rest.getChannelOkrSnapshot(badId)).rejects.toThrow("Invalid channel ID");
        await expect(rest.listCloudAgentLoopObjectives("codex-cloud-01", badId)).rejects.toThrow("Invalid channel ID");
      }
      await expect(rest.listCloudAgentLoopObjectives("codex-cloud-01", "dm-private")).rejects.toThrow("Invalid channel ID");
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("summarizeWorkspaceGraphHierarchy resolves 3-layer parent_id/contains lineage, cycle safety, unchanged vs dangling parents, and DM/embedded-secret guards", async () => {
    const fullGraph: WorkspaceGraph = {
      scope: { type: "channel", id: "room-dev" },
      nodes: [
        { type: "channel", id: "room-dev" },
        { type: "objective", id: "obj_root", title: "Platform Nervous System", status: "active" },
        { type: "objective", id: "obj_l2", title: "Inherited Sub-Objective", status: "active", parent_id: "obj_root" },
        // L3 linked via contains edge without redundant node.parent_id
        { type: "objective", id: "obj_l3", title: "Leaf Audit Goal", status: "active" },
        // Hostile IDs ignored
        { type: "objective", id: "ac_live_secret", title: "Secret ID", status: "active" },
      ],
      edges: [
        { from: ["objective", "obj_l2"], to: ["objective", "obj_l3"], type: "contains" },
      ],
      sections: [
        {
          id: "okr",
          title: "OKR",
          summary: {
            active_objectives: 3,
            active_tasks: 2,
            ready_tasks: 1,
            active_loops: 2,
            unarmed_objectives: 1,
          },
        },
      ],
      as_of: "2026-11-14T08:02:00.000Z",
    };

    const summary = summarizeWorkspaceGraphHierarchy(fullGraph);
    expect(summary).toEqual({
      scope_type: "channel",
      scope_id: "room-dev",
      root_objective_ids: ["obj_root"],
      nested_objective_ids: ["obj_l2", "obj_l3"],
      max_objective_depth: 3,
      unchanged_parent_ids: [],
      dangling_parent_ids: [],
      active_loops: 2,
      unarmed_objectives: 1,
      items: [
        {
          id: "obj_root",
          title: "Platform Nervous System",
          status: "active",
          parent_id: null,
          root_id: null,
          depth: 1,
          child_count: 1,
          unchanged_parent: false,
        },
        {
          id: "obj_l2",
          title: "Inherited Sub-Objective",
          status: "active",
          parent_id: "obj_root",
          root_id: "obj_root",
          depth: 2,
          child_count: 1,
          unchanged_parent: false,
        },
        {
          id: "obj_l3",
          title: "Leaf Audit Goal",
          status: "active",
          parent_id: "obj_l2",
          root_id: "obj_root",
          depth: 3,
          child_count: 0,
          unchanged_parent: false,
        },
      ],
    });

    // Incremental ?since= diff distinguishes unchanged_parent_ids vs dangling_parent_ids and handles cycles safely
    const diffGraph: WorkspaceGraph = {
      scope: { type: "channel", id: "room-dev" },
      nodes: [
        { type: "objective", id: "obj_changed_child", title: "Changed L2", status: "active", parent_id: "obj_unchanged_root" },
        { type: "objective", id: "obj_orphan_child", title: "Orphan L2", status: "active", parent_id: "obj_foreign_room" },
        { type: "objective", id: "obj_cyc_a", title: "Cycle A", status: "active", parent_id: "obj_cyc_b" },
        { type: "objective", id: "obj_cyc_b", title: "Cycle B", status: "active", parent_id: "obj_cyc_a" },
      ],
      edges: [],
      sections: [{ id: "okr", title: "OKR", summary: { active_objectives: 4 } }],
      since: "2026-11-14T08:00:00.000Z",
      referenced_unchanged_ids: ["obj_unchanged_root", "ac_live_secret"],
    };
    const diffSummary = summarizeWorkspaceGraphHierarchy(diffGraph);
    expect(diffSummary?.unchanged_parent_ids).toEqual(["obj_unchanged_root"]);
    expect(diffSummary?.dangling_parent_ids).toEqual(["obj_foreign_room"]);
    expect(diffSummary?.active_loops).toBeNull();
    expect(diffSummary?.unarmed_objectives).toBeNull();
    expect(diffSummary?.max_objective_depth).toBe(2);

    // DM channel scope rejected in pure helper and REST client with zero network egress
    expect(
      summarizeWorkspaceGraphHierarchy({
        ...fullGraph,
        scope: { type: "channel", id: "dm-private-chat" },
      }),
    ).toBeNull();

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json(fullGraph);
    }) as unknown as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "tok_41" });
      await expect(rest.getWorkspaceGraph("channel", "dm-private-chat")).rejects.toThrow("Invalid workspace graph ID");
      await expect(rest.getWorkspaceGraph("channel", "direct:u1:u2")).rejects.toThrow("Invalid workspace graph ID");
      await expect(rest.getWorkspaceGraph("objective", "room_sk-proj-1234567890abcdef")).rejects.toThrow(
        "Invalid workspace graph ID",
      );
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("evaluateConsensusTally, summarizeProposalsFeed, and proposal REST guards enforce server-identical consensus math and zero secret/DM egress", async () => {
    // 1. Majority: >50% of effective_voters, conservative server-identical early pass/fail, all-abstain => passed: false
    expect(evaluateConsensusTally(["approve", "approve", "approve", "approve"], 5, "majority")).toEqual({
      passed: true,
      is_complete: true,
      approve_count: 4,
      reject_count: 0,
      abstain_count: 0,
      effective_voters: 5,
      voted_count: 4,
      total_voters: 5,
      required_approvals: 3,
    });
    expect(evaluateConsensusTally(["reject", "reject", "reject", "reject"], 5, "majority")).toMatchObject({
      passed: false,
      is_complete: true,
      effective_voters: 5,
    });
    expect(evaluateConsensusTally(["approve", "approve"], 3, "majority")).toMatchObject({
      passed: true,
      is_complete: false,
      effective_voters: 3,
      required_approvals: 2,
    });
    expect(evaluateConsensusTally(["approve"], 5, "majority")).toMatchObject({
      passed: false,
      is_complete: false,
      effective_voters: 5,
      required_approvals: 3,
    });
    expect(evaluateConsensusTally(["abstain", "abstain"], 2, "majority")).toMatchObject({
      passed: false,
      is_complete: true,
      effective_voters: 0,
      required_approvals: 0,
    });

    // 2. Supermajority: >= 2/3 of effective_voters, completes only when voted_count >= total_voters
    expect(evaluateConsensusTally(["reject", "reject"], 3, "super_majority")).toMatchObject({
      passed: false,
      is_complete: false,
      effective_voters: 3,
      required_approvals: 2,
    });
    expect(evaluateConsensusTally(["approve", "approve", "abstain", "reject"], 4, "super_majority")).toMatchObject({
      passed: true,
      is_complete: true,
      effective_voters: 3,
      required_approvals: 2,
    });

    // 3. Unanimous: 100% of effective_voters, single reject terminates early
    expect(evaluateConsensusTally(["reject"], 5, "unanimous")).toMatchObject({
      passed: false,
      is_complete: true,
      effective_voters: 5,
      required_approvals: 5,
    });
    expect(evaluateConsensusTally(["approve", "abstain", "approve"], 3, "unanimous")).toMatchObject({
      passed: true,
      is_complete: true,
      effective_voters: 2,
      required_approvals: 2,
    });

    // 4. summarizeProposalsFeed handles fail-closed expiry, read-only supervision, ballot rationales, and DM rejection
    const nowMs = Date.parse("2026-11-14T08:00:00.000Z");
    const summary = summarizeProposalsFeed(
      {
        channel_id: "room-dev",
        can_propose: false,
        read_only: true,
        proposals: [
          {
            id: "prop-open",
            channel_id: "room-dev",
            status: "pending",
            expires_at: "2026-11-15T00:00:00.000Z",
            votes: [
              { voter_id: "bot_1", decision: "approve", reason: "Verified cross-pod invite restore" },
              { voter_id: "bot_2", decision: "abstain", reason: "leaked sk-live_secret_token_123456" },
            ],
          },
          {
            id: "prop-stale",
            channel_id: "room-dev",
            status: "pending",
            expires_at: "2026-11-14T01:00:00.000Z",
            votes: [],
          },
          {
            id: "prop-passed",
            channel_id: "room-dev",
            status: "passed",
            votes: [{ voter_id: "bot_3", decision: "approve", reason: "LGTM with tests" }],
          },
          {
            id: "prop_sk-proj-1234567890abcdef",
            channel_id: "room-dev",
            status: "pending",
          },
        ],
      },
      nowMs,
    );
    expect(summary).toEqual({
      channel_id: "room-dev",
      can_propose: false,
      read_only: true,
      total_proposals: 3,
      pending_count: 1,
      passed_count: 1,
      rejected_count: 0,
      expired_count: 1,
      pending_ids: ["prop-open"],
      ballot_rationale_count: 2,
    });
    expect(summarizeProposalsFeed({ channel_id: "dm-secret", proposals: [] })).toBeNull();

    // 5. Proposal REST guards reject DM channels and embedded secrets with zero fetch egress
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "tok_42" });
      await expect(rest.listChannelProposals("dm-private-chat")).rejects.toThrow("Invalid channel ID");
      await expect(rest.listChannelProposals("room_sk-proj-1234567890abcdef")).rejects.toThrow("Invalid channel ID");
      await expect(
        rest.createChannelProposal("room-dev", {
          title: "Deploy token sk-proj-1234567890abcdef",
          consensus_rule: "majority",
        }),
      ).rejects.toThrow("Secret or credential detected");
      await expect(
        rest.voteChannelProposal("room-dev", "prop-open", {
          decision: "approve",
          reason: "Using ghp_1234567890abcdef token",
        }),
      ).rejects.toThrow("Secret or credential detected");
      await expect(
        rest.voteChannelProposal("room-dev", "prop_ac_secret_987654321", { decision: "approve" }),
      ).rejects.toThrow("Invalid proposal ID");
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("summarizeChannelDocDetail projects 3-layer OKR backlinks safely and ChannelDocs/getChannelPins block DM & embedded secrets", async () => {
    const { summarizeChannelDocDetail } = await import("../src/index");

    const detail = summarizeChannelDocDetail({
      id: "arch-spec",
      title: "Architecture Spec",
      kind: "deep_dive",
      level: 3,
      version: 5,
      bodyMarkdown: "# Architecture\n\n3-layer OKR backlinks.",
      revisions: [
        { version: 4, title: "Old" },
        { version: 4, title: "Dup" },
        { version: 3, title: "Older" },
      ],
      backlinks: [
        { type: "objective", id: "obj_root_1", title: "Root Objective", relation: "linked_channel_docs" },
        { type: "objective", id: "obj_root_1", title: "Dup Root", relation: "linked_channel_docs" },
        { type: "key_result", id: "kr_l2_1", title: "L2 KR ghp_1234567890abcdef", relation: "linked_channel_docs" },
        { type: "task", id: "task_l3_1", title: "L3 Leaf Task", relation: "linked_channel_docs" },
        { type: "task", id: "task_ac_secret_987654321", title: "Drop Secret ID", relation: "linked_channel_docs" },
      ],
    });

    expect(detail).toEqual({
      id: "arch-spec",
      title: "Architecture Spec",
      kind: "deep_dive",
      level: 3,
      version: 5,
      archived: false,
      revision_count: 2,
      backlink_count: 3,
      objective_backlink_ids: ["obj_root_1"],
      kr_backlink_ids: ["kr_l2_1"],
      task_backlink_ids: ["task_l3_1"],
      backlinks: [
        { type: "objective", id: "obj_root_1", title: "Root Objective", relation: "linked_channel_docs" },
        { type: "key_result", id: "kr_l2_1", title: "kr_l2_1", relation: "linked_channel_docs" },
        { type: "task", id: "task_l3_1", title: "L3 Leaf Task", relation: "linked_channel_docs" },
      ],
    });

    // Soft-archived tombstone suppresses active backlinks
    const archivedDetail = summarizeChannelDocDetail({
      id: "arch-spec",
      title: "Architecture Spec",
      kind: "deep_dive",
      level: 3,
      version: 6,
      bodyMarkdown: "",
      archived: true,
      backlinks: [{ type: "objective", id: "obj_root_1", title: "Root Objective" }],
    });
    expect(archivedDetail?.archived).toBe(true);
    expect(archivedDetail?.backlink_count).toBe(0);
    expect(summarizeChannelDocDetail({ id: "doc_sk-proj-1234567890abcdef", kind: "context", level: 3, version: 1, bodyMarkdown: "x" })).toBeNull();

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json({
        channel_id: "room-dev",
        pinned_messages: ["msg_valid_1", "msg_sk-proj-1234567890abcdef", "ac_secret_987654321", "msg_valid_1"],
      });
    }) as unknown as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "tok_43" });
      await expect(rest.listChannelDocs("dm-private")).rejects.toThrow("Invalid channel ID");
      await expect(rest.getChannelDoc("direct:alice:bob", "arch-spec")).rejects.toThrow("Invalid channel ID");
      await expect(rest.getChannelDoc("room-dev", "doc_ac_secret_987654321")).rejects.toThrow("Invalid channel doc ID");
      await expect(
        rest.saveChannelDoc("room-dev", "arch-spec", {
          title: "Safe Title",
          kind: "deep_dive",
          level: 3,
          body_markdown: "Leaked token sk-proj-1234567890abcdef inside markdown",
          if_match_version: 1,
        }),
      ).rejects.toThrow("Secret or credential detected");
      await expect(rest.getChannelPins("dm-private")).rejects.toThrow("Invalid channel ID");
      await expect(rest.getChannelPins("room_ghp_1234567890abcdef")).rejects.toThrow("Invalid channel ID");
      expect(fetchCalls).toBe(0);

      const pins = await rest.getChannelPins("room-dev");
      expect(fetchCalls).toBe(1);
      expect(pins).toEqual({
        channel_id: "room-dev",
        pinned_messages: ["msg_valid_1"],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("summarizeChannelThreads, ChannelArchivedMessage.archived, and thread/webhook zero-egress guards", async () => {
    const summary = summarizeChannelThreads({
      channel_id: "room-dev",
      threads: [
        { parent_id: "msg_old", reply_count: 2, last_reply_at: "2026-11-14T00:05:00.000Z" },
        { parent_id: "msg_latest", reply_count: 5, last_reply_at: "2026-11-14T01:02:00.000Z" },
        { parent_id: "msg_old", reply_count: 2, last_reply_at: "2026-11-14T00:05:00.000Z" },
        { parent_id: "msg_sk-proj-1234567890abcdef", reply_count: 99, last_reply_at: "2026-11-14T02:00:00.000Z" },
      ],
    });
    expect(summary).toEqual({
      channel_id: "room-dev",
      total_threads: 2,
      total_replies: 7,
      most_active_parent_id: "msg_latest",
      latest_reply_at: "2026-11-14T01:02:00.000Z",
      threads: [
        { parent_id: "msg_latest", reply_count: 5, last_reply_at: "2026-11-14T01:02:00.000Z" },
        { parent_id: "msg_old", reply_count: 2, last_reply_at: "2026-11-14T00:05:00.000Z" },
      ],
    });
    expect(summarizeChannelThreads({ channel_id: "dm-private", threads: [] })).toBeNull();
    expect(summarizeChannelThreads({ channel_id: "room_ac_secret_987654321", threads: [] })).toBeNull();

    const archiveFrame: import("../src/index.ts").ChannelArchivedMessage = {
      type: "channel_archived",
      channel_id: "room-dev",
      archived: false,
    };
    expect(archiveFrame.archived).toBe(false);

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json({ channel_id: "room-dev", threads: [] });
    }) as unknown as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "tok_44" });
      await expect(rest.getChannelThreads("dm-private")).rejects.toThrow("Invalid channel ID");
      await expect(rest.getChannelThreads("room_sk-proj-1234567890abcdef")).rejects.toThrow("Invalid channel ID");
      await expect(rest.registerWebhook("dm-private", "https://hooks.example.com/notify")).rejects.toThrow("Invalid channel ID");
      await expect(rest.registerWebhook("room-dev", "https://hooks.example.com/sk-proj-1234567890abcdef")).rejects.toThrow("Webhook URL must not contain secrets");
      await expect(rest.removeWebhook("direct:alice:bob", "https://hooks.example.com/notify")).rejects.toThrow("Invalid channel ID");
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("summarizeChannelBriefReadiness and brief/wake-health/cloud-loop zero-egress guards", async () => {
    const summary = summarizeChannelBriefReadiness({
      channel_id: "room-dev",
      channel: { id: "room-dev", name: "AgentChatDev", type: "group" },
      agents: [
        { id: "codex-1", online: true, capabilities: ["swift", "security-audit", "swift"] },
        { id: "claude-2", online: false, capabilities: ["swift", "docs"] },
        { id: "bot_sk-proj-1234567890abcdef", online: true, capabilities: ["swift"] },
      ],
      skills_summary: {
        channel_skills: [
          { doc_id: "doc-review", skill_meta: { name: "review" } },
          { doc_id: "doc_ac_secret_123456789", skill_meta: { name: "bad" } },
        ],
        personal_skills: [{ name: "my-operator-skill" }],
      },
      okr_summary: {
        active_objective_count: 2,
        total_task_count: 5,
        ready_task_count: 2,
        doing_task_count: 2,
        blocked_task_count: 1,
        ready_for_me_count: 1,
      },
      loop_summary: {
        active_loop_count: 1,
        my_active_loop_count: 1,
        okr_wake_objective_ids: ["obj_1"],
        okr_watch_objective_ids: [],
        unarmed_objective_ids: ["obj_2", "obj_2", "obj_sk-proj-1234567890abcdef"],
      },
      wake_health_summary: {
        observation_only: true,
        counts: { total_cloud_agents: 2, ok: 1, auth_required: 1, timeout: 0, error: 0, unobserved: 0 },
        attention_agents: [
          { agent_id: "claude-2", runtime: "claude", cloud_status: "active", last_wake_status: "auth_required" },
          { agent_id: "bot_ac_secret_123456789", runtime: "codex", cloud_status: "active", last_wake_status: "error" },
        ],
      },
    });
    expect(summary).toEqual({
      channel_id: "room-dev",
      online_agent_count: 1,
      total_agent_count: 2,
      specialties: [
        { capability: "swift", total_agents: 2, online_agents: 1 },
        { capability: "security-audit", total_agents: 1, online_agents: 1 },
        { capability: "docs", total_agents: 1, online_agents: 0 },
      ],
      channel_skill_count: 1,
      personal_skill_count: 1,
      personal_skills_unavailable: false,
      ready_for_me_count: 1,
      unarmed_objective_ids: ["obj_2"],
      attention_agent_ids: ["claude-2"],
      is_wake_healthy: false,
    });
    expect(summarizeChannelBriefReadiness({ channel_id: "dm-private", channel: { id: "dm-private", type: "direct" }, agents: [] })).toBeNull();

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "tok_45" });
      await expect(rest.getChannelBrief("dm-private")).rejects.toThrow("Invalid channel ID");
      await expect(rest.getChannelWakeHealth("dm-private")).rejects.toThrow("Invalid channel ID");
      await expect(rest.getChannelWakeHealth("room_sk-proj-1234567890abcdef")).rejects.toThrow("Invalid channel ID");
      await expect(rest.getChannelLoops("room_ac_secret_123456789")).rejects.toThrow("Invalid channel ID");
      await expect(
        rest.createCloudAgentLoop("codex-sub-01", {
          channel_id: "dm-owner",
          mode: "okr_wake",
          objective_id: "obj_alpha_01",
          interval: "15m",
        }),
      ).rejects.toThrow("OKR loops require a group or project channel");
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("summarizePersonalSkillsLibrary and Personal Skills REST client support dotted/mixed-case slugs while blocking embedded secrets and invalid frontmatter", async () => {
    const summary = summarizePersonalSkillsLibrary({
      owner: "[redacted]",
      skills: [
        {
          name: "deploy-v2.1",
          title: "Deploy v2.1",
          description: "Zero-downtime deploy checklist",
          version: 4,
          updated_at: "2026-11-14T01:20:00Z",
          skill_meta: {
            name: "Deploy v2.1",
            description: "Zero-downtime deploy checklist",
            trigger: "/deploy",
            argument_hint: "[service]",
          },
        },
        {
          name: "SwiftAudit.check",
          title: "Leak owner@example.com",
          description: "Token my_ac_secret_1234567890",
          version: 2,
          updated_at: "2026-11-14T01:30:00Z",
          skill_meta: {
            name: "SwiftAudit",
            description: "Clean fallback",
            trigger: "/swift-audit",
          },
        },
        {
          name: "legacy.archived",
          title: "Legacy",
          description: "Retired playbook",
          version: 7,
          archived: true,
          updated_at: "2026-11-10T00:00:00Z",
          skill_meta: {
            name: "Legacy",
            description: "Retired playbook",
            trigger: "/legacy",
          },
        },
        {
          name: "bad..slug",
          version: 1,
        },
        {
          name: "my_ac_secret_1234567890",
          version: 1,
        },
      ],
    });

    expect(summary).toEqual({
      total_skills: 3,
      active_count: 2,
      archived_count: 1,
      remaining_active_quota: 48,
      triggered_count: 2,
      triggers: ["/deploy", "/swift-audit"],
      items: [
        {
          name: "SwiftAudit.check",
          title: "SwiftAudit.check",
          description: "",
          trigger: "/swift-audit",
          argument_hint: null,
          version: 2,
          archived: false,
          updated_at: "2026-11-14T01:30:00Z",
        },
        {
          name: "deploy-v2.1",
          title: "Deploy v2.1",
          description: "Zero-downtime deploy checklist",
          trigger: "/deploy",
          argument_hint: "[service]",
          version: 4,
          archived: false,
          updated_at: "2026-11-14T01:20:00Z",
        },
        {
          name: "legacy.archived",
          title: "Legacy",
          description: "Retired playbook",
          trigger: "/legacy",
          argument_hint: null,
          version: 7,
          archived: true,
          updated_at: "2026-11-10T00:00:00Z",
        },
      ],
    });
    expect(summarizePersonalSkillsLibrary(null)).toBeNull();

    const originalFetch = globalThis.fetch;
    const seenPaths: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      seenPaths.push(u.pathname);
      return Response.json({ ok: true, name: decodeURIComponent(u.pathname.split("/").pop()!), version: 2 });
    }) as unknown as typeof fetch;

    try {
      const rest = new AgentChatREST({ baseUrl: "https://agents-chat.com", bearerToken: "jwt_owner_46" });
      await rest.getPersonalSkill("deploy-v2.1");
      await rest.savePersonalSkill("SwiftAudit.v2", {
        body_markdown: "---\nname: SwiftAudit\ndescription: Audit Swift 6 concurrency\n---\n\n# Steps\n1. Check actors.\n",
        if_match_version: 1,
      });
      expect(seenPaths).toEqual(["/api/skills/deploy-v2.1", "/api/skills/SwiftAudit.v2"]);

      await expect(rest.getPersonalSkill("agent_key_1234567890")).rejects.toThrow("Invalid personal skill name");
      await expect(rest.getPersonalSkill("skill_ac_secret_12345678")).rejects.toThrow("Invalid personal skill name");
      await expect(
        rest.savePersonalSkill("deploy-v2.1", {
          body_markdown: "# Missing frontmatter",
        }),
      ).rejects.toThrow("YAML frontmatter");
      await expect(
        rest.savePersonalSkill("deploy-v2.1", {
          body_markdown: "---\nname: deploy\ndescription: leak\n---\nenv_ac_secret_1234567890abcdef",
        }),
      ).rejects.toThrow("must not contain API keys");
      expect(seenPaths).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
