import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODE_DECISION, MacpTransportError, commitmentHash, type CommitmentPayload } from 'macp-sdk-typescript';
import { REPLAY_MAX_MS, ToolArgumentError, stateName } from '../../src/bridge';
import { METADATA, SID, envelope, harness } from './fakes';

afterEach(() => {
  vi.restoreAllMocks();
});

const COMMITMENT: CommitmentPayload = {
  commitmentId: 'c-1',
  action: 'release.approved',
  authorityScope: 'release',
  reason: 'p1 won',
  modeVersion: '1.0.0',
  policyVersion: 'policy.default',
  configurationVersion: 'config.default',
  outcomePositive: true,
};

function decisionHistory(h: ReturnType<typeof harness>) {
  const c = h.client;
  return [
    envelope(c, 'SessionStart', 'alice', { intent: 'ship?', participants: ['alice', 'bob'], ttlMs: 60_000 }),
    envelope(c, 'Proposal', 'alice', { proposalId: 'p1', option: 'ship', rationale: 'green' }),
    envelope(c, 'Evaluation', 'bob', { proposalId: 'p1', recommendation: 'APPROVE', confidence: 0.75 }),
    envelope(c, 'Objection', 'bob', { proposalId: 'p1', reason: 'risky', severity: 'low' }),
    envelope(c, 'Vote', 'alice', { proposalId: 'p1', vote: 'APPROVE' }),
    envelope(c, 'Vote', 'bob', { proposalId: 'p1', vote: 'APPROVE', reason: 'ok' }),
  ];
}

describe('stateName', () => {
  it('strips the SESSION_STATE_ prefix', () => {
    expect(stateName('SESSION_STATE_RESOLVED')).toBe('RESOLVED');
    expect(stateName(undefined)).toBe('UNSPECIFIED');
  });
});

describe('startSession', () => {
  it('trims and dedupes participants and prepends the caller', async () => {
    const h = harness();
    const result = await h.bridge.startSession('ship?', [' bob ', 'carol', 'bob', ''], 0, 'ctx');
    expect(result.participants).toEqual(['alice', 'bob', 'carol']);
    expect(result).toMatchObject({
      ok: true,
      duplicate: false,
      initiator: 'alice',
      mode: MODE_DECISION,
      session_state: 'OPEN',
      ttl_ms: 300_000,
    });
    expect(result.session_id).toBe(h.sent[0]!.sessionId);
    expect(h.sent[0]!.messageType).toBe('SessionStart');
    const payload = h.client.protoRegistry.decodeKnownPayload(MODE_DECISION, 'SessionStart', h.sent[0]!.payload)!;
    expect(payload).toMatchObject({ participants: ['alice', 'bob', 'carol'], contextId: 'ctx' });
  });

  it('keeps the caller where it already is and honours an explicit ttl', async () => {
    const h = harness();
    const result = await h.bridge.startSession('x', ['bob', 'alice'], 1234);
    expect(result.participants).toEqual(['bob', 'alice']);
    expect(result.ttl_ms).toBe(1234);
  });
});

describe('actions', () => {
  it('propose / evaluate / vote return ack fields plus the echoed ids', async () => {
    const h = harness();
    expect(await h.bridge.propose(SID, 'p1', 'ship')).toMatchObject({ proposal_id: 'p1', sender: 'alice', ok: true });
    expect(await h.bridge.evaluate(SID, 'p1', 'REVIEW', 0.5)).toMatchObject({ proposal_id: 'p1', sender: 'alice' });
    expect(await h.bridge.vote(SID, 'p1', 'approve')).toMatchObject({ vote: 'APPROVE', sender: 'alice' });
    expect(h.sent.map((e) => e.messageType)).toEqual(['Proposal', 'Evaluation', 'Vote']);
  });

  it('commit binds the versions from GetSession metadata', async () => {
    const h = harness();
    h.setMetadata({ ...METADATA, modeVersion: '9.9.9', configurationVersion: 'cfg.x', policyVersion: 'pol.y' });
    const result = await h.bridge.commit(SID, 'a', 'scope', 'why', false);
    expect(result).toMatchObject({ session_state: 'RESOLVED', sender: 'alice' });
    const payload = h.client.protoRegistry.decodeKnownPayload(MODE_DECISION, 'Commitment', h.sent[0]!.payload)!;
    expect(payload).toMatchObject({
      modeVersion: '9.9.9',
      configurationVersion: 'cfg.x',
      policyVersion: 'pol.y',
      outcomePositive: false,
    });
  });
});

describe('replay', () => {
  it('subscribes from sequence 0, skips other sessions and redeliveries, stops at idle', async () => {
    const h = harness();
    const [start, proposal] = decisionHistory(h);
    const other = envelope(h.client, 'Proposal', 'zed', { proposalId: 'q', option: 'o' }, 'sess-unit-test-other-0001');
    h.setHistory([start!, other, proposal!, proposal!]);
    const history = await h.bridge.replay(SID);
    expect(history.map((e) => e.messageType)).toEqual(['SessionStart', 'Proposal']);
    expect(h.streams[0]!.subscribed).toEqual([{ sessionId: SID, afterSequence: 0 }]);
    expect(h.streams[0]!.closed).toBe(true);
  });

  it('stops at the first Commitment', async () => {
    const h = harness();
    const commit = envelope(h.client, 'Commitment', 'alice', { ...COMMITMENT });
    const after = envelope(h.client, 'Proposal', 'alice', { proposalId: 'late', option: 'x' });
    h.setHistory([commit, after]);
    expect((await h.bridge.replay(SID)).map((e) => e.messageType)).toEqual(['Commitment']);
  });

  it('stops when the stream ends', async () => {
    const h = harness();
    h.setHistory(decisionHistory(h).slice(0, 2), 'end');
    expect(await h.bridge.replay(SID)).toHaveLength(2);
  });

  it('stops at the 15 s cap even while envelopes keep arriving', async () => {
    let now = 0;
    const h = harness({}, () => now);
    const items = decisionHistory(h).slice(1);
    h.setHistory(items);
    const read = vi.spyOn(h.client, 'openStream');
    read.mockImplementationOnce(() => {
      const queue = [...items];
      return {
        sendSubscribe: async () => undefined,
        read: async () => {
          now += REPLAY_MAX_MS / 2;
          return queue.shift() ?? null;
        },
        close: () => undefined,
      } as never;
    });
    expect(await h.bridge.replay(SID)).toHaveLength(2);
  });

  it('closes the stream and rethrows a transport error', async () => {
    const h = harness();
    h.setHistory([new MacpTransportError('boom', 'UNAVAILABLE')]);
    await expect(h.bridge.replay(SID)).rejects.toThrow('boom');
    expect(h.streams[0]!.closed).toBe(true);
  });
});

describe('getSession', () => {
  it('projects the replayed history', async () => {
    const h = harness({ agentId: 'bob' });
    h.setHistory(decisionHistory(h));
    const view = await h.bridge.getSession(SID);
    expect(view).toEqual({
      session_id: SID,
      mode: MODE_DECISION,
      state: 'OPEN',
      initiator: 'alice',
      participants: ['alice', 'bob'],
      mode_version: '1.0.0',
      configuration_version: 'config.default',
      policy_version: 'policy.default',
      started_at_unix_ms: 1700000000000,
      expires_at_unix_ms: 1700000300000,
      you: 'bob',
      phase: 'Voting',
      proposals: [{ proposal_id: 'p1', option: 'ship', rationale: 'green', sender: 'alice' }],
      evaluations: [{ proposal_id: 'p1', recommendation: 'APPROVE', confidence: 0.75, reason: '', sender: 'bob' }],
      objections: [{ proposal_id: 'p1', reason: 'risky', severity: 'low', sender: 'bob' }],
      votes: [
        { proposal_id: 'p1', vote: 'APPROVE', reason: '', sender: 'alice' },
        { proposal_id: 'p1', vote: 'APPROVE', reason: 'ok', sender: 'bob' },
      ],
      approve_totals: { p1: 2 },
      majority_winner: 'p1',
      blocking_objection: false,
      committed: false,
      history: expect.any(Array),
    });
    expect(view.history.map((e) => e.message_type)).toEqual([
      'SessionStart',
      'Proposal',
      'Evaluation',
      'Objection',
      'Vote',
      'Vote',
    ]);
  });

  it('reports a null winner and zero timestamps on an empty session', async () => {
    const h = harness();
    h.setMetadata({ sessionId: SID });
    const view = await h.bridge.getSession(SID);
    expect(view).toMatchObject({
      majority_winner: null,
      started_at_unix_ms: 0,
      state: 'UNSPECIFIED',
      participants: [],
      phase: 'Proposal',
    });
  });
});

describe('getCommitment / verify', () => {
  function resolved(h: ReturnType<typeof harness>, payload: CommitmentPayload = COMMITMENT) {
    h.setMetadata({ ...METADATA, state: 'SESSION_STATE_RESOLVED' });
    const commit = envelope(h.client, 'Commitment', 'alice', { ...payload });
    h.setHistory([...decisionHistory(h), commit]);
    return commit;
  }

  it('reports found=false while open', async () => {
    const h = harness();
    h.setHistory(decisionHistory(h));
    expect(await h.bridge.getCommitment(SID)).toEqual({ session_id: SID, state: 'OPEN', found: false });
  });

  it('returns the commitment, its exact bytes and the RFC-MACP-0013 hash', async () => {
    const h = harness();
    const commit = resolved(h);
    const result = await h.bridge.getCommitment(SID);
    expect(result).toEqual({
      session_id: SID,
      state: 'RESOLVED',
      found: true,
      sender: 'alice',
      message_id: commit.messageId,
      commitment: {
        commitment_id: 'c-1',
        action: 'release.approved',
        authority_scope: 'release',
        reason: 'p1 won',
        outcome_positive: true,
        mode_version: '1.0.0',
        policy_version: 'policy.default',
        configuration_version: 'config.default',
      },
      payload_b64: Buffer.from(commit.payload).toString('base64'),
      commitment_hash: commitmentHash(COMMITMENT),
      hash_label: 'macp-commitment-hash/1',
    });
  });

  it('carries supersedes and a negative outcome through', async () => {
    const h = harness();
    const supersedes = { sessionId: 's-0', commitmentHash: `sha256:${'a'.repeat(64)}` };
    resolved(h, { ...COMMITMENT, outcomePositive: false, supersedes });
    const result = await h.bridge.getCommitment(SID);
    expect(result.commitment).toMatchObject({
      outcome_positive: false,
      supersedes: { session_id: 's-0', commitment_hash: supersedes.commitmentHash },
    });
    expect(result.commitment_hash).toBe(commitmentHash({ ...COMMITMENT, outcomePositive: false, supersedes }));
  });

  it('verifies from runtime history', async () => {
    const h = harness();
    resolved(h);
    const hash = commitmentHash(COMMITMENT);
    expect(await h.bridge.verify(hash, SID)).toEqual({
      outcome: 'match',
      claimed_hash: hash,
      recomputed_hash: hash,
      hash_label: 'macp-commitment-hash/1',
      source: 'runtime_history',
      session_id: SID,
    });
  });

  it('verifies caller-held bytes and reports a mismatch', async () => {
    const h = harness();
    const commit = resolved(h);
    const b64 = Buffer.from(commit.payload).toString('base64');
    const claimed = `sha256:${'0'.repeat(64)}`;
    const result = await h.bridge.verify(claimed, '', b64);
    expect(result).toEqual({
      outcome: 'mismatch',
      claimed_hash: claimed,
      recomputed_hash: commitmentHash(COMMITMENT),
      hash_label: 'macp-commitment-hash/1',
      source: 'payload_b64',
    });
  });

  it('returns cannot_verify with a null recomputed hash for an unhashable payload', async () => {
    const h = harness();
    // Field 99 (varint) is outside the frozen field set: RFC-MACP-0013 §5.
    const b64 = Buffer.from([0xf8, 0x06, 0x01]).toString('base64');
    const result = await h.bridge.verify(`sha256:${'0'.repeat(64)}`, '', b64);
    expect(result).toMatchObject({ outcome: 'cannot_verify', recomputed_hash: null });
  });

  it.each([
    ['neither source', '', ''],
    ['both sources', SID, 'AAAA'],
  ])('rejects %s', async (_label, sessionId, b64) => {
    const h = harness();
    await expect(h.bridge.verify('sha256:x', sessionId, b64)).rejects.toThrow(
      new ToolArgumentError('pass exactly one of session_id or payload_b64'),
    );
  });

  it.each(['not base64!', 'AAA', 'AA=A'])('rejects malformed base64 %j', async (b64) => {
    const h = harness();
    await expect(h.bridge.verify('sha256:x', '', b64)).rejects.toThrow('payload_b64 is not valid base64');
  });

  it('rejects a session with no Commitment', async () => {
    const h = harness();
    h.setHistory(decisionHistory(h));
    await expect(h.bridge.verify('sha256:x', SID)).rejects.toThrow(`session ${SID} has no Commitment in its history`);
  });
});

describe('client lifecycle', () => {
  it('creates the client lazily, once, and closes it', () => {
    const h = harness();
    const close = vi.spyOn(h.client, 'close').mockImplementation(() => undefined);
    expect(h.bridge.client).toBe(h.client);
    expect(h.bridge.client).toBe(h.client);
    h.bridge.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
