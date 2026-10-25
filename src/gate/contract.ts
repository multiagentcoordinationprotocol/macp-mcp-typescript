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
