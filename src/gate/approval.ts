/**
 * Runs the MACP session that decides one gated tool call.
 *
 * The gate is the session's initiator and its only committer. In Quorum it
 * sends one ApprovalRequest and is not itself a participant (the runtime lets
 * only the initiator request approval; ballots come from the declared
 * participants). In Decision it must be a participant to send its Proposal,
 * so it is added as the first participant, but it never votes and is not
 * counted. Either way the gate watches the session's stream and commits as
 * soon as the outcome is settled: positive once the approvers' first ballots
 * reach the rule's threshold, negative once they no longer can.
 *
 * What approvers see on the wire (intent, request fields, commitment action
 * and scope) is pinned by `contract/gate/session.json`, shared with the
 * Python macp-mcp, so a session opened by either gate looks identical.
 */

import {
  DecisionProjection,
  DecisionSession,
  MacpAckError,
  MacpTimeoutError,
  MODE_QUORUM,
  QuorumProjection,
  QuorumSession,
  commitmentHash,
  type Envelope,
  type MacpClient,
  type MacpStream,
} from 'macp-sdk-typescript';
import { decodeCommitment, stateName, type BridgeClient } from '../bridge';
import type { Settings } from '../config';
import { GATE_DEFAULT_TTL_MS, requiredApprovals, type GateMode, type GateRule } from './config';
import { renderRefusal, type GateTemplate } from './contract';

/** Decision-mode proposal id: one gated call per session. */
export const GATE_PROPOSAL_ID = 'call';
export const GATE_ACTION_APPROVE = 'macp.gate.approve';
export const GATE_ACTION_DENY = 'macp.gate.deny';

/** How long past `ttl_ms` the gate waits for the runtime before cancelling the session itself. */
export const GATE_GRACE_MS = 5_000;
/** How often the gate re-checks the session state while no envelope arrives. */
export const GATE_POLL_MS = 500;

export type GateOutcome = 'approve' | 'deny';

/** The settled session behind a gated call (`_meta["io.multiagentcoordinationprotocol/commitment"]`). */
export interface GateCommitment {
  session_id: string;
  mode: GateMode;
  outcome: GateOutcome;
  commitment_hash: string;
}

/** A gated call that cannot go ahead. `code` is a registry error code; the tool error text is `"<code>: <message>"`. */
export class GateRefusal extends Error {
  constructor(
    readonly code: 'POLICY_DENIED' | 'SESSION_NOT_OPEN' | 'INVALID_ARGUMENT',
    message: string,
    readonly sessionId: string,
  ) {
    super(message);
    this.name = 'GateRefusal';
  }
}

/** A refusal whose `"<code>: <message>"` text is exactly the rendered `session.json` template. */
export function refusal(template: GateTemplate, vars: Record<string, string>, sessionId = ''): GateRefusal {
  const text = renderRefusal(template, vars);
  const at = text.indexOf(': ');
  return new GateRefusal(text.slice(0, at) as GateRefusal['code'], text.slice(at + 2), sessionId);
}

export interface GatedCall {
  server: string;
  tool: string;
  /** JCS preimage of {"arguments","server","tool"}. */
  preimage: string;
  contextId: string;
}

/** Whether the approvers' ballots settle the call: approve at the bar, deny once it is out of reach. */
export function settle(approvals: number, cast: number, approvers: number, required: number): GateOutcome | undefined {
  if (approvals >= required) return 'approve';
  if (approvals + (approvers - cast) < required) return 'deny';
  return undefined;
}

interface Tracker {
  apply(envelope: Envelope): void;
  outcome(): GateOutcome | undefined;
}

function tracker<B extends { sender: string }>(
  projection: QuorumProjection | DecisionProjection,
  client: BridgeClient,
  rule: GateRule,
  ballots: () => Iterable<B>,
  isApprove: (ballot: B) => boolean,
): Tracker {
  const approvers = new Set(rule.participants);
  return {
    apply: (envelope) => projection.applyEnvelope(envelope, client.protoRegistry),
    outcome: () => {
      // The first ballot per approver counts (session.json): the runtime rejects a second one, and
      // the SDK projections, keyed by sender, keep the first ballot either way.
      const counted = [...ballots()].filter((b) => approvers.has(b.sender));
      const approvals = counted.filter(isApprove).length;
      return settle(approvals, counted.length, approvers.size, requiredApprovals(rule));
    },
  };
}

export class GateApprover {
  constructor(
    private readonly client: BridgeClient,
    private readonly settings: Settings,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Open a session for `call` under `rule` and wait for it to settle. */
  async decide(rule: GateRule, call: GatedCall): Promise<GateCommitment> {
    const client = this.client as MacpClient;
    const options = rule.policy_version ? { policyVersion: rule.policy_version } : {};
    const ttlMs = rule.ttl_ms ?? GATE_DEFAULT_TTL_MS;
    const intent = `Approve MCP tool call ${call.server}/${call.tool}`;
    const deadline = this.clock() + ttlMs + GATE_GRACE_MS;
    let session: QuorumSession | DecisionSession;
    let track: Tracker;

    if (rule.mode === MODE_QUORUM) {
      const quorum = new QuorumSession(client, options);
      await quorum.start({ intent, participants: rule.participants, ttlMs, contextId: call.contextId });
      await quorum.requestApproval({
        requestId: call.contextId,
        action: `tools/call:${call.tool}`,
        summary: `${call.server}/${call.tool}`,
        details: Buffer.from(call.preimage, 'utf8'),
        requiredApprovals: requiredApprovals(rule),
      });
      const projection = new QuorumProjection();
      track = tracker(
        projection,
        this.client,
        rule,
        () => projection.ballots.get(call.contextId)?.values() ?? [],
        (b) => b.vote === 'approve',
      );
      session = quorum;
    } else {
      const decision = new DecisionSession(client, options);
      const participants = [this.settings.agentId, ...rule.participants];
      await decision.start({ intent, participants, ttlMs, contextId: call.contextId });
      await decision.propose({
        proposalId: GATE_PROPOSAL_ID,
        option: `tools/call:${call.tool}`,
        rationale: call.preimage,
      });
      const projection = new DecisionProjection();
      track = tracker(
        projection,
        this.client,
        rule,
        () => projection.votes.get(GATE_PROPOSAL_ID)?.values() ?? [],
        (v) => v.vote.toUpperCase() === 'APPROVE',
      );
      session = decision;
    }
    return this.watch(session, rule.mode, track, call, deadline);
  }

  private async state(sessionId: string): Promise<string> {
    return stateName((await this.client.getSession(sessionId)).metadata.state);
  }

  private async cancel(session: QuorumSession | DecisionSession, reason: string): Promise<void> {
    try {
      await session.cancel(reason);
    } catch {
      // Best effort: the session may already have ended.
    }
  }

  private async watch(
    session: QuorumSession | DecisionSession,
    mode: GateMode,
    track: Tracker,
    call: GatedCall,
    deadline: number,
  ): Promise<GateCommitment> {
    const sessionId = session.sessionId;
    const notOpen = (state: string): GateRefusal =>
      refusal('not_open', { session_id: sessionId, state, tool: call.tool }, sessionId);
    const stream: MacpStream = this.client.openStream();
    let committing = false;
    try {
      await stream.sendSubscribe(sessionId, 0);
      for (;;) {
        let envelope: Envelope | null = null;
        try {
          envelope = await stream.read(GATE_POLL_MS);
        } catch (err) {
          if (!(err instanceof MacpTimeoutError)) throw err;
        }
        if (!envelope) {
          const state = await this.state(sessionId);
          if (state !== 'OPEN') throw notOpen(state);
          if (this.clock() >= deadline) {
            await this.cancel(session, 'gate deadline passed without a commitment');
            throw notOpen(await this.state(sessionId));
          }
          continue;
        }
        if (envelope.sessionId !== sessionId) continue;
        track.apply(envelope);
        if (envelope.messageType === 'Commitment') {
          const payload = decodeCommitment(this.client, Buffer.from(envelope.payload));
          const outcome: GateOutcome = payload.outcomePositive ? 'approve' : 'deny';
          return { session_id: sessionId, mode, outcome, commitment_hash: commitmentHash(payload) };
        }
        const outcome = committing ? undefined : track.outcome();
        if (!outcome) continue;
        committing = true;
        try {
          await session.commit({
            action: outcome === 'approve' ? GATE_ACTION_APPROVE : GATE_ACTION_DENY,
            authorityScope: `tools/call:${call.server}/${call.tool}`,
            reason:
              outcome === 'approve' ? 'approvals reached the threshold' : 'the threshold can no longer be reached',
            outcomePositive: outcome === 'approve',
          });
        } catch (err) {
          if (!(err instanceof MacpAckError)) throw err;
          if (err.failure.code === 'SESSION_NOT_OPEN') throw notOpen(await this.state(sessionId));
          if (err.failure.code === 'POLICY_DENIED') {
            // A bound RFC-MACP-0012 policy refused the commitment.
            await this.cancel(session, 'commitment refused by the session policy');
            throw refusal('policy_denied', { runtime_message: err.failure.message }, sessionId);
          }
          throw err;
        }
        // The Commitment arrives on the stream; the hash is taken from it there.
      }
    } finally {
      stream.close();
    }
  }
}

/** The refusal for a settled `deny`. */
export function denied(commitment: GateCommitment, tool: string): GateRefusal {
  return refusal('denied', { tool, session_id: commitment.session_id }, commitment.session_id);
}
