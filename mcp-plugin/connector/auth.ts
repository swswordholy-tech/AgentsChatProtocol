/**
 * Connector-side relay upgrade-token auth. EXPERIMENTAL.
 *
 * This is the CONNECTOR half of the HMAC scheme the gateway implements in
 * `gateway/relay/auth.py` (which in turn mirrors the reference connector's
 * `relayAuthToken.ts`). The wire bytes must match both exactly:
 *
 *   token   = base64url(f"{payload}:{exp}:{sig}")   — unpadded
 *   sig     = HMAC_SHA256(f"{payload}:{exp}", secret).hexdigest()
 *   payload = gateway_id
 *
 * The gateway sends it as `Authorization: Bearer <token>` on the `/relay`
 * WebSocket upgrade. We peek the gateway_id (the payload head) to select the
 * secret verify list for that gateway, then verify the signature against that
 * gateway's stored secret(s) — a multi-secret rotation window so a rotation
 * never invalidates an outstanding token.
 *
 * EXPERIMENTAL: the relay contract may change without a deprecation cycle until
 * ≥2 Class-1 platforms validate it.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Application close code the connector sends when upgrade auth fails (contract §6.1). */
export const CLOSE_UNAUTHORIZED = 4401;

/** Default upgrade-token TTL the gateway uses (mirrors auth.py `_DEFAULT_UPGRADE_TTL_SECONDS`). */
export const DEFAULT_UPGRADE_TTL_SECONDS = 300;

function hmacHex(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/** HMAC-SHA256 hex digest — the connector's `sign` (mirrors auth.py `sign`). */
export function sign(payload: string, secret: string): string {
  return hmacHex(payload, secret);
}

/** Constant-time check that `sigHex` is a valid HMAC of `payload` under ANY of `secrets`. */
export function verifySignature(payload: string, sigHex: string, secrets: readonly string[]): boolean {
  let sigBuf: Buffer;
  try {
    sigBuf = Buffer.from(sigHex, "hex");
  } catch {
    return false;
  }
  if (sigBuf.length === 0) return false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = Buffer.from(hmacHex(payload, secret), "hex");
    if (expected.length !== sigBuf.length) continue; // no timing leak on length
    if (timingSafeEqual(sigBuf, expected)) return true;
  }
  return false;
}

/**
 * Build a signed, optionally-expiring token (mirrors auth.py `make_token`).
 * `base64url(f"{payload}:{exp}:{sig}")`, unpadded; `exp` is unix-seconds, 0 = never.
 */
export function makeToken(payload: string, secret: string, ttlSeconds = 0): string {
  const exp = ttlSeconds > 0 ? Math.floor(Date.now() / 1000) + ttlSeconds : 0;
  const signed = `${payload}:${exp}`;
  const sig = hmacHex(signed, secret);
  return Buffer.from(`${signed}:${sig}`, "utf8").toString("base64url");
}

/** The WS-upgrade bearer a gateway sends: `payload = gateway_id` (mirrors `make_upgrade_token`). */
export function makeUpgradeToken(
  gatewayId: string,
  secret: string,
  ttlSeconds: number = DEFAULT_UPGRADE_TTL_SECONDS,
): string {
  return makeToken(gatewayId, secret, ttlSeconds);
}

/**
 * Verify a token from `make_token`; return the payload (gateway_id) or null.
 * Splits from the right so a payload may contain colons; rejects expired tokens and
 * any signature not matching a secret in the verify list.
 */
export function verifyToken(token: string, secrets: readonly string[]): string | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split(":");
  if (parts.length < 3) return null;
  const sig = parts[parts.length - 1];
  const exp = Number.parseInt(parts[parts.length - 2], 10);
  if (!Number.isFinite(exp)) return null;
  const payload = parts.slice(0, -2).join(":");
  if (exp !== 0 && Math.floor(Date.now() / 1000) > exp) return null;
  const signed = `${payload}:${exp}`;
  return verifySignature(signed, sig, secrets) ? payload : null;
}

/** Verify an upgrade token against the verify list for a gateway; alias for clarity at call sites. */
export function verifyUpgradeToken(token: string, secrets: readonly string[]): string | null {
  return verifyToken(token, secrets);
}
