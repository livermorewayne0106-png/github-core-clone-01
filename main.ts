// main.ts — the entry side of the entry <-> env lifecycle.
//
// This file owns the process, not the application. The suite grades the HTTP
// server that app.ts builds; what happens here is fixed by the harness:
//
//   * The env's origin arrives in MAKEFUN_ENV_URL (for example
//     http://store:8080 inside a trial container). With no env there is
//     nobody to register with, so the process exits 1 immediately.
//   * The app listens on port 0 and the kernel picks a free port. Port 8080
//     belongs to the env and is never bound here.
//   * The chosen port is announced with POST $MAKEFUN_ENV_URL/register and a
//     JSON body of {"port": N}. The env notes the caller's address together
//     with N and treats that as the entry's base URL from then on. The first
//     registration stands: a 409 means another process registered first, and
//     this one simply carries on waiting like any other.
//   * GET $MAKEFUN_ENV_URL/done is polled until it answers {"done": true}.
//     The env replies at once ({"done": false} while the suite is running),
//     so each poll is short; a failed or slow one is retried after a brief
//     backoff, and the process never exits before the env says done.
//   * Once done arrives the server closes and the process exits 0, which
//     lets the harness stop the env and write the export the scorer reads.
//
// To keep that contract self-contained, this file imports the app factory
// and nothing else — no packages, no Node built-ins, no model calls.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One register or done request gets at most this long before it is dropped
// and retried.
const REQUEST_TIMEOUT_MS = 30_000;
// Retry waits grow exponentially from RETRY_INITIAL_MS up to RETRY_MAX_MS.
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The pause that follows the `attempt`-th consecutive failure.
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

// Announce the bound port to the env, retrying while the env may still be
// starting up. A 200 accepts the registration and a 409 means the first
// registration already won, so both end the loop normally. A 400 or 405 is a
// contract error the env will keep giving, so it is fatal. Any other outcome
// — an unreachable env, a timeout, an unexpected status — is retried.
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      // The contract error above is the only failure worth dying for; every
      // other one just means "not yet".
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

// Poll the env's /done endpoint until it reports the trial is over. This
// function only ever returns on {"done": true}.
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Silence from the env means "not done", never "give up".
    }
    await sleep(retryDelay(attempt));
  }
}

// The whole life of the process: bind, register, wait, close.
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
