#!/usr/bin/env node
/** Entry point: `macp-mcp` (stdio transport). stdout carries only the MCP protocol; everything else goes to stderr. */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configureLogging } from 'macp-sdk-typescript';
import { ConfigError, authMode, loadSettings, type Settings } from './config';
import { buildServer } from './server';

async function main(): Promise<void> {
  // The SDK's default sink sends debug/info to console.log, i.e. stdout; route every level to stderr.
  configureLogging({
    sink: (level, args) =>
      process.stderr.write(
        `[macp-sdk] ${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`,
      ),
  });
  let settings: Settings;
  try {
    settings = loadSettings();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`macp-mcp: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  process.stderr.write(
    `macp-mcp: agent=${settings.agentId} runtime=${settings.target} ` +
      `auth=${authMode(settings)} tls=${settings.allowInsecure ? 'off' : 'on'}\n`,
  );
  const { server, bridge } = buildServer({ settings });
  const transport = new StdioServerTransport();
  transport.onclose = () => bridge.close();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(`macp-mcp: ${(err as Error)?.stack ?? String(err)}\n`);
  process.exit(1);
});
