/** `macp-mcp gate --policy <gate.json> --upstream <command> [args...]` (flags pinned by `contract/gate/cli.json`). */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defaultClientFactory } from '../bridge';
import { ConfigError, type Settings } from '../config';
import { VERSION } from '../version';
import { GateApprover } from './approval';
import { loadGateConfig } from './config';
import { buildGateServer } from './proxy';

export interface GateArgs {
  policy: string;
  upstream: { command: string; args: string[] };
}

/** Parse the arguments after `gate`. `--upstream` takes the rest of argv as the upstream's command line. */
export function parseGateArgs(argv: string[]): GateArgs {
  let policy: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--upstream') {
      const [command, ...args] = argv.slice(i + 1);
      if (!command) throw new ConfigError('--upstream needs a command');
      if (!policy) throw new ConfigError('--policy <gate.json> is required');
      return { policy, upstream: { command, args } };
    }
    if (arg === '--policy') {
      policy = argv[++i];
      if (!policy) throw new ConfigError('--policy needs a file');
    } else if (arg.startsWith('--policy=')) {
      policy = arg.slice('--policy='.length);
    } else {
      throw new ConfigError(`unknown gate argument '${arg}'`);
    }
  }
  throw new ConfigError('--upstream <command> [args...] is required');
}

/** The upstream's environment: the gate's own, minus the gate's MACP credential. */
export function upstreamEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key !== 'MACP_AUTH_TOKEN') out[key] = value;
  }
  return out;
}

export async function runGate(argv: string[], settings: Settings): Promise<void> {
  const args = parseGateArgs(argv);
  const config = loadGateConfig(args.policy, settings.agentId);
  process.stderr.write(
    `macp-mcp gate: server=${config.server} rules=${config.rules.length} upstream=${args.upstream.command}\n`,
  );

  const upstream = new Client({ name: 'macp-mcp-gate', version: VERSION });
  await upstream.connect(
    new StdioClientTransport({
      command: args.upstream.command,
      args: args.upstream.args,
      env: upstreamEnv(),
      stderr: 'inherit',
    }),
  );
  const client = defaultClientFactory(settings);
  const server = buildGateServer({ config, upstream, approver: new GateApprover(client, settings) });
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    client.close();
    void upstream.close();
  };
  await server.connect(transport);
}
