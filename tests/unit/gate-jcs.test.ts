import { describe, expect, it } from 'vitest';
import { CanonicalizationError, canonicalize } from '../../src/gate/jcs';
import { contextIdOf, gateContextId, gatePreimage } from '../../src/gate/context-id';

describe('canonicalize (RFC 8785)', () => {
  it('sorts members by UTF-16 code units (RFC 8785 §3.2.3 example)', () => {
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      דּ: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    };
    const keys = Object.keys(JSON.parse(canonicalize(input)));
    // JSON.parse reorders integer-like keys, so check the raw text order instead.
    expect(keys).toHaveLength(7);
    const order = ['\\r', '1', '\u0080', 'ö', '€', '😀', 'דּ'];
    const text = canonicalize(input);
    const positions = order.map((k) => text.indexOf(`"${k}"`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('formats numbers as ECMAScript does (RFC 8785 §3.2.2.3 example)', () => {
    expect(canonicalize([333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001])).toBe(
      '[333333333.3333333,1e+30,4.5,0.002,1e-27]',
    );
    expect(canonicalize([-0, 1e21, 1e-7, 100])).toBe('[0,1e+21,1e-7,100]');
  });

  it('escapes strings minimally and nests without whitespace', () => {
    expect(canonicalize({ b: [true, null, { d: 'x"\\\n\u0001 ' }], a: {} })).toBe(
      '{"a":{},"b":[true,null,{"d":"x\\"\\\\\\n\\u0001 "}]}',
    );
  });

  it('drops undefined members and rejects values JSON cannot carry', () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalize(Number.NaN)).toThrow(CanonicalizationError);
    expect(() => canonicalize(Infinity)).toThrow(CanonicalizationError);
    expect(() => canonicalize(1n)).toThrow(CanonicalizationError);
  });
});

describe('gate context_id', () => {
  it('hashes the JCS form of {arguments, server, tool}', () => {
    expect(gatePreimage('fs', 'write', { path: '/tmp/x', data: 'hi' })).toBe(
      '{"arguments":{"data":"hi","path":"/tmp/x"},"server":"fs","tool":"write"}',
    );
    expect(gateContextId('fs', 'write', { path: '/tmp/x', data: 'hi' })).toBe(
      contextIdOf('{"arguments":{"data":"hi","path":"/tmp/x"},"server":"fs","tool":"write"}'),
    );
    expect(gateContextId('fs', 'write', { path: '/tmp/x', data: 'hi' })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('treats absent arguments as {}', () => {
    expect(gatePreimage('s', 't', undefined)).toBe('{"arguments":{},"server":"s","tool":"t"}');
    expect(gateContextId('s', 't', undefined)).toBe(gateContextId('s', 't', {}));
  });
});
