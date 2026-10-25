import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_AGENT_ID,
  DEFAULT_REPLAY_IDLE_MS,
  DEFAULT_TARGET,
  DEFAULT_TTL_MS,
  authFor,
  authMode,
  defaultSettings,
  loadSettings,
} from '../../src/config';

describe('loadSettings', () => {
  it('applies the documented defaults to an empty environment', () => {
    expect(loadSettings({})).toEqual({
      target: DEFAULT_TARGET,
      agentId: DEFAULT_AGENT_ID,
      token: undefined,
      allowInsecure: false,
      rootCertificates: undefined,
      defaultTtlMs: DEFAULT_TTL_MS,
      replayIdleMs: DEFAULT_REPLAY_IDLE_MS,
    });
    expect([DEFAULT_TARGET, DEFAULT_AGENT_ID, DEFAULT_TTL_MS, DEFAULT_REPLAY_IDLE_MS]).toEqual([
      '127.0.0.1:50051',
      'mcp-agent',
      300_000,
      1_000,
    ]);
  });

  it('reads and trims every variable', () => {
    const settings = loadSettings({
      MACP_RUNTIME_TARGET: ' rt:1 ',
      MACP_AGENT_ID: ' bob ',
      MACP_AUTH_TOKEN: ' tok ',
      MACP_ALLOW_INSECURE: ' YES ',
      MACP_DEFAULT_TTL_MS: '60000',
      MACP_REPLAY_IDLE_MS: '+250',
    });
    expect(settings).toMatchObject({
      target: 'rt:1',
      agentId: 'bob',
      token: 'tok',
      allowInsecure: true,
      defaultTtlMs: 60_000,
      replayIdleMs: 250,
    });
  });

  it.each(['1', 'true', 'on', 'Yes'])('treats MACP_ALLOW_INSECURE=%j as true', (v) => {
    expect(loadSettings({ MACP_ALLOW_INSECURE: v }).allowInsecure).toBe(true);
  });

  it.each(['0', 'false', 'no', ''])('treats MACP_ALLOW_INSECURE=%j as false', (v) => {
    expect(loadSettings({ MACP_ALLOW_INSECURE: v }).allowInsecure).toBe(false);
  });

  it.each([
    ['1.5', 'must be an integer'],
    ['abc', 'must be an integer'],
    ['0', 'must be positive'],
    ['-3', 'must be positive'],
  ])('rejects MACP_DEFAULT_TTL_MS=%j', (v, msg) => {
    expect(() => loadSettings({ MACP_DEFAULT_TTL_MS: v })).toThrow(ConfigError);
    expect(() => loadSettings({ MACP_DEFAULT_TTL_MS: v })).toThrow(msg);
  });

  it('reads a CA bundle', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macp-mcp-'));
    const file = path.join(dir, 'ca.pem');
    fs.writeFileSync(file, 'PEM');
    expect(loadSettings({ MACP_TLS_CA_FILE: file }).rootCertificates?.toString()).toBe('PEM');
  });

  it('rejects an unreadable CA bundle and a CA bundle with insecure', () => {
    expect(() => loadSettings({ MACP_TLS_CA_FILE: '/nonexistent/ca.pem' })).toThrow(/cannot read MACP_TLS_CA_FILE/);
    expect(() => loadSettings({ MACP_TLS_CA_FILE: '/x', MACP_ALLOW_INSECURE: '1' })).toThrow(/mutually exclusive/);
  });
});

describe('auth', () => {
  it('uses dev-agent auth without a token and bearer auth bound to the agent with one', () => {
    const dev = defaultSettings({ agentId: 'alice' });
    expect(authMode(dev)).toBe('dev-agent');
    expect(authFor(dev)).toEqual({ bearerToken: 'alice', senderHint: 'alice', expectedSender: 'alice' });
    const bearer = defaultSettings({ agentId: 'alice', token: 't' });
    expect(authMode(bearer)).toBe('bearer');
    expect(authFor(bearer)).toMatchObject({ bearerToken: 't', expectedSender: 'alice' });
  });
});
