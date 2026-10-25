/**
 * The gate policy file (`gate.json`): which upstream tool calls need a MACP
 * session's approval, and how that session is run. Validated against
 * `contract/gate/gate.schema.json`, shared byte-for-byte with the Python
 * macp-mcp.
 */

import * as fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020';
import type { MODE_DECISION, MODE_QUORUM } from 'macp-sdk-typescript';
import { ConfigError } from '../config';
import { loadGateSchema } from './contract';

export type GateMode = typeof MODE_QUORUM | typeof MODE_DECISION;

export interface GateRule {
  /** Exact tool name, or a glob where `*` matches any run of characters and `?` one character. */
  tool: string;
  mode: GateMode;
  /** The approvers. */
  participants: string[];
  /** Approvals needed; defaults to a strict majority of `participants`. */
  threshold?: number;
  ttl_ms?: number;
  policy_version?: string;
}

export interface GateConfig {
  version: 1;
  /** The upstream's name, bound into every gated call's context_id. */
  server: string;
  rules: GateRule[];
}

/** `ttl_ms` when a rule omits it. */
export const GATE_DEFAULT_TTL_MS = 300_000;

/**
 * Validate a parsed gate policy for the gate acting as `agentId`, beyond the
 * schema: participants are unique, never the gate itself (it initiates and
 * commits, it does not approve), and `threshold` is within 1..=participants.
 */
export function parseGateConfig(raw: unknown, agentId: string): GateConfig {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(loadGateSchema());
  if (!validate(raw))
    throw new ConfigError(`invalid gate policy: ${ajv.errorsText(validate.errors, { dataVar: 'gate' })}`);
  const config = raw as GateConfig;
  for (const [i, rule] of config.rules.entries()) {
    const n = new Set(rule.participants).size;
    if (n !== rule.participants.length) throw new ConfigError(`invalid gate policy: rules[${i}] repeats a participant`);
    if (rule.participants.includes(agentId)) {
      throw new ConfigError(
        `invalid gate policy: rules[${i}].participants includes the gate's own agent id '${agentId}'`,
      );
    }
    if (rule.threshold !== undefined && rule.threshold > n) {
      throw new ConfigError(`invalid gate policy: rules[${i}].threshold ${rule.threshold} exceeds ${n} participants`);
    }
  }
  return config;
}

export function loadGateConfig(file: string, agentId: string): GateConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read gate policy '${file}': ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`gate policy '${file}' is not JSON: ${(err as Error).message}`);
  }
  return parseGateConfig(raw, agentId);
}

function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 's');
}

/** The first rule whose `tool` matches, or undefined (the call passes through). */
export function matchRule(config: GateConfig, tool: string): GateRule | undefined {
  return config.rules.find((rule) => rule.tool === tool || globToRegExp(rule.tool).test(tool));
}

/** Approvals a rule needs: its `threshold`, else a strict majority of its approvers. */
export function requiredApprovals(rule: GateRule): number {
  return rule.threshold ?? Math.floor(rule.participants.length / 2) + 1;
}
