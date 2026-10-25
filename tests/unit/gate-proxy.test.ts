import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MacpAckError, type Ack } from 'macp-sdk-typescript';
import { GateRefusal, type GateCommitment } from '../../src/gate/approval';
import { parseGateConfig } from '../../src/gate/config';
import { contextIdOf, gatePreimage } from '../../src/gate/context-id';
import { GATE_META_KEY, buildGateServer, type Approver, type Upstream } from '../../src/gate/proxy';

const config = parseGateConfig(
  {
    version: 1,
    server: 'fs',
    rules: [{ tool: 'write_*', mode: 'macp.mode.quorum.v1', participants: ['alice'] }],
  },
  'gate',
);

const COMMITMENT: GateCommitment = {
  session_id: 'sess-1',
  mode: 'macp.mode.quorum.v1',
  outcome: 'approve',
  commitment_hash: `sha256:${'a'.repeat(64)}`,
};

async function connect(decide: Approver['decide']) {
  const upstreamRequest = vi.fn(async (req: { method: string; params?: Record<string, unknown> }) => {
    if (req.method === 'tools/list') {
      return { tools: [{ name: 'write_file', inputSchema: { type: 'object' } }], nextCursor: 'c2' };
    }
    return { content: [{ type: 'text', text: `did ${String(req.params?.name)}` }], _meta: { 'up/k': 1 } };
  });
  const approver = { decide: vi.fn(decide) };
  const server = buildGateServer({ config, upstream: { request: upstreamRequest } as unknown as Upstream, approver });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  return { client, upstreamRequest, approver };
}

const text = (r: { content: unknown }) => (r.content as { text: string }[])[0]!.text;

describe('gate proxy', () => {
  it('passes tools/list through verbatim, cursor included', async () => {
    const { client, upstreamRequest } = await connect(async () => COMMITMENT);
    const listed = await client.listTools({ cursor: 'c1' });
    expect(listed).toEqual({ tools: [{ name: 'write_file', inputSchema: { type: 'object' } }], nextCursor: 'c2' });
    expect(upstreamRequest.mock.calls[0]![0]).toEqual({ method: 'tools/list', params: { cursor: 'c1' } });
    expect(client.getServerVersion()?.name).toBe('macp-mcp-gate');
  });

  it('forwards an ungated call untouched, without opening a session', async () => {
    const { client, upstreamRequest, approver } = await connect(async () => COMMITMENT);
    const result = await client.callTool({ name: 'read_file', arguments: { p: 1 } });
    expect(result).toEqual({ content: [{ type: 'text', text: 'did read_file' }], _meta: { 'up/k': 1 } });
    expect(approver.decide).not.toHaveBeenCalled();
    expect(upstreamRequest).toHaveBeenCalledOnce();
  });

  it('forwards an approved call and adds the commitment beside the upstream _meta', async () => {
    const { client, approver } = await connect(async () => COMMITMENT);
    const result = await client.callTool({ name: 'write_file', arguments: { path: '/x' } });
    expect(result._meta).toEqual({ 'up/k': 1, [GATE_META_KEY]: COMMITMENT });
    expect(text(result)).toBe('did write_file');
    const preimage = gatePreimage('fs', 'write_file', { path: '/x' });
    expect(approver.decide).toHaveBeenCalledWith(config.rules[0], {
      server: 'fs',
      tool: 'write_file',
      preimage,
      contextId: contextIdOf(preimage),
    });
  });

  it('refuses a denied call with POLICY_DENIED and never calls the upstream', async () => {
    const { client, upstreamRequest } = await connect(async () => ({ ...COMMITMENT, outcome: 'deny' }));
    const result = await client.callTool({ name: 'write_file', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      `POLICY_DENIED: tool call write_file denied by session sess-1 (commitment ${COMMITMENT.commitment_hash})`,
    );
    expect(upstreamRequest).not.toHaveBeenCalled();
  });

  it('renders a GateRefusal and other MACP errors as "<CODE>: <message>"', async () => {
    let next: unknown = new GateRefusal('SESSION_NOT_OPEN', 'session s ended EXPIRED without a commitment', 's');
    const { client, upstreamRequest } = await connect(async () => {
      throw next;
    });
    expect(text(await client.callTool({ name: 'write_a', arguments: {} }))).toBe(
      'SESSION_NOT_OPEN: session s ended EXPIRED without a commitment',
    );
    next = new MacpAckError({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'bad token' } } as Ack);
    expect(text(await client.callTool({ name: 'write_a', arguments: {} }))).toBe('UNAUTHENTICATED: bad token');
    next = new Error('boom');
    expect(text(await client.callTool({ name: 'write_a', arguments: {} }))).toBe('Error gating tool write_a: boom');
    expect(upstreamRequest).not.toHaveBeenCalled();
  });
});
