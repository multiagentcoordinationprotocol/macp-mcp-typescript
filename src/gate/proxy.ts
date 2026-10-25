/**
 * `macp-mcp gate`: an MCP server that proxies an upstream MCP server's tools
 * and puts the calls a gate policy names behind a MACP session.
 *
 * Tool definitions pass through verbatim. A call no rule matches is forwarded
 * untouched. A call a rule matches opens a session first (see
 * {@link GateApprover}) and reaches the upstream only if that session commits
 * `approve`; the forwarded result then carries the commitment under
 * `_meta["io.multiagentcoordinationprotocol/commitment"]`, alongside any
 * `_meta` keys the upstream set. A refused call is a tool error and the
 * upstream never sees it.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { errorText } from '../server';
import { VERSION } from '../version';
import type { GateApprover } from './approval';
import { GateRefusal, denied, type GateCommitment } from './approval';
import { matchRule, type GateConfig } from './config';
import { contextIdOf, gatePreimage } from './context-id';

export const GATE_META_KEY = 'io.multiagentcoordinationprotocol/commitment';
export const GATE_SERVER_NAME = 'macp-mcp-gate';

/** The part of an MCP `Client` connected to the upstream that the gate uses. */
export type Upstream = Pick<Client, 'request'>;

/** What the gate needs from its session runner (lets tests pass a fake). */
export type Approver = Pick<GateApprover, 'decide'>;

function refusalResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function withCommitment(result: CallToolResult, commitment: GateCommitment): CallToolResult {
  return { ...result, _meta: { ...(result._meta ?? {}), [GATE_META_KEY]: { ...commitment } } };
}

export function buildGateServer(options: { config: GateConfig; upstream: Upstream; approver: Approver }): Server {
  const { config, upstream, approver } = options;
  const server = new Server(
    { name: GATE_SERVER_NAME, title: 'MACP tool-call gate', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, (request) =>
    upstream.request({ method: 'tools/list', params: request.params }, ListToolsResultSchema),
  );

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const forward = (): Promise<CallToolResult> =>
      upstream.request(
        { method: 'tools/call', params: request.params },
        CallToolResultSchema,
      ) as Promise<CallToolResult>;
    const { name } = request.params;
    const rule = matchRule(config, name);
    if (!rule) return forward();

    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    let commitment: GateCommitment;
    try {
      const preimage = gatePreimage(config.server, name, args);
      commitment = await approver.decide(rule, {
        server: config.server,
        tool: name,
        preimage,
        contextId: contextIdOf(preimage),
      });
    } catch (err) {
      if (err instanceof GateRefusal) return refusalResult(`${err.code}: ${err.message}`);
      return refusalResult(errorText(err) ?? `Error gating tool ${name}: ${(err as Error)?.message ?? String(err)}`);
    }
    if (commitment.outcome !== 'approve') {
      const refusal = denied(commitment, name);
      return refusalResult(`${refusal.code}: ${refusal.message}`);
    }
    return withCommitment(await forward(), commitment);
  });

  return server;
}
