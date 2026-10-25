import { afterEach, describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MacpAckError, MacpSdkError, MacpTransportError, commitmentHash } from 'macp-sdk-typescript';
import { ToolArgumentError } from '../../src/bridge';
import { loadContract } from '../../src/contract';
import { buildServer, errorText } from '../../src/server';
import { VERSION } from '../../src/version';
import { SID, envelope, harness } from './fakes';

const contract = loadContract();

afterEach(() => {
  vi.restoreAllMocks();
});

async function connected(h = harness()) {
  const { server } = buildServer({ bridge: h.bridge, contract });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'unit', version: '0.0.0' });
  await client.connect(clientSide);
  return { client, h };
}

function text(result: { content: unknown }): string {
  return (result.content as { text: string }[])[0]!.text;
}

describe('contract surface', () => {
  it('lists the manifest tools verbatim, in manifest order', async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    expect(
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        annotations: t.annotations,
        inputSchema: t.inputSchema,
        outputSchema: t.outputSchema,
      })),
    ).toEqual(contract.tools);
  });

  it('reports the contract server name and instructions and the package version', async () => {
    const { client } = await connected();
    expect(client.getServerVersion()).toMatchObject({ name: 'macp-mcp', version: VERSION });
    expect(client.getInstructions()).toBe(contract.instructions);
  });

  it('pins the manifest shape both servers test against', () => {
    expect(contract.contract_version).toBe('1');
    expect(contract.server_name).toBe('macp-mcp');
    expect(contract.tools.map((t) => t.name)).toEqual([
      'commit',
      'evaluate',
      'get_commitment',
      'get_session',
      'propose',
      'start_session',
      'verify',
      'vote',
    ]);
    const raw = JSON.stringify(contract);
    for (const banned of ['"$ref"', '"$defs"', '"anyOf"', '"title"', '"$schema"']) expect(raw).not.toContain(banned);
  });

  it('refuses to build against a manifest tool it has no handler for', () => {
    const extra = { ...contract, tools: [...contract.tools, { ...contract.tools[0]!, name: 'nope' }] };
    expect(() => buildServer({ bridge: harness().bridge, contract: extra })).toThrow(/'nope' has no handler/);
  });
});

describe('tools/call', () => {
  const ajv = new Ajv2020({ strict: false });

  it('returns structuredContent unwrapped, matching the outputSchema, with the same JSON as text', async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: 'start_session',
      arguments: { intent: 'ship?', participants: ['bob'] },
    });
    expect(result.isError).toBeFalsy();
    const schema = contract.tools.find((t) => t.name === 'start_session')!.outputSchema;
    expect(ajv.validate(schema, result.structuredContent)).toBe(true);
    expect(JSON.parse(text(result))).toEqual(result.structuredContent);
    // ttl_ms defaulted by the manifest's schema (0 → server default).
    expect(result.structuredContent).toMatchObject({ ttl_ms: 300_000, participants: ['alice', 'bob'] });
  });

  it('serves a commitment and verifies it', async () => {
    const h = harness();
    const payload = {
      commitmentId: 'c',
      action: 'a',
      authorityScope: 's',
      reason: 'r',
      modeVersion: '1.0.0',
      policyVersion: 'p',
      configurationVersion: 'c',
      outcomePositive: true,
    };
    h.setHistory([envelope(h.client, 'Commitment', 'alice', payload)]);
    const { client } = await connected(h);
    const got = await client.callTool({ name: 'get_commitment', arguments: { session_id: SID } });
    expect(got.structuredContent).toMatchObject({ found: true, commitment_hash: commitmentHash(payload) });
    const verified = await client.callTool({
      name: 'verify',
      arguments: { commitment_hash: commitmentHash(payload), session_id: SID },
    });
    expect(verified.structuredContent).toMatchObject({ outcome: 'match' });
  });

  it('rejects arguments the manifest schema rejects', async () => {
    const { client } = await connected();
    const bad = await client.callTool({
      name: 'vote',
      arguments: { session_id: SID, proposal_id: 'p', vote: 'maybe' },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/^invalid arguments for vote: /);
    const missing = await client.callTool({ name: 'propose', arguments: { session_id: SID } });
    expect(text(missing)).toMatch(/must have required property/);
  });

  it('reports an unknown tool', async () => {
    const { client } = await connected();
    const result = await client.callTool({ name: 'nope', arguments: {} });
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toBe('Unknown tool: nope');
  });

  it('maps a runtime NACK to "<CODE>: <message>"', async () => {
    const h = harness();
    h.setAck((e) => {
      throw new MacpAckError({
        ok: false,
        duplicate: false,
        messageId: e.messageId,
        sessionId: e.sessionId,
        sessionState: 'SESSION_STATE_OPEN',
        error: { code: 'SESSION_NOT_OPEN', message: 'session is resolved' },
      });
    });
    const { client } = await connected(h);
    const result = await client.callTool({
      name: 'propose',
      arguments: { session_id: SID, proposal_id: 'p', option: 'o' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('SESSION_NOT_OPEN: session is resolved');
  });

  it('wraps an unanticipated failure', async () => {
    const h = harness();
    vi.spyOn(h.bridge, 'getSession').mockRejectedValue(new Error('kaboom'));
    const { client } = await connected(h);
    const result = await client.callTool({ name: 'get_session', arguments: { session_id: SID } });
    expect(text(result)).toBe('Error executing tool get_session: kaboom');
  });
});

describe('errorText', () => {
  const ack = (code: string, message: string) =>
    new MacpAckError({
      ok: false,
      duplicate: false,
      messageId: 'm',
      sessionId: SID,
      error: { code, message },
    } as never);

  it('prefixes the NACK code to the NACK message', () => {
    expect(errorText(ack('POLICY_DENIED', 'nope'))).toBe('POLICY_DENIED: nope');
  });

  it('prefers the macp-error-code trailer over the gRPC status for transport errors', () => {
    const err = new MacpTransportError('session not found', 'NOT_FOUND');
    expect(errorText(err)).toBe('NOT_FOUND: session not found');
    (err as { macpErrorCode?: string }).macpErrorCode = 'SESSION_NOT_FOUND';
    expect(errorText(err)).toBe('SESSION_NOT_FOUND: session not found');
  });

  it('does not repeat a code the message already starts with', () => {
    expect(errorText(new MacpTransportError('UNAVAILABLE: down', 'UNAVAILABLE'))).toBe('UNAVAILABLE: down');
  });

  it('shows SDK-side and argument errors as plain messages, and nothing for unknown errors', () => {
    expect(errorText(new MacpSdkError('bad input'))).toBe('bad input');
    expect(errorText(new ToolArgumentError('pick one'))).toBe('pick one');
    expect(errorText(new Error('x'))).toBeUndefined();
  });
});
