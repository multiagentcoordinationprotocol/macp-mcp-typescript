/**
 * W3.8 acceptance: `macp-mcp gate` in front of a stub upstream MCP server,
 * driven by a real MCP client over stdio, against a live runtime. Approvers
 * are plain SDK clients that find the gate's session by its context_id.
 *
 * - approve → the upstream is called; the result carries the commitment _meta
 * - reject  → POLICY_DENIED; the upstream is not called
 * - expire  → SESSION_NOT_OPEN; the upstream is not called
 *
 * Env: MACP_RUNTIME_ADDRESS (default localhost:50051), a dev-mode runtime.
 * Requires `npm run build` (dist/cli.js).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  Auth,
  DecisionSession,
  MacpClient,
  QuorumSession,
  verifyCommitmentHash,
  type SessionMetadata,
} from 'macp-sdk-typescript';
import { gateContextId } from '../../src/gate/context-id';

const RUNTIME = process.env.MACP_RUNTIME_ADDRESS ?? 'localhost:50051';
const ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const STUB = path.join(ROOT, 'tests', 'fixtures', 'stub-upstream.ts');
const SERVER = 'stub';
const META_KEY = 'io.multiagentcoordinationprotocol/commitment';

// Unique per run so reruns against a long-lived runtime never collide on context_id.
const RUN = `${Date.now()}`;

const GATE = {
  version: 1,
  server: SERVER,
  rules: [
    { tool: 'echo', mode: 'macp.mode.quorum.v1', participants: ['alice', 'bob'], threshold: 2, ttl_ms: 60_000 },
    { tool: 'dec*', mode: 'macp.mode.decision.v1', participants: ['alice', 'bob'], ttl_ms: 60_000 },
    { tool: 'slow?', mode: 'macp.mode.quorum.v1', participants: ['alice'], ttl_ms: 1_500 },
  ],
};

function approver(agentId: string): MacpClient {
  return new MacpClient({ address: RUNTIME, secure: false, allowInsecure: true, auth: Auth.devAgent(agentId) });
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

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as { type: string; text: string }[])[0]!.text;
}

describe('macp-mcp gate over stdio against a live runtime', () => {
  let tmp: string;
  let callLog: string;
  let gate: Client;
  let alice: MacpClient;
  let bob: MacpClient;

  const upstreamCalls = (): { name: string; arguments: Record<string, unknown> }[] =>
    fs.existsSync(callLog)
      ? fs
          .readFileSync(callLog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'macp-gate-'));
    callLog = path.join(tmp, 'calls.jsonl');
    const policy = path.join(tmp, 'gate.json');
    fs.writeFileSync(policy, JSON.stringify(GATE));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'gate', '--policy', policy, '--upstream', process.execPath, '--import', 'tsx', STUB],
      cwd: ROOT,
      env: {
        ...(process.env as Record<string, string>),
        MACP_RUNTIME_TARGET: RUNTIME,
        MACP_AGENT_ID: 'gate',
        MACP_ALLOW_INSECURE: '1',
        STUB_CALL_LOG: callLog,
      },
      stderr: 'inherit',
    });
    gate = new Client({ name: 'it-gate', version: '0.0.0' });
    await gate.connect(transport);
    alice = approver('alice');
    bob = approver('bob');
  });

  afterAll(async () => {
    await gate?.close();
    alice?.close();
    bob?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    if (fs.existsSync(callLog)) fs.rmSync(callLog);
  });

  it('lists the upstream tools verbatim', async () => {
    const { tools } = await gate.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo', 'add']);
    expect(gate.getServerVersion()?.name).toBe('macp-mcp-gate');
  });

  it('passes an ungated call straight through', async () => {
    const result = await gate.callTool({ name: 'add', arguments: { a: 2, b: 3 } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ sum: 5 });
    expect(result._meta?.[META_KEY]).toBeUndefined();
    expect(upstreamCalls()).toEqual([{ name: 'add', arguments: { a: 2, b: 3 } }]);
  });

  it('approve: forwards the call once the quorum approves, with the commitment in _meta', async () => {
    const args = { text: `ship ${RUN}` };
    const contextId = gateContextId(SERVER, 'echo', args);
    const pending = gate.callTool({ name: 'echo', arguments: args });

    const meta = await findSession(alice, contextId);
    expect(meta.mode).toBe('macp.mode.quorum.v1');
    expect(meta.initiator).toBe('gate');
    expect([...(meta.participants ?? [])]).toEqual(['alice', 'bob']);
    expect(upstreamCalls()).toEqual([]);
    await new QuorumSession(alice, { sessionId: meta.sessionId }).approve({ requestId: contextId });
    await new QuorumSession(bob, { sessionId: meta.sessionId }).approve({ requestId: contextId, reason: 'ok' });

    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect(text(result)).toBe(args.text);
    expect(result._meta?.['stub/seen']).toBe(true);
    const commitment = result._meta?.[META_KEY] as Record<string, string>;
    expect(commitment).toEqual({
      session_id: meta.sessionId,
      mode: 'macp.mode.quorum.v1',
      outcome: 'approve',
      commitment_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(upstreamCalls()).toEqual([{ name: 'echo', arguments: args }]);

    // The hash in _meta is the RFC-MACP-0013 hash of the Commitment the runtime recorded.
    const stream = alice.openStream();
    await stream.sendSubscribe(meta.sessionId!, 0);
    let wire: Buffer | undefined;
    while (!wire) {
      const envelope = await stream.read(5_000);
      if (envelope?.messageType === 'Commitment') wire = Buffer.from(envelope.payload);
    }
    stream.close();
    expect(verifyCommitmentHash(wire, commitment.commitment_hash)).toBe('match');
    expect((await alice.getSession(meta.sessionId!)).metadata.state).toBe('SESSION_STATE_RESOLVED');
  });

  it('reject: POLICY_DENIED once approval is out of reach; the upstream is not called', async () => {
    const args = { text: `drop table ${RUN}` };
    const contextId = gateContextId(SERVER, 'echo', args);
    const pending = gate.callTool({ name: 'echo', arguments: args });
    const meta = await findSession(bob, contextId);
    await new QuorumSession(bob, { sessionId: meta.sessionId }).reject({ requestId: contextId, reason: 'no' });

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^POLICY_DENIED: tool call \S+ denied by session \S+$/);
    expect(text(result)).toContain(meta.sessionId);
    expect(upstreamCalls()).toEqual([]);
    expect((await bob.getSession(meta.sessionId!)).metadata.state).toBe('SESSION_STATE_RESOLVED');
  });

  it('decision mode: a majority of approver votes forwards the call', async () => {
    const result = await (async () => {
      const args = { text: `decide ${RUN}` };
      const contextId = gateContextId(SERVER, 'decide', args);
      // `decide` matches the dec* rule but the stub has no such tool: the upstream's own error passes through.
      const pending = gate.callTool({ name: 'decide', arguments: args });
      const meta = await findSession(alice, contextId);
      expect(meta.mode).toBe('macp.mode.decision.v1');
      expect([...(meta.participants ?? [])]).toEqual(['gate', 'alice', 'bob']);
      await new DecisionSession(alice, { sessionId: meta.sessionId }).vote({ proposalId: 'call', vote: 'APPROVE' });
      await new DecisionSession(bob, { sessionId: meta.sessionId }).vote({ proposalId: 'call', vote: 'APPROVE' });
      return pending;
    })();
    expect((result._meta?.[META_KEY] as Record<string, string>).mode).toBe('macp.mode.decision.v1');
    expect(upstreamCalls().map((c) => c.name)).toEqual(['decide']);
  });

  it('expire: SESSION_NOT_OPEN when nobody votes before the TTL; the upstream is not called', async () => {
    const result = await gate.callTool({ name: 'slowly', arguments: {} });
    // `slowly` does not match `slow?`, so it passes through to the stub's unknown-tool error.
    expect(text(result)).toBe('unknown tool slowly');

    const started = Date.now();
    const expired = await gate.callTool({ name: 'slow1', arguments: { n: RUN } });
    expect(expired.isError).toBe(true);
    expect(text(expired)).toMatch(/^SESSION_NOT_OPEN: session \S+ ended (EXPIRED|CANCELLED) without a commitment$/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
    expect(upstreamCalls().map((c) => c.name)).toEqual(['slowly']);
  });
});
