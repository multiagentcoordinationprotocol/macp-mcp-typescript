/**
 * Poll a MACP runtime with the Initialize RPC until it responds, or fail
 * after a timeout budget. Used in CI to gate `npm run test:integration` on
 * the runtime service container actually being ready to accept requests --
 * a fixed `sleep` would either be flaky (slow image pull / cold start) or
 * wastefully long, and a bare TCP check would pass before the gRPC server
 * has finished registering services.
 *
 * Usage:
 *   npx tsx scripts/wait-for-runtime.ts
 *
 * Env:
 *   MACP_RUNTIME_ADDRESS   gRPC address to poll (default localhost:50051)
 *   MACP_WAIT_TIMEOUT_MS   overall budget in ms (default 60000)
 */
import { Auth, MacpClient } from 'macp-sdk-typescript';

const address = process.env.MACP_RUNTIME_ADDRESS ?? 'localhost:50051';
const timeoutMs = Number(process.env.MACP_WAIT_TIMEOUT_MS ?? 60_000);
const attemptTimeoutMs = 2_000;
const intervalMs = 500;

async function poll(): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    const client = new MacpClient({
      address,
      secure: false,
      allowInsecure: true,
      auth: Auth.devAgent('ci-readiness-probe'),
    });
    try {
      await client.initialize(attemptTimeoutMs);
      client.close();
      console.log(`macp-runtime ready at ${address} after ${attempts} attempt(s)`);
      return;
    } catch (err) {
      lastError = err;
      client.close();
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  console.error(`macp-runtime at ${address} did not become ready within ${timeoutMs}ms (${attempts} attempts)`);
  if (lastError) console.error(lastError);
  process.exit(1);
}

poll();
