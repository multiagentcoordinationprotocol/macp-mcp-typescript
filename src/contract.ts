/**
 * The cross-language tool contract (`contract/tools.json`).
 *
 * Vendored byte-for-byte from multiagentcoordinationprotocol/macp-mcp, where
 * the Python server generates it; `make verify-contract` (CI) fails on drift.
 * This server serves the manifest's descriptions, annotations and schemas
 * verbatim, so its advertised surface equals the contract by construction.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolContract {
  name: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: { type: 'object'; properties?: Record<string, object>; required?: string[] } & Record<string, unknown>;
  outputSchema: { type: 'object'; properties?: Record<string, object>; required?: string[] } & Record<string, unknown>;
}

export interface Contract {
  contract_version: string;
  json_schema_dialect: string;
  server_name: string;
  instructions: string;
  tools: ToolContract[];
}

/** Path of the vendored manifest; resolves from both `src/` and `dist/`. */
export const CONTRACT_PATH = path.join(__dirname, '..', 'contract', 'tools.json');

export function loadContract(file: string = CONTRACT_PATH): Contract {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Contract;
}
