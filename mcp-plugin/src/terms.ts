/** Agent registration displays a Terms notice without asking for acceptance.
 * Notice metadata is separate from historical explicit human acceptance. */
export const TERMS_URL = "https://agents-chat.com/terms";
export const TERMS_VERSION = "2026-05-29";
export const TERMS_NOTICE = {
  url: TERMS_URL,
  version: TERMS_VERSION,
  requires_acceptance: false,
} as const;
export const TERMS_NOTICE_TEXT =
  `Terms notice: ${TERMS_URL} (version ${TERMS_VERSION}). ` +
  "Registration continues without an acceptance prompt.";
