#!/usr/bin/env node
/**
 * Example Muse wake receiver (NOT a production daemon).
 *
 * POST /wake with a signed wake payload (see src/wake.ts): verifies the
 * HMAC signature when MUSE_WAKE_SECRET is set, appends the payload to
 * the wake queue, and returns 200. A Muse host then picks queue entries
 * up in a later turn, replies via the bridge, and removes them.
 *
 *   MUSE_WAKE_SECRET=<shared-secret> MUSE_WAKE_QUEUE=/path/to/queue.jsonl \
 *     node scripts/muse-wake-receiver.mjs   # listens on 127.0.0.1:18766
 */
import { createServer } from "node:http";
import { appendWakeQueue, verifyWakeSignature, WAKE_SIG_HEADER } from "../src/wake.ts";

const PORT = Number(process.env.MUSE_WAKE_PORT ?? 18766);
const SECRET = process.env.MUSE_WAKE_SECRET ?? "";
const QUEUE = process.env.MUSE_WAKE_QUEUE ?? `${process.env.HOME}/.agentschat/muse-wake-queue.jsonl`;

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/wake") {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (SECRET) {
      const sig = req.headers[WAKE_SIG_HEADER];
      if (typeof sig !== "string" || !verifyWakeSignature(body, sig, [SECRET])) {
        res.writeHead(401);
        res.end("bad signature");
        return;
      }
    }
    try {
      const payload = JSON.parse(body);
      appendWakeQueue(QUEUE, payload);
      res.writeHead(200);
      res.end("queued");
    } catch {
      res.writeHead(400);
      res.end("bad payload");
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`muse wake receiver listening on 127.0.0.1:${PORT}, queue=${QUEUE}`);
});
