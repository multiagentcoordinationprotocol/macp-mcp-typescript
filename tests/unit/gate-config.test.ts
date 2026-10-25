import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config';
import { loadGateConfig, matchRule, parseGateConfig, requiredApprovals, type GateConfig } from '../../src/gate/config';
import { settle } from '../../src/gate/approval';
import { parseGateArgs, upstreamEnv } from '../../src/gate/cli';

const rule = (tool: string, extra: Record<string, unknown> = {}) => ({
  tool,
  mode: 'macp.mode.quorum.v1',
  participants: ['alice', 'bob', 'carol'],
  ...extra,
});
const config = (...rules: object[]) => ({ version: 1, server: 'fs', rules });

describe('parseGateConfig', () => {
  it('accepts a valid policy', () => {
    const parsed = parseGateConfig(
      config(rule('write_*', { threshold: 2, ttl_ms: 1000, policy_version: 'p' })),
      'gate',
    );
    expect(parsed.rules[0]!.threshold).toBe(2);
  });

  it.each([
    ['a wrong version', { version: 2, server: 'fs', rules: [] }, /version/],
    ['a missing server', { version: 1, rules: [] }, /server/],
    ['an unknown key', { ...config(), extra: true }, /additional/],
    ['an unsupported mode', config(rule('x', { mode: 'macp.mode.task.v1' })), /mode/],
    ['no participants', config(rule('x', { participants: [] })), /participants/],
    ['a zero threshold', config(rule('x', { threshold: 0 })), /threshold/],
    ['an unknown rule key', config(rule('x', { quorum: 2 })), /additional/],
  ])('rejects %s', (_label, raw, message) => {
    expect(() => parseGateConfig(raw, 'gate')).toThrow(ConfigError);
    expect(() => parseGateConfig(raw, 'gate')).toThrow(message);
  });

  it('rejects a repeated participant, the gate itself, and a threshold above the participant count', () => {
    expect(() => parseGateConfig(config(rule('x', { participants: ['a', 'a'] })), 'gate')).toThrow(/participants/);
    expect(() => parseGateConfig(config(rule('x', { participants: ['a', 'gate'] })), 'gate')).toThrow(
      /gate's own agent id 'gate'/,
    );
    expect(() => parseGateConfig(config(rule('x', { threshold: 4 })), 'gate')).toThrow(/exceeds 3 participants/);
  });

  it('loads from a file and reports unreadable or non-JSON files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-config-'));
    const file = path.join(dir, 'gate.json');
    fs.writeFileSync(file, JSON.stringify(config(rule('x'))));
    expect(loadGateConfig(file, 'gate').server).toBe('fs');
    fs.writeFileSync(file, '{');
    expect(() => loadGateConfig(file, 'gate')).toThrow(/is not JSON/);
    expect(() => loadGateConfig(path.join(dir, 'missing.json'), 'gate')).toThrow(/cannot read gate policy/);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('matchRule', () => {
  const gate = parseGateConfig(
    config(rule('delete_file'), rule('write_*'), rule('file.?'), rule('*', { participants: ['root'] })),
    'gate',
  ) as GateConfig;

  it('matches exact names, then globs, first match winning', () => {
    expect(matchRule(gate, 'delete_file')?.tool).toBe('delete_file');
    expect(matchRule(gate, 'write_file')?.tool).toBe('write_*');
    expect(matchRule(gate, 'write_')?.tool).toBe('write_*');
    expect(matchRule(gate, 'file.a')?.tool).toBe('file.?');
    // `.` is literal and `?` is exactly one character.
    expect(matchRule(gate, 'fileXa')?.tool).toBe('*');
    expect(matchRule(gate, 'file.ab')?.tool).toBe('*');
  });

  it('is whole-name and case-sensitive; no match passes through', () => {
    const narrow = parseGateConfig(config(rule('write_*')), 'gate');
    expect(matchRule(narrow, 'Write_file')).toBeUndefined();
    expect(matchRule(narrow, 'rewrite_file')).toBeUndefined();
    expect(matchRule(narrow, 'read')).toBeUndefined();
  });
});

describe('requiredApprovals and settle', () => {
  it('defaults to a strict majority of the participants', () => {
    expect(requiredApprovals(rule('x', { participants: ['a'] }) as never)).toBe(1);
    expect(requiredApprovals(rule('x', { participants: ['a', 'b'] }) as never)).toBe(2);
    expect(requiredApprovals(rule('x') as never)).toBe(2);
    expect(requiredApprovals(rule('x', { threshold: 3 }) as never)).toBe(3);
  });

  it.each([
    [0, 0, 3, 2, undefined],
    [1, 1, 3, 2, undefined],
    [2, 2, 3, 2, 'approve'],
    [1, 2, 3, 2, undefined],
    [0, 2, 3, 2, 'deny'],
    [1, 3, 3, 2, 'deny'],
    [0, 1, 1, 1, 'deny'],
  ])('approvals=%i cast=%i approvers=%i required=%i → %s', (approvals, cast, approvers, required, expected) => {
    expect(settle(approvals, cast, approvers, required)).toBe(expected);
  });
});

describe('gate CLI arguments', () => {
  it('takes everything after --upstream as the upstream command line', () => {
    expect(parseGateArgs(['--policy', 'g.json', '--upstream', 'npx', '-y', 'srv', '--policy', 'x'])).toEqual({
      policy: 'g.json',
      upstream: { command: 'npx', args: ['-y', 'srv', '--policy', 'x'] },
    });
    expect(parseGateArgs(['--policy=g.json', '--upstream', 'srv'])).toEqual({
      policy: 'g.json',
      upstream: { command: 'srv', args: [] },
    });
  });

  it.each([
    [[], /--upstream <command>/],
    [['--policy', 'g.json'], /--upstream <command>/],
    [['--upstream', 'srv'], /--policy <gate.json> is required/],
    [['--policy', 'g.json', '--upstream'], /--upstream needs a command/],
    [['--policy'], /--policy needs a file/],
    [['--verbose'], /unknown gate argument/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseGateArgs(argv)).toThrow(message);
  });

  it("drops the gate's MACP credential from the upstream environment", () => {
    expect(upstreamEnv({ PATH: '/bin', MACP_AUTH_TOKEN: 'secret', MACP_AGENT_ID: 'gate', EMPTY: undefined })).toEqual({
      PATH: '/bin',
      MACP_AGENT_ID: 'gate',
    });
  });
});
