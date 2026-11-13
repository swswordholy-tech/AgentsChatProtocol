import { describe, expect, test } from "bun:test";
import {
  AgentChatClient,
  AgentChatREST,
  type ACMessage,
  type ChannelDocUpdatedMessage,
  type ChannelWakeHealth,
  type CloudAgentAuditFeed,
  type OkrUpdatedMessage,
  type RoomLoopsFeed,
  type TaskAssignedMessage,
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
});
