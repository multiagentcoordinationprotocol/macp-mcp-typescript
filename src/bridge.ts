/**
 * The MACP side of the server: Decision-mode actions over `MacpClient`.
 *
 * The bridge is deliberately stateless. It keeps no per-session objects
 * between tool calls; every action is built from the session id plus what the
 * runtime reports (`GetSession` metadata and the replayed, append-only session
 * history). So a server that restarts mid-session loses nothing, a server
 * that never started a session can still join it, and `get_session` /
 * `get_commitment` reflect every participant's messages, not just this
 * agent's. Mirrors the Python macp-mcp `bridge.py` call for call.
 */

import {
  DecisionProjection,
  DecisionSession,
  MacpClient,
  MacpTimeoutError,
  MODE_DECISION,
  commitmentHash,
  verifyCommitmentHash,
  type Ack,
  type CommitmentPayload,
  type Envelope,
  type MacpStream,
  type SessionMetadata,
  type VerifyOutcome,
} from 'macp-sdk-typescript';
import { authFor, type Settings } from './config';
import type {
  AckResult,
  CommitAckResult,
  CommitmentResult,
  CommitmentView,
  ProposalAckResult,
  SessionResult,
  StartSessionResult,
  VerifyResult,
  VerifySource,
  VoteAckResult,
} from './results';
import { VERSION } from './version';

/** RFC-MACP-0013 hash label, the `label` part of the hash preimage. */
export const COMMITMENT_HASH_LABEL = 'macp-commitment-hash/1';

/** Cap on a single replay, so a busy open session cannot pin a tool call. */
export const REPLAY_MAX_MS = 15_000;

/** Raised for argument problems the caller can fix; surfaced as a plain message. */
export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolArgumentError';
  }
}

/** The subset of `MacpClient` the bridge uses (lets tests pass a fake). */
export type BridgeClient = Pick<MacpClient, 'send' | 'getSession' | 'openStream' | 'protoRegistry' | 'auth' | 'close'>;

export type ClientFactory = (settings: Settings) => BridgeClient;

export function defaultClientFactory(settings: Settings): BridgeClient {
  return new MacpClient({
    address: settings.target,
    secure: !settings.allowInsecure,
    allowInsecure: settings.allowInsecure,
    rootCertificates: settings.rootCertificates,
    auth: authFor(settings),
    clientName: 'macp-mcp',
    clientVersion: VERSION,
  });
}

/** SessionState enum name without the `SESSION_STATE_` prefix (OPEN, RESOLVED, ...). */
export function stateName(state: string | undefined): string {
  return (state ?? 'SESSION_STATE_UNSPECIFIED').replace(/^SESSION_STATE_/, '');
}

function ackDict(ack: Ack): AckResult {
  return {
    ok: ack.ok ?? false,
    duplicate: ack.duplicate ?? false,
    message_id: ack.messageId ?? '',
    session_id: ack.sessionId ?? '',
    session_state: stateName(ack.sessionState),
  };
}

function int64(value: string | number | undefined): number {
  return value === undefined || value === '' ? 0 : Number(value);
}

/** A decoded CommitmentPayload with proto3 defaults filled in (protobufjs omits them). Commitment is a core message, so any mode decodes it. */
export function decodeCommitment(client: BridgeClient, wire: Buffer): CommitmentPayload {
  const raw = client.protoRegistry.decodeKnownPayload(MODE_DECISION, 'Commitment', wire) ?? {};
  const str = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string) : '');
  const payload: CommitmentPayload = {
    commitmentId: str('commitmentId'),
    action: str('action'),
    authorityScope: str('authorityScope'),
    reason: str('reason'),
    modeVersion: str('modeVersion'),
    policyVersion: str('policyVersion'),
    configurationVersion: str('configurationVersion'),
    outcomePositive: raw.outcomePositive === true,
  };
  const supersedes = raw.supersedes as { sessionId?: string; commitmentHash?: string } | undefined;
  if (supersedes) {
    payload.supersedes = { sessionId: supersedes.sessionId ?? '', commitmentHash: supersedes.commitmentHash ?? '' };
  }
  return payload;
}

function commitmentDict(payload: CommitmentPayload): CommitmentView {
  const out: CommitmentView = {
    commitment_id: payload.commitmentId,
    action: payload.action,
    authority_scope: payload.authorityScope,
    reason: payload.reason,
    outcome_positive: payload.outcomePositive ?? false,
    mode_version: payload.modeVersion,
    policy_version: payload.policyVersion ?? '',
    configuration_version: payload.configurationVersion,
  };
  if (payload.supersedes) {
    out.supersedes = {
      session_id: payload.supersedes.sessionId,
      commitment_hash: payload.supersedes.commitmentHash,
    };
  }
  return out;
}

function findCommitment(history: Envelope[]): Envelope | undefined {
  return history.find((envelope) => envelope.messageType === 'Commitment');
}

/** Decision-mode actions for one MACP agent identity. */
export class MacpBridge {
  private clientInstance?: BridgeClient;

  constructor(
    readonly settings: Settings,
    private readonly clientFactory: ClientFactory = defaultClientFactory,
    private readonly clock: () => number = Date.now,
  ) {}

  get client(): BridgeClient {
    // Created lazily so a bad target only fails the first tool call, not startup.
    this.clientInstance ??= this.clientFactory(this.settings);
    return this.clientInstance;
  }

  close(): void {
    this.clientInstance?.close();
    this.clientInstance = undefined;
  }

  private session(sessionId?: string, metadata?: SessionMetadata): DecisionSession {
    const client = this.client as MacpClient;
    if (!metadata) return new DecisionSession(client, sessionId === undefined ? {} : { sessionId });
    return new DecisionSession(client, {
      sessionId,
      modeVersion: metadata.modeVersion,
      configurationVersion: metadata.configurationVersion,
      policyVersion: metadata.policyVersion,
    });
  }

  private async metadata(sessionId: string): Promise<SessionMetadata> {
    return (await this.client.getSession(sessionId)).metadata;
  }

  /**
   * The session's accepted history, oldest first.
   *
   * Opens a `StreamSession` and sends a subscribe frame with
   * `afterSequence = 0` (RFC-MACP-0006 §3.2), which replays every accepted
   * envelope and then switches to live delivery. The replay is complete once
   * a `Commitment` arrives (nothing follows a terminal message), no envelope
   * arrives for `replayIdleMs`, or the 15 s cap is reached.
   */
  async replay(sessionId: string): Promise<Envelope[]> {
    const deadline = this.clock() + REPLAY_MAX_MS;
    const history: Envelope[] = [];
    const seen = new Set<string>();
    const stream: MacpStream = this.client.openStream();
    try {
      await stream.sendSubscribe(sessionId, 0);
      while (this.clock() < deadline) {
        let envelope: Envelope | null;
        try {
          envelope = await stream.read(this.settings.replayIdleMs);
        } catch (err) {
          if (err instanceof MacpTimeoutError) break;
          throw err;
        }
        if (envelope === null) break;
        if (envelope.sessionId !== sessionId || seen.has(envelope.messageId)) continue;
        seen.add(envelope.messageId);
        history.push(envelope);
        if (envelope.messageType === 'Commitment') break;
      }
    } finally {
      stream.close();
    }
    return history;
  }

  async startSession(intent: string, participants: string[], ttlMs = 0, contextId = ''): Promise<StartSessionResult> {
    const members = [...new Set(participants.map((p) => p.trim()).filter((p) => p))];
    if (!members.includes(this.settings.agentId)) members.unshift(this.settings.agentId);
    const ttl = ttlMs || this.settings.defaultTtlMs;
    const session = this.session();
    const ack = await session.start({ intent, participants: members, ttlMs: ttl, contextId });
    return {
      ...ackDict(ack),
      session_id: session.sessionId,
      mode: MODE_DECISION,
      initiator: this.settings.agentId,
      participants: members,
      ttl_ms: ttl,
    };
  }

  async propose(sessionId: string, proposalId: string, option: string, rationale = ''): Promise<ProposalAckResult> {
    const ack = await this.session(sessionId).propose({ proposalId, option, rationale });
    return { ...ackDict(ack), proposal_id: proposalId, sender: this.settings.agentId };
  }

  async evaluate(
    sessionId: string,
    proposalId: string,
    recommendation: string,
    confidence: number,
    reason = '',
  ): Promise<ProposalAckResult> {
    const ack = await this.session(sessionId).evaluate({ proposalId, recommendation, confidence, reason });
    return { ...ackDict(ack), proposal_id: proposalId, sender: this.settings.agentId };
  }

  async vote(sessionId: string, proposalId: string, vote: string, reason = ''): Promise<VoteAckResult> {
    const ack = await this.session(sessionId).vote({ proposalId, vote, reason });
    return { ...ackDict(ack), proposal_id: proposalId, vote: vote.toUpperCase(), sender: this.settings.agentId };
  }

  async commit(
    sessionId: string,
    action: string,
    authorityScope: string,
    reason: string,
    outcomePositive = true,
  ): Promise<CommitAckResult> {
    // Bind the commitment to the versions the session was started with, so a
    // joining committer cannot drift from the initiator's binding.
    const metadata = await this.metadata(sessionId);
    const ack = await this.session(sessionId, metadata).commit({ action, authorityScope, reason, outcomePositive });
    return { ...ackDict(ack), sender: this.settings.agentId };
  }

  async getSession(sessionId: string): Promise<SessionResult> {
    const metadata = await this.metadata(sessionId);
    const history = await this.replay(sessionId);
    const projection = new DecisionProjection();
    for (const envelope of history) projection.applyEnvelope(envelope, this.client.protoRegistry);
    const winner = projection.majorityWinner() ?? null;
    return {
      session_id: metadata.sessionId ?? '',
      mode: metadata.mode ?? '',
      state: stateName(metadata.state),
      initiator: metadata.initiator ?? '',
      participants: [...(metadata.participants ?? [])],
      mode_version: metadata.modeVersion ?? '',
      configuration_version: metadata.configurationVersion ?? '',
      policy_version: metadata.policyVersion ?? '',
      started_at_unix_ms: int64(metadata.startedAtUnixMs),
      expires_at_unix_ms: int64(metadata.expiresAtUnixMs),
      you: this.settings.agentId,
      phase: projection.phase,
      proposals: [...projection.proposals.values()].map((p) => ({
        proposal_id: p.proposalId,
        option: p.option,
        rationale: p.rationale ?? '',
        sender: p.sender,
      })),
      evaluations: projection.evaluations.map((e) => ({
        proposal_id: e.proposalId,
        recommendation: e.recommendation,
        confidence: e.confidence ?? 0,
        reason: e.reason ?? '',
        sender: e.sender,
      })),
      objections: projection.objections.map((o) => ({
        proposal_id: o.proposalId,
        reason: o.reason ?? '',
        severity: o.severity,
        sender: o.sender,
      })),
      votes: [...projection.votes.entries()].flatMap(([proposalId, bySender]) =>
        [...bySender.values()].map((v) => ({
          proposal_id: proposalId,
          vote: v.vote,
          reason: v.reason ?? '',
          sender: v.sender,
        })),
      ),
      approve_totals: projection.voteTotals(),
      majority_winner: winner,
      blocking_objection: projection.hasBlockingObjection(winner ?? undefined),
      committed: projection.isCommitted,
      history: history.map((e) => ({ message_type: e.messageType, sender: e.sender, message_id: e.messageId })),
    };
  }

  async getCommitment(sessionId: string): Promise<CommitmentResult> {
    const metadata = await this.metadata(sessionId);
    const envelope = findCommitment(await this.replay(sessionId));
    if (!envelope) return { session_id: sessionId, state: stateName(metadata.state), found: false };
    const wire = Buffer.from(envelope.payload);
    const payload = decodeCommitment(this.client, wire);
    return {
      session_id: sessionId,
      state: stateName(metadata.state),
      found: true,
      sender: envelope.sender,
      message_id: envelope.messageId,
      commitment: commitmentDict(payload),
      payload_b64: wire.toString('base64'),
      commitment_hash: commitmentHash(payload),
      hash_label: COMMITMENT_HASH_LABEL,
    };
  }

  /**
   * Recompute the RFC-MACP-0013 hash and compare it with a claim. Exactly one
   * source of payload bytes is used: `payloadB64` (bytes the caller already
   * holds) or `sessionId` (bytes re-fetched from the runtime's history,
   * independent of any earlier tool result).
   */
  async verify(claimedHash: string, sessionId = '', payloadB64 = ''): Promise<VerifyResult> {
    if (Boolean(sessionId) === Boolean(payloadB64)) {
      throw new ToolArgumentError('pass exactly one of session_id or payload_b64');
    }
    let wire: Buffer;
    let source: VerifySource;
    if (payloadB64) {
      // Strict base64 (Python's b64decode(validate=True)): Buffer.from silently skips bad characters.
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payloadB64)) {
        throw new ToolArgumentError('payload_b64 is not valid base64');
      }
      wire = Buffer.from(payloadB64, 'base64');
      source = 'payload_b64';
    } else {
      const envelope = findCommitment(await this.replay(sessionId));
      if (!envelope) throw new ToolArgumentError(`session ${sessionId} has no Commitment in its history`);
      wire = Buffer.from(envelope.payload);
      source = 'runtime_history';
    }
    const outcome: VerifyOutcome = verifyCommitmentHash(wire, claimedHash);
    const recomputed = outcome === 'cannot_verify' ? null : commitmentHash(decodeCommitment(this.client, wire));
    const result: VerifyResult = {
      outcome,
      claimed_hash: claimedHash,
      recomputed_hash: recomputed,
      hash_label: COMMITMENT_HASH_LABEL,
      source,
    };
    if (sessionId) result.session_id = sessionId;
    return result;
  }
}
