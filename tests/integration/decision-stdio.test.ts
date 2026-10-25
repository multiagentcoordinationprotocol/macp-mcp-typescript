/**
 * End-to-end acceptance (W2.6, mirrors the Python macp-mcp's): two macp-mcp
 * processes, one per MACP agent, each driven by a real MCP client over stdio,
 * run a Decision session against a live runtime to RESOLVED and verify the
 * commitment hash. Every structuredContent is also validated against the
 * contract's outputSchema.
 *
 * Env: MACP_RUNTIME_ADDRESS (default localhost:50051), a dev-mode runtime
 * (MACP_ALLOW_INSECURE=1). Requires `npm run build` (dist/cli.js).
 */

import * as path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadContract } from '../../src/contract';

const RUNTIME = process.env.MACP_RUNTIME_ADDRESS ?? 'localhost:50051';
const CLI = path.join(__dirname, '..', '..', 'dist', 'cli.js');
const contract = loadContract();
const ajv = new Ajv2020({ strict: false, allErrors: true });
const outputValidators = new Map(contract.tools.map((t) => [t.name, ajv.compile(t.outputSchema)]));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are asserted structurally below
type Result = Record<string, any>;

async function connect(agentId: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI],
    env: {
      ...(process.env as Record<string, string>),
      MACP_RUNTIME_TARGET: RUNTIME,
      MACP_AGENT_ID: agentId,
      MACP_ALLOW_INSECURE: '1',
    },
    stderr: 'inherit',
  });
  const client = new Client({ name: `it-${agentId}`, version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Result> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  const structured = result.structuredContent as Result;
  const validate = outputValidators.get(name)!;
  expect(validate(structured), `${name} output: ${ajv.errorsText(validate.errors)}`).toBe(true);
  // Text content is the same JSON as structuredContent.
  const text = (result.content as { type: string; text: string }[])[0]!.text;
  expect(JSON.parse(text)).toEqual(structured);
  return structured;
}

async function callError(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return (result.content as { type: string; text: string }[])[0]!.text;
}

describe('macp-mcp over stdio against a live runtime', () => {
  let alice: Client;
  let bob: Client;

  beforeAll(async () => {
    [alice, bob] = await Promise.all([connect('alice'), connect('bob')]);
  });

  afterAll(async () => {
    await Promise.all([alice?.close(), bob?.close()]);
  });

  it('advertises exactly the contract surface', async () => {
    const { tools } = await alice.listTools();
    const listed = [...tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        annotations: t.annotations,
        inputSchema: t.inputSchema,
        outputSchema: t.outputSchema,
      }));
    expect(listed).toEqual(contract.tools);
    expect(alice.getServerVersion()?.name).toBe('macp-mcp');
    expect(alice.getInstructions()).toBe(contract.instructions);
  });

  it('runs a Decision session to RESOLVED and verifies the commitment', async () => {
    const started = await call(alice, 'start_session', {
      intent: 'Ship release 1.2?',
      participants: ['bob'],
    });
    expect(started).toMatchObject({
      ok: true,
      initiator: 'alice',
      participants: ['alice', 'bob'],
      mode: 'macp.mode.decision.v1',
      session_state: 'OPEN',
      ttl_ms: 300_000,
    });
    const sessionId = started.session_id as string;

    await call(alice, 'propose', { session_id: sessionId, proposal_id: 'p1', option: 'ship', rationale: 'green CI' });
    await call(bob, 'evaluate', {
      session_id: sessionId,
      proposal_id: 'p1',
      recommendation: 'APPROVE',
      confidence: 0.9,
    });
    const aliceVote = await call(alice, 'vote', { session_id: sessionId, proposal_id: 'p1', vote: 'APPROVE' });
    expect(aliceVote).toMatchObject({ ok: true, vote: 'APPROVE', sender: 'alice', proposal_id: 'p1' });
    await call(bob, 'vote', { session_id: sessionId, proposal_id: 'p1', vote: 'APPROVE', reason: 'lgtm' });

    // A runtime rejection surfaces as "<MACP_CODE>: <message>".
    const dup = await callError(bob, 'vote', { session_id: sessionId, proposal_id: 'p1', vote: 'REJECT' });
    expect(dup).toMatch(/^[A-Z_]+: /);

    // Bob never started the session but reads the full shared history.
    const view = await call(bob, 'get_session', { session_id: sessionId });
    expect(view).toMatchObject({
      state: 'OPEN',
      initiator: 'alice',
      you: 'bob',
      approve_totals: { p1: 2 },
      majority_winner: 'p1',
      blocking_objection: false,
      committed: false,
    });
    expect(view.votes).toHaveLength(2);
    expect(view.evaluations).toHaveLength(1);

    const open = await call(alice, 'get_commitment', { session_id: sessionId });
    expect(open).toEqual({ session_id: sessionId, state: 'OPEN', found: false });

    // Under the default policy only the initiator may commit.
    const forbidden = await callError(bob, 'commit', {
      session_id: sessionId,
      action: 'release.approved',
      authority_scope: 'release',
      reason: 'not mine to make',
    });
    expect(forbidden).toMatch(/^FORBIDDEN: /);

    const committed = await call(alice, 'commit', {
      session_id: sessionId,
      action: 'release.approved',
      authority_scope: 'release',
      reason: 'p1 won the vote',
    });
    expect(committed).toMatchObject({ ok: true, session_state: 'RESOLVED', sender: 'alice' });

    const commitment = await call(bob, 'get_commitment', { session_id: sessionId });
    expect(commitment).toMatchObject({
      state: 'RESOLVED',
      found: true,
      sender: 'alice',
      hash_label: 'macp-commitment-hash/1',
      commitment: { action: 'release.approved', authority_scope: 'release', outcome_positive: true },
    });
    expect(commitment.commitment_hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const fromHistory = await call(bob, 'verify', {
      commitment_hash: commitment.commitment_hash,
      session_id: sessionId,
    });
    expect(fromHistory).toEqual({
      outcome: 'match',
      claimed_hash: commitment.commitment_hash,
      recomputed_hash: commitment.commitment_hash,
      hash_label: 'macp-commitment-hash/1',
      source: 'runtime_history',
      session_id: sessionId,
    });

    const fromBytes = await call(alice, 'verify', {
      commitment_hash: commitment.commitment_hash,
      payload_b64: commitment.payload_b64,
    });
    expect(fromBytes).toMatchObject({ outcome: 'match', source: 'payload_b64' });
    expect(fromBytes).not.toHaveProperty('session_id');

    const tampered = `sha256:${'0'.repeat(64)}`;
    const mismatch = await call(alice, 'verify', { commitment_hash: tampered, payload_b64: commitment.payload_b64 });
    expect(mismatch).toMatchObject({ outcome: 'mismatch', recomputed_hash: commitment.commitment_hash });

    // RESOLVED accepts nothing further.
    const late = await callError(bob, 'propose', { session_id: sessionId, proposal_id: 'p2', option: 'wait' });
    expect(late).toMatch(/^[A-Z_]+: /);
  });

  it('rejects verify without exactly one source', async () => {
    const text = await callError(alice, 'verify', { commitment_hash: `sha256:${'0'.repeat(64)}` });
    expect(text).toBe('pass exactly one of session_id or payload_b64');
  });
});
