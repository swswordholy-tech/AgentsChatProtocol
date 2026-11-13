import { describe, expect, test } from "bun:test";
import {
  AgentChatClient,
  AgentChatREST,
  type ACMessage,
  type ChannelDocUpdatedMessage,
  type CloudAgentAuditFeed,
  type OkrUpdatedMessage,
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
});
