/**
 * The gate's shared contract (`contract/gate/`), vendored byte-for-byte from
 * multiagentcoordinationprotocol/macp-mcp like `contract/tools.json`;
 * `make verify-contract` fails on drift.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Resolves from both `src/gate/` and `dist/gate/`. */
export const GATE_CONTRACT_DIR = path.join(__dirname, '..', '..', 'contract', 'gate');

export function loadGateSchema(): object {
  return JSON.parse(fs.readFileSync(path.join(GATE_CONTRACT_DIR, 'gate.schema.json'), 'utf8')) as object;
}

function readContract(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(GATE_CONTRACT_DIR, name), 'utf8')) as Record<string, unknown>;
}

const SESSION = readContract('session.json') as { refusals: { templates: Record<string, string> } };
const CLI = readContract('cli.json') as { server: { name: string; instructions: string } };

export type GateTemplate = 'denied' | 'policy_denied' | 'not_open' | 'unsafe_integer';

/** The server identity pinned by `cli.json`. */
export const GATE_SERVER = CLI.server;

/**
 * Renders a `session.json` refusal template: each `{name}` is replaced
 * literally, with no other formatting, as the contract requires.
 */
export function renderRefusal(template: GateTemplate, vars: Record<string, string>): string {
  return SESSION.refusals.templates[template]!.replace(/\{([a-z_]+)\}/g, (whole, key: string) => vars[key] ?? whole);
}
