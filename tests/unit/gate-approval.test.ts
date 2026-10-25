import { describe, expect, it, vi } from 'vitest';
import {
  Auth,
  MacpAckError,
  MacpClient,
  MacpTimeoutError,
  MODE_DECISION,
  MODE_QUORUM,
  buildEnvelope,
  commitmentHash,
  type Ack,
  type Envelope,
  type MacpStream,
} from 'macp-sdk-typescript';
import { decodeCommitment } from '../../src/bridge';
import { defaultSettings } from '../../src/config';
import { GateApprover, GateRefusal, type GatedCall } from '../../src/gate/approval';
import type { GateRule } from '../../src/gate/config';
import { contextIdOf, gatePreimage } from '../../src/gate/context-id';

const preimage = gatePreimage('fs', 'write', { path: '/x' });
const CALL: GatedCall = { server: 'fs', tool: 'write', preimage, contextId: contextIdOf(preimage) };

let counter = 0;

/**
 * A fake runtime for one session: everything the gate sends is acked and
 * echoed onto the session stream, and `script` reacts to each sent envelope
 * with the approvers' envelopes.
 */
function fakeRuntime(options: {
  script?: (sent: Envelope, emit: (type: string, sender: string, payload: object) => void) => void;
  ack?: (sent: Envelope) => Ack | Error;
  state?: () => string;
}) {
  const client = new MacpClient({
    address: '127.0.0.1:1',
    secure: false,
    allowInsecure: true,
    auth: Auth.devAgent('gate'),
  });
  const sent: Envelope[] = [];
  const queue: Envelope[] = [];
  let mode = MODE_QUORUM;
  let sessionId = '';
  const emit = (messageType: string, sender: string, payload: object) => {
    counter += 1;
    queue.push(
      buildEnvelope({
        mode,
        messageType,
        sessionId,
        sender,
        messageId: `fake-${counter}`,
        payload: client.protoRegistry.encodeKnownPayload(mode, messageType, payload as Record<string, unknown>),
      }),
    );
  };
  vi.spyOn(client, 'send').mockImplementation(async (envelope: Envelope) => {
    if (envelope.messageType === 'SessionStart') {
      mode = envelope.mode as typeof MODE_QUORUM;
      sessionId = envelope.sessionId;
    }
    const ack = options.ack?.(envelope);
    if (ack instanceof Error) throw ack;
    sent.push(envelope);
    if (envelope.messageType !== 'SessionStart') queue.push(envelope);
    options.script?.(envelope, emit);
    return (
      ack ?? {
        ok: true,
        messageId: envelope.messageId,
        sessionId: envelope.sessionId,
        sessionState: 'SESSION_STATE_OPEN',
      }
    );
  });
  const cancel = vi.spyOn(client, 'cancelSession').mockResolvedValue({ ok: true } as Ack);
  vi.spyOn(client, 'getSession').mockImplementation(async () => ({
    metadata: { sessionId, state: `SESSION_STATE_${options.state?.() ?? 'OPEN'}` },
  }));
  vi.spyOn(client, 'openStream').mockImplementation(
    () =>
      ({
        sendSubscribe: async () => undefined,
        read: async (timeoutMs?: number) => {
          const next = queue.shift();
          if (next) return next;
          throw new MacpTimeoutError(`timed out after ${timeoutMs}ms`);
        },
        close: () => undefined,
      }) as unknown as MacpStream,
  );
  return { client, sent, cancel, sessionId: () => sessionId };
}

function decodeSent(client: MacpClient, envelope: Envelope): Record<string, unknown> {
  return client.protoRegistry.decodeKnownPayload(envelope.mode, envelope.messageType, Buffer.from(envelope.payload))!;
}

const quorumRule: GateRule = { tool: 'write', mode: MODE_QUORUM, participants: ['alice', 'bob', 'carol'] };
const decisionRule: GateRule = { tool: 'write', mode: MODE_DECISION, participants: ['alice', 'bob'], threshold: 1 };

describe('GateApprover, Quorum', () => {
  it('puts the pinned fields on the wire and commits approve at the threshold', async () => {
    const rt = fakeRuntime({
      script: (sent, emit) => {
        if (sent.messageType === 'ApprovalRequest') {
          emit('Approve', 'alice', { requestId: CALL.contextId });
          emit('Approve', 'mallory', { requestId: CALL.contextId }); // not an approver: ignored
          emit('Approve', 'bob', { requestId: CALL.contextId });
        }
      },
    });
    const result = await new GateApprover(rt.client, defaultSettings({ agentId: 'gate' })).decide(quorumRule, CALL);

    const [start, request, commit] = rt.sent;
    expect(rt.sent.map((e) => e.messageType)).toEqual(['SessionStart', 'ApprovalRequest', 'Commitment']);
    const startPayload = decodeSent(rt.client, start!);
    expect(startPayload).toMatchObject({
      intent: 'Approve MCP tool call fs/write',
      participants: ['alice', 'bob', 'carol'],
      contextId: CALL.contextId,
    });
    expect(Number(startPayload.ttlMs)).toBe(300_000);
    const req = decodeSent(rt.client, request!);
    expect(req).toMatchObject({
      requestId: CALL.contextId,
      action: 'tools/call:write',
      summary: 'fs/write',
      requiredApprovals: 2,
    });
    expect(Buffer.from(req.details as Uint8Array).toString('utf8')).toBe(preimage);
    const payload = decodeCommitment(rt.client as never, Buffer.from(commit!.payload));
    expect(payload).toMatchObject({
      action: 'macp.gate.approve',
      authorityScope: 'tools/call:fs/write',
      outcomePositive: true,
    });
    expect(result).toEqual({
      session_id: rt.sessionId(),
      mode: MODE_QUORUM,
      outcome: 'approve',
      commitment_hash: commitmentHash(payload),
    });
  });

  it('commits deny as soon as the threshold is out of reach, counting abstain as not-approve', async () => {
    const rt = fakeRuntime({
      script: (sent, emit) => {
        if (sent.messageType === 'ApprovalRequest') {
          emit('Reject', 'alice', { requestId: CALL.contextId });
          emit('Abstain', 'bob', { requestId: CALL.contextId });
        }
      },
    });
    const result = await new GateApprover(rt.client, defaultSettings({ agentId: 'gate' })).decide(
      { ...quorumRule, policy_version: 'policy.two-of-three', ttl_ms: 9_000 },
      CALL,
    );
    expect(result.outcome).toBe('deny');
    const commit = rt.sent.at(-1)!;
    expect(decodeCommitment(rt.client as never, Buffer.from(commit.payload))).toMatchObject({
      action: 'macp.gate.deny',
      outcomePositive: false,
      policyVersion: 'policy.two-of-three',
    });
    expect(Number(decodeSent(rt.client, rt.sent[0]!).ttlMs)).toBe(9_000);
  });

  it('refuses with SESSION_NOT_OPEN when the session ends without a commitment', async () => {
    const rt = fakeRuntime({ state: () => 'EXPIRED' });
    const err = await new GateApprover(rt.client, defaultSettings({ agentId: 'gate' }))
      .decide(quorumRule, CALL)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GateRefusal);
    expect((err as GateRefusal).code).toBe('SESSION_NOT_OPEN');
    expect((err as GateRefusal).message).toMatch(/^session \S+ ended EXPIRED without a commitment; tool call write/);
    expect(rt.cancel).not.toHaveBeenCalled();
  });

  it('cancels the session itself once ttl_ms + 5 s pass with the session still open', async () => {
    let now = 0;
    let cancelled = false;
    const rt = fakeRuntime({ state: () => (cancelled ? 'CANCELLED' : 'OPEN') });
    rt.cancel.mockImplementation(async () => {
      cancelled = true;
      return { ok: true } as Ack;
    });
    const approver = new GateApprover(rt.client, defaultSettings({ agentId: 'gate' }), () => {
      now += 1_000;
      return now;
    });
    const err = await approver.decide({ ...quorumRule, ttl_ms: 2_000 }, CALL).catch((e: unknown) => e);
    expect(rt.cancel).toHaveBeenCalledOnce();
    expect((err as GateRefusal).code).toBe('SESSION_NOT_OPEN');
    expect((err as GateRefusal).message).toContain('ended CANCELLED');
  });

  it('maps a SESSION_NOT_OPEN commit NACK (expiry race) to SESSION_NOT_OPEN', async () => {
    let expired = false;
    const rt = fakeRuntime({
      script: (sent, emit) => {
        if (sent.messageType === 'ApprovalRequest') {
          emit('Approve', 'alice', { requestId: CALL.contextId });
          emit('Approve', 'bob', { requestId: CALL.contextId });
        }
      },
      ack: (sent) => {
        if (sent.messageType !== 'Commitment') return { ok: true, sessionState: 'SESSION_STATE_OPEN' } as Ack;
        expired = true;
        return new MacpAckError({
          ok: false,
          error: { code: 'SESSION_NOT_OPEN', message: 'session is expired' },
        } as Ack);
      },
      state: () => (expired ? 'EXPIRED' : 'OPEN'),
    });
    const err = await new GateApprover(rt.client, defaultSettings({ agentId: 'gate' }))
      .decide(quorumRule, CALL)
      .catch((e: unknown) => e);
    expect((err as GateRefusal).code).toBe('SESSION_NOT_OPEN');
    expect((err as GateRefusal).message).toContain('ended EXPIRED');
  });

  it('turns a POLICY_DENIED commit NACK into a POLICY_DENIED refusal and cancels the session', async () => {
    const rt = fakeRuntime({
      script: (sent, emit) => {
        if (sent.messageType === 'ApprovalRequest') {
          emit('Approve', 'alice', { requestId: CALL.contextId });
          emit('Approve', 'bob', { requestId: CALL.contextId });
        }
      },
      ack: (sent) =>
        sent.messageType === 'Commitment'
          ? new MacpAckError({
              ok: false,
              error: { code: 'POLICY_DENIED', message: 'commitment authority is designated_role' },
            } as Ack)
          : ({ ok: true, sessionState: 'SESSION_STATE_OPEN' } as Ack),
    });
    const err = await new GateApprover(rt.client, defaultSettings({ agentId: 'gate' }))
      .decide(quorumRule, CALL)
      .catch((e: unknown) => e);
    expect(err).toEqual(new GateRefusal('POLICY_DENIED', 'commitment authority is designated_role', rt.sessionId()));
    expect(rt.cancel).toHaveBeenCalledOnce();
  });

  it('lets any other MACP error through for the base error formatting', async () => {
    const nack = new MacpAckError({ ok: false, error: { code: 'INVALID_PAYLOAD', message: 'bad' } } as Ack);
    const rt = fakeRuntime({ ack: (sent) => (sent.messageType === 'ApprovalRequest' ? nack : ({ ok: true } as Ack)) });
    await expect(
      new GateApprover(rt.client, defaultSettings({ agentId: 'gate' })).decide(quorumRule, CALL),
    ).rejects.toBe(nack);
  });
});

describe('GateApprover, Decision', () => {
  it('joins as the first participant, proposes, and counts only the approvers’ latest votes', async () => {
    const rt = fakeRuntime({
      script: (sent, emit) => {
        if (sent.messageType === 'Proposal') {
          emit('Vote', 'alice', { proposalId: 'call', vote: 'REJECT' });
          emit('Vote', 'gate', { proposalId: 'call', vote: 'APPROVE' }); // the gate never counts
          emit('Vote', 'bob', { proposalId: 'call', vote: 'approve' });
        }
      },
    });
    const result = await new GateApprover(rt.client, defaultSettings({ agentId: 'gate' })).decide(decisionRule, CALL);
    expect(decodeSent(rt.client, rt.sent[0]!)).toMatchObject({
      intent: 'Approve MCP tool call fs/write',
      participants: ['gate', 'alice', 'bob'],
      contextId: CALL.contextId,
    });
    expect(decodeSent(rt.client, rt.sent[1]!)).toEqual({
      proposalId: 'call',
      option: 'tools/call:write',
      rationale: preimage,
    });
    expect(result).toMatchObject({ mode: MODE_DECISION, outcome: 'approve' });
  });

  it('denies when the approvers reject', async () => {
    const rt = fakeRuntime({
      script: (sent, emit) => {
        if (sent.messageType === 'Proposal') {
          emit('Vote', 'alice', { proposalId: 'call', vote: 'REJECT' });
          emit('Vote', 'bob', { proposalId: 'call', vote: 'ABSTAIN' });
        }
      },
    });
    const result = await new GateApprover(rt.client, defaultSettings({ agentId: 'gate' })).decide(decisionRule, CALL);
    expect(result.outcome).toBe('deny');
  });
});
