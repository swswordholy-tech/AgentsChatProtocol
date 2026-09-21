export interface OnboardingStatus {
  agent_id: string; claimed: boolean | null; authentication: "ok" | "failed" | "unknown";
  chat_url: string; claim_url: string; next_step: "claim_agent" | "verify_reply" | "check_identity";
}
export async function getOnboardingStatus(base: string, agentId: string, token: string, request: (url: string, options: RequestInit) => Promise<Response> = fetch): Promise<OnboardingStatus> {
  const chat = `${base.replace(/\/$/, "")}/chat/${encodeURIComponent(agentId)}`;
  const result: OnboardingStatus = {agent_id: agentId, claimed: null, authentication: "unknown", chat_url: chat,
    claim_url: `${chat}?claim=1`, next_step: "check_identity"};
  try {
    const r = await request(`${base.replace(/\/$/, "")}/api/account/onboarding`, {
      headers: {Authorization: `Bearer ${token}`}, cache: "no-store", signal: AbortSignal.timeout(8000), redirect: "error",
    });
    if (r.status === 401 || r.status === 403) { result.authentication = "failed"; return result; }
    if (!r.ok) return result;
    const data = await r.json() as any;
    if (data.agent_id !== agentId || typeof data.claimed !== "boolean") return result;
    result.authentication = "ok"; result.claimed = data.claimed;
    result.next_step = data.claimed ? "verify_reply" : "claim_agent";
  } catch { /* Network/unsupported endpoint is unknown, never unclaimed. */ }
  return result;
}
export function claimSummary(status: OnboardingStatus): string {
  if (status.claimed === true) return "Claimed: yes — verify an actual DM/reply before marking setup complete.";
  if (status.claimed === false) return `Claimed: NO — open ${status.claim_url} and enter the token from your private profile. Claiming unlocks DMs and private channels.`;
  return `Claimed: unknown — ownership could not be verified. Check the service and account; do not register a replacement. Claim entry: ${status.claim_url}`;
}
