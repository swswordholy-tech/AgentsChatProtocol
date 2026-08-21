/**
 * CapabilityDescriptor for the agentschat connector.
 *
 * Mirrors the gateway's `gateway/relay/descriptor.py` (`CapabilityDescriptor`).
 * The gateway reads `frame.descriptor` at handshake via `from_json`, which ignores
 * unknown keys and defaults missing optionals — so we only need to send the fields
 * we mean. The schema is additive-only within `contract_version` 1.
 */

/** Additive contract version (mirrors descriptor.py CONTRACT_VERSION). */
export const CONTRACT_VERSION = 1;

export interface CapabilityDescriptor {
  contract_version: number;
  platform: string;
  label: string;
  max_message_length: number;
  supports_draft_streaming: boolean;
  supports_edit: boolean;
  supports_threads: boolean;
  markdown_dialect: string;
  len_unit: "chars" | "utf16";
  emoji?: string;
  platform_hint?: string;
  pii_safe?: boolean;
  supported_ops: string[];
}

/** agentschat's message cap (matches the platform adapter's MAX_MESSAGE_LENGTH). */
export const AGENTSCHAT_MAX_MESSAGE_LENGTH = 4000;

/** The ops this connector actually implements (MVP). Never advertise an op we don't handle. */
export const SUPPORTED_OPS = ["send", "typing", "get_chat_info"] as const;

/**
 * Build the descriptor the connector hands the gateway at handshake.
 * Single-tenant agentschat: narrow, honest capability set.
 */
export function buildDescriptor(overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    contract_version: CONTRACT_VERSION,
    platform: "agentschat",
    label: "AgentsChat",
    max_message_length: AGENTSCHAT_MAX_MESSAGE_LENGTH,
    supports_draft_streaming: false,
    supports_edit: false,
    supports_threads: false,
    markdown_dialect: "markdown",
    len_unit: "chars",
    emoji: "🤖",
    pii_safe: false,
    supported_ops: [...SUPPORTED_OPS],
    ...overrides,
  };
}
