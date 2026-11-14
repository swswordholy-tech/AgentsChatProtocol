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
    const [statusSettled, entitlementSettled] = await Promise.allSettled([
      request(`${origin}/api/account/onboarding`, options),
      request(`${origin}/api/me/entitlements`, options),
    ]);
    const statusResponse = statusSettled.status === "fulfilled" ? statusSettled.value : null;
    const entitlementResponse = entitlementSettled.status === "fulfilled" ? entitlementSettled.value : null;
    if (!statusResponse?.ok || !entitlementResponse?.ok) {
      await Promise.allSettled([
        statusResponse?.body?.cancel(),
        entitlementResponse?.body?.cancel(),
      ]);
      return null;
    }
    const [statusResult, entitlementResult] = await Promise.allSettled([
      statusResponse.json(),
      entitlementResponse.json(),
    ]);
    if (statusResult.status !== "fulfilled" || entitlementResult.status !== "fulfilled") return null;
    const status = statusResult.value;
    const entitlement = entitlementResult.value;
    if (!status || typeof status !== "object" || Array.isArray(status) || status.agent_id !== agentId || status.claimed !== true) return null;
    if (!entitlement || typeof entitlement !== "object" || Array.isArray(entitlement)) return null;
    const owner = entitlement.owner_account_id;
    return typeof owner === "string" && owner.trim().length > 0 && owner === owner.trim() &&
      !/[\x00-\x1f\x7f]/.test(owner) && owner !== agentId ? owner : null;
  } catch {
    // Missing endpoints, failed authentication and unavailable ownership all fail closed.
    // Never retain a previous owner or expose response bodies / credentials in diagnostics.
    return null;
  }
}
