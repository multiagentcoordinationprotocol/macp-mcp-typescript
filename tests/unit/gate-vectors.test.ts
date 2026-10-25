import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GATE_CONTRACT_DIR } from '../../src/gate/contract';
import { contextIdOf, gatePreimage } from '../../src/gate/context-id';
import { hasUnsafeInteger } from '../../src/gate/jcs';
import { refusal } from '../../src/gate/approval';

interface Vector {
  name: string;
  input: { server: string; tool: string; arguments?: Record<string, unknown> };
  preimage?: string;
  context_id?: string;
  expected_error?: string;
}

const { vectors } = JSON.parse(fs.readFileSync(path.join(GATE_CONTRACT_DIR, 'context-id-vectors.json'), 'utf8')) as {
  vectors: Vector[];
};

describe('contract/gate/context-id-vectors.json', () => {
  it.each(vectors.filter((v) => v.expected_error === undefined))('$name', (v) => {
    expect(hasUnsafeInteger(v.input.arguments ?? {})).toBe(false);
    const preimage = gatePreimage(v.input.server, v.input.tool, v.input.arguments);
    expect(preimage).toBe(v.preimage);
    expect(contextIdOf(preimage)).toBe(v.context_id);
  });

  it.each(vectors.filter((v) => v.expected_error !== undefined))('$name is refused', (v) => {
    expect(hasUnsafeInteger(v.input.arguments ?? {})).toBe(true);
    const err = refusal('unsafe_integer', { tool: v.input.tool });
    expect(`${err.code}: ${err.message}`).toBe(v.expected_error);
  });
});
