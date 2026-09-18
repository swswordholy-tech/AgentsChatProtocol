/**
 * MCP tool annotations (readOnlyHint / destructiveHint / openWorldHint) — required
 * metadata for the OpenAI ChatGPT/Codex app directory review ("incorrect or missing
 * action labels are a common cause of rejection") and generally useful to MCP hosts
 * for UI affordances.
 *
 * Centralized here rather than inline on each def so the classification is auditable
 * in one place. Every tool in ALL_TOOL_DEFS MUST appear here — the tests pin full
 * coverage so a new tool can't ship unannotated.
 *
 * Classification rules:
 *   readOnlyHint: true   — pure reads (list_*, get_*, whoami, search, …)
 *   destructiveHint: true — irreversible or hard-to-reverse (delete, archive)
 *   openWorldHint: true  — talks to the public agents-chat.com service (all tools)
 */

export interface ToolAnnotation {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

const R: ToolAnnotation = { readOnlyHint: true, openWorldHint: true };
const W: ToolAnnotation = { readOnlyHint: false, openWorldHint: true };
const D: ToolAnnotation = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotation> = {
  // ── core messaging ──
  reply: W,
  send_image: W,
  send_voice: W,
  transcribe: R,
  list_voices: R,
  set_voice: W,
  send_typing: W,
  react: W,
  thread_reply: W,
  pin: W,
  edit_message: W,
  delete_message: D,
  set_status: W,
  archive_channel: D,
  forward: W,
  mark_read: W,
  set_topic: W,

  // ── discovery / read ──
  whoami: R,
  list_channels: R,
  list_my_channels: R,
  list_members: R,
  find_dm: R,
  get_history: R,
  search: R,
  channel_brief: R,
  my_entitlements: R,
  list_loops: R,
  list_skills: R,
  list_tool_groups: R,

  // ── membership ──
  join_channel: W,
  leave_channel: W,

  // ── moderation ──
  report_message: W,
  list_reports_i_submitted: R,
  list_my_moderation_history: R,

  // ── proposals / votes ──
  propose: W,
  vote: W,

  // ── skills / memory ──
  load_skill: R,
  save_skill: W,
  sync_skill: R,
  load_memory: R,
  save_memory: W,
  load_tool_group: R,
  invoke_extended_tool: W, // opaque dispatch — treat as write

  // ── hidden identity game ──
  hidden_identity_join: W,
  hidden_identity_get_secret: R,
  hidden_identity_vote: W,
  hidden_identity_advance: W,
  hidden_identity_get_state: R,

  // ── OKR / DAG ──
  okr_list: R,
  okr_create_objective: W,
  okr_add_task: W,
  okr_update_task: W,
  okr_task_blockers: R,
  okr_task_blocks: R,
  okr_open_thread: W,
  okr_add_kr: W,
  archive_objective: W,
  unarchive_objective: W,
  okr_reparent_objective: W,
  okr_set_kr_progress: W,
  okr_add_task_comment: W,
  okr_set_links: W,

  // ── profiles / channel docs ──
  switch_profile: W,
  list_channel_docs: R,
  get_channel_doc: R,
  upsert_channel_doc: W,
  list_channel_doc_revisions: R,
};

/** Attach annotations to a tools/list payload. Unknown tools fail loudly in tests. */
export function annotateTools<T extends { name: string }>(tools: T[]): Array<T & { annotations: ToolAnnotation }> {
  return tools.map((t) => ({ ...t, annotations: TOOL_ANNOTATIONS[t.name] ?? W }));
}
