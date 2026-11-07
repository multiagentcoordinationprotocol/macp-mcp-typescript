/**
 * Gate rules bound to an RFC-MACP-0012 policy stricter than the rule itself
 * (parity with macp-mcp tests/integration/test_gate_policy.py).
 *
 * Each rule names, through `policy_version`, a policy registered on the
 * runtime that needs two approvals, while the rule's own `threshold` is one.
 * One approval satisfies the gate's tally, so the gate commits `approve` and
 * the runtime refuses it. Whatever the refusal, the call must be refused, the
 * gate must cancel the session (so it does not linger OPEN until its TTL), and
 * the upstream must never be called.
 *
 * - Decision: the policy's vote quorum denies the Commitment with
 *   POLICY_DENIED, rendered with the `policy_denied` template
 *   (contract/gate/session.json).
 * - Quorum: runtime 0.14.0 folds a policy `threshold` into the mode's own
 *   commitment-readiness check, so the Commitment is refused as
 *   INVALID_ENVELOPE before policy evaluation; the gate surfaces that code
 *   as-is (the contract's `other` case).
 *
 * Env: MACP_RUNTIME_ADDRESS (default localhost:50051), a dev-mode runtime.
 * Requires `npm run build` (dist/cli.js).
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Auth, DecisionSession, MacpClient, QuorumSession, type SessionMetadata } from 'macp-sdk-typescript';
import { gateContextId } from '../../src/gate/context-id';

const RUNTIME = process.env.MACP_RUNTIME_ADDRESS ?? 'localhost:50051';
const ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const STUB = path.join(ROOT, 'tests', 'fixtures', 'stub-upstream.ts');
const SERVER = 'stub';
const SESSION_CONTRACT = JSON.parse(fs.readFileSync(path.join(ROOT, 'contract', 'gate', 'session.json'), 'utf8'));
const MODE_DECISION = 'macp.mode.decision.v1';
const MODE_QUORUM = 'macp.mode.quorum.v1';
type Mode = typeof MODE_DECISION | typeof MODE_QUORUM;

/** Runtime policy rules needing two approvals, per mode. */
const STRICT_RULES: Record<Mode, unknown> = {
  [MODE_DECISION]: {
    voting: { algorithm: 'majority', quorum: { type: 'count', value: 2 } },
    commitment: { require_vote_quorum: true },
  },
  [MODE_QUORUM]: { threshold: { type: 'n_of_m', value: 2 } },
};

interface Outcome {
  isError: boolean;
  text: string;
  session: SessionMetadata;
  upstreamCalls: string[];
}

async function findSession(client: MacpClient, contextId: string): Promise<SessionMetadata> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const found = (await client.listSessions()).find((s) => s.contextId === contextId);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no session with context_id ${contextId}`);
}

async function run(mode: Mode): Promise<Outcome> {
  // Unique per run: a long-lived runtime keeps policies, and the context_id
  // (hence the session lookup) depends on the arguments.
  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  const policyId = `policy.macp-mcp-ts.it.gate-strict.${mode.split('.')[2]}.${id}`;
  const args = { text: `write ${id}` };
  const contextId = gateContextId(SERVER, 'echo', args);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'macp-gate-policy-'));
  const callLog = path.join(tmp, 'calls.jsonl');
  const policyPath = path.join(tmp, 'gate.json');
  fs.writeFileSync(
    policyPath,
    JSON.stringify({
      version: 1,
      server: SERVER,
      rules: [
        { tool: 'echo', mode, participants: ['alice', 'bob'], threshold: 1, ttl_ms: 60_000, policy_version: policyId },
      ],
    }),
  );
  const alice = new MacpClient({ address: RUNTIME, secure: false, allowInsecure: true, auth: Auth.devAgent('alice') });
  const gate = new Client({ name: 'it-gate-policy', version: '0.0.0' });
  try {
    const registered = await alice.registerPolicy({
      policyId,
      mode,
      description: "Two approvals, stricter than the gate rule's one.",
      rules: JSON.stringify(STRICT_RULES[mode]),
      schemaVersion: 1,
    });
    expect(registered.ok, registered.error).toBe(true);

    await gate.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI, 'gate', '--policy', policyPath, '--upstream', process.execPath, '--import', 'tsx', STUB],
        cwd: ROOT,
        env: {
          ...(process.env as Record<string, string>),
          MACP_RUNTIME_TARGET: RUNTIME,
          MACP_AGENT_ID: 'gate',
          MACP_ALLOW_INSECURE: '1',
          STUB_CALL_LOG: callLog,
        },
        stderr: 'inherit',
      }),
    );
    const pending = gate.callTool({ name: 'echo', arguments: args });
    const meta = await findSession(alice, contextId);
    if (mode === MODE_QUORUM) {
      await new QuorumSession(alice, { sessionId: meta.sessionId }).approve({ requestId: contextId });
    } else {
      await new DecisionSession(alice, { sessionId: meta.sessionId }).vote({ proposalId: 'call', vote: 'APPROVE' });
    }
    const result = await pending;
    const session = await findSession(alice, contextId);
    return {
      isError: result.isError === true,
      text: (result.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join(''),
      session,
      upstreamCalls: fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').split('\n').filter(Boolean) : [],
    };
  } finally {
    await gate.close();
    alice.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe.each([
  ['decision', MODE_DECISION],
  ['quorum', MODE_QUORUM],
] as const)('gate rule bound to a stricter runtime policy (%s)', (_name, mode) => {
  let outcome: Outcome;

  beforeAll(async () => {
    outcome = await run(mode);
  }, 60_000);

  it('refuses the call with the runtime code', () => {
    expect(outcome.isError).toBe(true);
    if (mode === MODE_DECISION) {
      const prefix = (SESSION_CONTRACT.refusals.templates.policy_denied as string).split('{')[0]!;
      expect(outcome.text.startsWith(prefix), outcome.text).toBe(true);
      // The runtime's denial, not the gate's own "denied by session" refusal.
      expect(outcome.text).not.toContain('denied by session');
    } else {
      expect(outcome.text.startsWith('INVALID_ENVELOPE: '), outcome.text).toBe(true);
    }
  });

  it('cancels the refused session', () => {
    expect(outcome.session.mode).toBe(mode);
    expect(outcome.session.initiator).toBe('gate');
    expect(outcome.session.state).toBe('SESSION_STATE_CANCELLED');
  });

  it('never calls the upstream', () => {
    expect(outcome.upstreamCalls).toEqual([]);
  });
});
