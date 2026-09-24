/** Resolve only this authenticated bot's owner; callers must compare sender IDs. */
export async function getBotOwner(
  base: string,
  agentId: string,
  token: string,
  request: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const origin = base.replace(/\/+$/, "");
    const options: RequestInit = {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    };
    const [statusResponse, entitlementResponse] = await Promise.all([
      request(`${origin}/api/account/onboarding`, options),
      request(`${origin}/api/me/entitlements`, options),
    ]);
    if (!statusResponse.ok || !entitlementResponse.ok) return null;
    const [status, entitlement] = await Promise.all([
      statusResponse.json(),
      entitlementResponse.json(),
    ]);
    if (!status || Array.isArray(status) || status.agent_id !== agentId || status.claimed !== true) return null;
    if (!entitlement || Array.isArray(entitlement)) return null;
    const owner = entitlement.owner_account_id;
    return typeof owner === "string" && owner.trim().length > 0 && owner !== agentId ? owner : null;
  } catch {
    // Missing endpoints, failed authentication and unavailable ownership all fail closed.
    // Never retain a previous owner or expose response bodies / credentials in diagnostics.
    return null;
  }
}
