#!/usr/bin/env node
/**
 * Entry point (stdio transport): `macp-mcp` serves the Decision tools;
 * `macp-mcp gate ...` proxies an upstream MCP server behind gate rules.
 * stdout carries only the MCP protocol; everything else goes to stderr.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configureLogging } from 'macp-sdk-typescript';
import { ConfigError, authMode, loadSettings, type Settings } from './config';
import { runGate } from './gate/cli';
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
  const [command, ...rest] = process.argv.slice(2);
  try {
    settings = loadSettings();
    if (command === 'gate') {
      process.stderr.write(
        `macp-mcp gate: agent=${settings.agentId} runtime=${settings.target} ` +
          `auth=${authMode(settings)} tls=${settings.allowInsecure ? 'off' : 'on'}\n`,
      );
      await runGate(rest, settings);
      return;
    }
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
