/**
 * MCP server exposing a MACP Decision session as tools.
 *
 * Built on the official MCP TypeScript SDK's low-level `Server` rather than
 * `McpServer`: `McpServer` derives schemas from zod, while this server must
 * advertise the exact JSON Schemas pinned in `contract/tools.json`, the
 * manifest the Python macp-mcp is generated from. Arguments are validated
 * against the same manifest schemas (with their defaults applied), and each
 * tool is a thin wrapper over {@link MacpBridge}.
 */

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MacpAckError, MacpSdkError, MacpTransportError } from 'macp-sdk-typescript';
import { MacpBridge, ToolArgumentError, defaultClientFactory, type ClientFactory } from './bridge';
import { loadContract, type Contract } from './contract';
import { defaultSettings, type Settings } from './config';
import { VERSION } from './version';

type Args = Record<string, unknown>;
type Handler = (bridge: MacpBridge, args: Args) => Promise<object>;

const HANDLERS: Record<string, Handler> = {
  start_session: (b, a) =>
    b.startSession(a.intent as string, a.participants as string[], a.ttl_ms as number, a.context_id as string),
  propose: (b, a) =>
    b.propose(a.session_id as string, a.proposal_id as string, a.option as string, a.rationale as string),
  evaluate: (b, a) =>
    b.evaluate(
      a.session_id as string,
      a.proposal_id as string,
      a.recommendation as string,
      a.confidence as number,
      a.reason as string,
    ),
  vote: (b, a) => b.vote(a.session_id as string, a.proposal_id as string, a.vote as string, a.reason as string),
  commit: (b, a) =>
    b.commit(
      a.session_id as string,
      a.action as string,
      a.authority_scope as string,
      a.reason as string,
      a.outcome_positive as boolean,
    ),
  get_session: (b, a) => b.getSession(a.session_id as string),
  get_commitment: (b, a) => b.getCommitment(a.session_id as string),
  verify: (b, a) => b.verify(a.commitment_hash as string, a.session_id as string, a.payload_b64 as string),
};

/**
 * The text an anticipated failure shows the model: `"<MACP_CODE>: <message>"`
 * for a runtime rejection, the plain message for argument and SDK-side
 * validation errors. Code precedence matches the Python server: the NACK's
 * `failure.code`, then the `macp-error-code` trailer, then the gRPC status
 * name. Returns undefined for unanticipated errors.
 */
export function errorText(err: unknown): string | undefined {
  const withCode = (code: string | undefined, message: string): string =>
    code && !message.startsWith(code) ? `${code}: ${message}` : message;
  if (err instanceof MacpAckError) return withCode(err.failure.code || err.macpErrorCode, err.failure.message);
  if (err instanceof MacpTransportError) return withCode(err.macpErrorCode ?? err.code, err.message);
  if (err instanceof MacpSdkError || err instanceof ToolArgumentError) return err.message;
  return undefined;
}

function textResult(text: string, isError: boolean): CallToolResult {
  return { content: [{ type: 'text', text }], isError };
}

export interface BuildServerOptions {
  settings?: Settings;
  clientFactory?: ClientFactory;
  contract?: Contract;
  /** Supply a bridge directly (tests); overrides settings/clientFactory. */
  bridge?: MacpBridge;
}

/** Build the MCP server for one MACP agent identity. */
export function buildServer(options: BuildServerOptions = {}): { server: Server; bridge: MacpBridge } {
  const contract = options.contract ?? loadContract();
  const bridge =
    options.bridge ??
    new MacpBridge(options.settings ?? defaultSettings(), options.clientFactory ?? defaultClientFactory);

  const ajv = new Ajv2020({ useDefaults: true, strict: false, allErrors: true });
  const validators = new Map<string, ValidateFunction>();
  for (const tool of contract.tools) {
    if (!HANDLERS[tool.name]) throw new Error(`contract tool '${tool.name}' has no handler`);
    validators.set(tool.name, ajv.compile(tool.inputSchema));
  }

  const server = new Server(
    {
      name: contract.server_name,
      title: 'MACP Decision sessions',
      version: VERSION,
      websiteUrl: 'https://multiagentcoordinationprotocol.io',
    },
    { capabilities: { tools: {} }, instructions: contract.instructions },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: contract.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      annotations: tool.annotations,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name } = request.params;
    const validate = validators.get(name);
    const handler = HANDLERS[name];
    if (!validate || !handler) return textResult(`Unknown tool: ${name}`, true);
    // structuredClone: ajv's useDefaults mutates the object it validates.
    const args = structuredClone(request.params.arguments ?? {}) as Args;
    if (!validate(args)) {
      return textResult(
        `invalid arguments for ${name}: ${ajv.errorsText(validate.errors, { dataVar: 'arguments' })}`,
        true,
      );
    }
    try {
      const result = await handler(bridge, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (err) {
      const text = errorText(err);
      if (text !== undefined) return textResult(text, true);
      return textResult(`Error executing tool ${name}: ${(err as Error)?.message ?? String(err)}`, true);
    }
  });

  return { server, bridge };
}
