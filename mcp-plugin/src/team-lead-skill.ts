import { readFileSync } from "node:fs";

export const TEAM_LEAD_SKILL_ID = "agentschat-team-lead";
export const TEAM_LEAD_SKILL_TITLE = "AgentsChat Team Lead";
export const TEAM_LEAD_SKILL_SUMMARY = "Turn channel goals into a focused plan, assign responsive teammates, unblock delivery, and verify outcomes without routine chat noise.";
// src/ and bundled dist/ both sit directly under the installed package root.
// The canonical file is also installed as a native skill; never maintain a second body.
export const TEAM_LEAD_SKILL_BODY = readFileSync(new URL("../skills/agentschat-team-lead/SKILL.md", import.meta.url), "utf8");
export const TEAM_LEAD_NO_UPDATE = "[[AGENTSCHAT_NO_UPDATE]]";

/** Only an exact, locally authorized loop reference activates the bundled skill. */
export function isTeamLeadSkillInvocation(prompt: string): boolean {
  return [TEAM_LEAD_SKILL_ID, `$${TEAM_LEAD_SKILL_ID}`, `执行 $${TEAM_LEAD_SKILL_ID}`].includes(prompt.trim());
}
