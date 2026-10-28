/**
 * Host half of agentschat-identity (generation 2).
 *
 * The Client module owns everything the user sees; this half exists so the row
 * mounts in the Loader (which is also how `dsh.client` is discovered). It also
 * writes a one-line liveness marker, because "the chip is not on screen" has two
 * very different causes — the row never loaded, or the browser module never ran
 * — and without a marker from each half there is no way to tell them apart.
 */
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function apply() {
  try {
    appendFileSync(
      join(homedir(), '.dsh', 'agentschat-identity-host.log'),
      `${new Date().toISOString()} host half applied\n`,
    );
  } catch {}
}
