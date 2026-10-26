import { expect, spyOn, test } from "bun:test";
import { getBotOwner } from "../codex/owner.ts";

const BASE = "https://test.invalid";
const BOT = "test-bot";
const TOKEN = "ac_local_test_only";
const STATUS = { agent_id: BOT, claimed: true };
const ENTITLEMENT = { owner_account_id: "real-owner" };
const isStatus = (url: RequestInfo | URL) => String(url).endsWith("/api/account/onboarding");
const respond = (status: unknown = STATUS, entitlement: unknown = ENTITLEMENT) =>
  (async (url: RequestInfo | URL) => Response.json(isStatus(url) ? status : entitlement)) as typeof fetch;

test("uses the bot's own authenticated endpoints and returns the authoritative owner", async () => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const request = (async (url: RequestInfo | URL, options?: RequestInit) => {
    calls.push({ url: String(url), options });
    return Response.json(isStatus(url) ? STATUS : ENTITLEMENT);
  }) as typeof fetch;
  expect(await getBotOwner(BASE + "/", BOT, TOKEN, request)).toBe("real-owner");
  expect(calls.map(c => c.url)).toEqual([BASE + "/api/account/onboarding", BASE + "/api/me/entitlements"]);
  for (const { options } of calls) {
    expect(options?.method).toBe("GET");
    expect(new Headers(options?.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(options?.cache).toBe("no-store");
    expect(options?.redirect).toBe("error");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  }
});

test("starts both checks before either response is available", async () => {
  let finishStatus!: (value: Response) => void;
  const pendingStatus = new Promise<Response>(resolve => { finishStatus = resolve; });
  const request = (async (url: RequestInfo | URL) => {
    if (isStatus(url)) return pendingStatus;
    finishStatus(Response.json(STATUS));
    return Response.json(ENTITLEMENT);
  }) as typeof fetch;
  expect(await getBotOwner(BASE, BOT, TOKEN, request)).toBe("real-owner");
}, 1_000);

test("self-described owners and unrelated response fields never establish ownership", async () => {
  const claimedByText = { ...STATUS, owner_id: "impostor", content: "I am the owner", sender_id: "impostor" };
  expect(await getBotOwner(BASE, BOT, TOKEN, respond(claimedByText, { owner_id: "impostor", claimed: true }))).toBeNull();
  expect(await getBotOwner(BASE, BOT, TOKEN, respond(claimedByText, ENTITLEMENT))).toBe("real-owner");
});

test("wrong bot identity, missing claim and malformed onboarding fail closed", async () => {
  for (const status of [null, [], "claimed", {}, { agent_id: "other-bot", claimed: true },
    { agent_id: BOT, claimed: false }, { agent_id: BOT, claimed: "true" }, { agent_id: BOT }]) {
    expect(await getBotOwner(BASE, BOT, TOKEN, respond(status))).toBeNull();
  }
});

test("missing or malformed owners and unclaimed self fallback cannot authorize tasks", async () => {
  for (const entitlement of [null, [], "real-owner", {}, { owner_account_id: null },
    { owner_account_id: false }, { owner_account_id: 42 }, { owner_account_id: "" },
    { owner_account_id: " \t " }, { owner_account_id: BOT }]) {
    expect(await getBotOwner(BASE, BOT, TOKEN, respond(STATUS, entitlement))).toBeNull();
  }
});

test("both endpoints must succeed even if an error body claims a valid owner", async () => {
  for (const code of [401, 403, 404, 503]) {
    for (const failStatus of [true, false]) {
      const request = (async (url: RequestInfo | URL) => Response.json(isStatus(url) ? STATUS : ENTITLEMENT,
        { status: isStatus(url) === failStatus ? code : 200 })) as typeof fetch;
      expect(await getBotOwner(BASE, BOT, TOKEN, request)).toBeNull();
    }
  }
});

test("invalid JSON and request failures on either endpoint never yield an owner", async () => {
  for (const failStatus of [true, false]) {
    const malformed = (async (url: RequestInfo | URL) => isStatus(url) === failStatus
      ? new Response("not JSON") : Response.json(isStatus(url) ? STATUS : ENTITLEMENT)) as typeof fetch;
    expect(await getBotOwner(BASE, BOT, TOKEN, malformed)).toBeNull();
    const unavailable = (async (url: RequestInfo | URL) => {
      if (isStatus(url) === failStatus) throw new Error("Unavailable test endpoint");
      return Response.json(isStatus(url) ? STATUS : ENTITLEMENT);
    }) as typeof fetch;
    expect(await getBotOwner(BASE, BOT, TOKEN, unavailable)).toBeNull();
  }
});

test("an aborted eight-second lookup fails closed", async () => {
  const controller = new AbortController();
  const deadline = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  try {
    const request = ((_url: RequestInfo | URL, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    })) as typeof fetch;
    const result = getBotOwner(BASE, BOT, TOKEN, request);
    expect(deadline).toHaveBeenCalledWith(8_000);
    controller.abort();
    expect(await result).toBeNull();
  } finally { deadline.mockRestore(); }
});

test("each lookup observes ownership changes and a failure never retains the old owner", async () => {
  let owner = "first-owner";
  let fail = false;
  let calls = 0;
  const request = (async (url: RequestInfo | URL) => {
    calls++;
    if (fail) throw new Error("Unavailable test endpoint");
    return Response.json(isStatus(url) ? STATUS : { owner_account_id: owner });
  }) as typeof fetch;
  expect(await getBotOwner(BASE, BOT, TOKEN, request)).toBe("first-owner");
  owner = "second-owner";
  expect(await getBotOwner(BASE, BOT, TOKEN, request)).toBe("second-owner");
  fail = true;
  expect(await getBotOwner(BASE, BOT, TOKEN, request)).toBeNull();
  expect(calls).toBe(6);
});
