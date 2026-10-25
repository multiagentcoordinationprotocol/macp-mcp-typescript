/**
 * Tool result shapes. Each is the `structuredContent` of a tool result as-is
 * (never wrapped). `contract/tools.json` pins the matching `outputSchema`s,
 * and the Python macp-mcp returns the same shapes (`macp_mcp/results.py`).
 */

export type VerifyOutcome = 'match' | 'mismatch' | 'cannot_verify';
export type VerifySource = 'runtime_history' | 'payload_b64';

export interface AckResult {
  ok: boolean;
  duplicate: boolean;
  message_id: string;
  session_id: string;
  session_state: string;
}

export interface StartSessionResult extends AckResult {
  mode: string;
  initiator: string;
  participants: string[];
  ttl_ms: number;
}

export interface ProposalAckResult extends AckResult {
  proposal_id: string;
  sender: string;
}

export interface VoteAckResult extends ProposalAckResult {
  vote: string;
}

export interface CommitAckResult extends AckResult {
  sender: string;
}

export interface SessionResult {
  session_id: string;
  mode: string;
  state: string;
  initiator: string;
  participants: string[];
  mode_version: string;
  configuration_version: string;
  policy_version: string;
  started_at_unix_ms: number;
  expires_at_unix_ms: number;
  you: string;
  phase: string;
  proposals: { proposal_id: string; option: string; rationale: string; sender: string }[];
  evaluations: { proposal_id: string; recommendation: string; confidence: number; reason: string; sender: string }[];
  objections: { proposal_id: string; reason: string; severity: string; sender: string }[];
  votes: { proposal_id: string; vote: string; reason: string; sender: string }[];
  approve_totals: Record<string, number>;
  majority_winner: string | null;
  blocking_objection: boolean;
  committed: boolean;
  history: { message_type: string; sender: string; message_id: string }[];
}

export interface CommitmentView {
  commitment_id: string;
  action: string;
  authority_scope: string;
  reason: string;
  outcome_positive: boolean;
  mode_version: string;
  policy_version: string;
  configuration_version: string;
  supersedes?: { session_id: string; commitment_hash: string };
}

export interface CommitmentResult {
  session_id: string;
  state: string;
  found: boolean;
  sender?: string;
  message_id?: string;
  commitment?: CommitmentView;
  payload_b64?: string;
  commitment_hash?: string;
  hash_label?: string;
}

export interface VerifyResult {
  outcome: VerifyOutcome;
  claimed_hash: string;
  recomputed_hash: string | null;
  hash_label: string;
  source: VerifySource;
  session_id?: string;
}
