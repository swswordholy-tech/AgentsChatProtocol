import { describe, expect, test } from "bun:test";
import {
  AgentChatClient,
  type ACMessage,
  type ChannelDocUpdatedMessage,
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
});
