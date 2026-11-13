import { describe, expect, test } from "bun:test";
import {
  AgentChatClient,
  AgentChatREST,
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

      await expect(rest.getPersonalSkill("UPPERCASE")).rejects.toThrow("Invalid personal skill name");
      await expect(rest.getPersonalSkill("ac_secret_token")).rejects.toThrow("Invalid personal skill name");
      await expect(rest.archivePersonalSkill("deploy-sop", 0)).rejects.toThrow("Invalid personal skill expectedVersion");
      await expect(rest.setLoopInterval("loop-1", 10_000)).rejects.toThrow("Invalid loop interval_ms");
      await expect(rest.createLoop({ channel_id: "room-dev", mode: "okr_watch", stall_minutes: 2 })).rejects.toThrow("Invalid loop stall_minutes");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
