import { createHash } from 'node:crypto';
import { canonicalize } from './jcs';

/**
 * The JCS (RFC 8785) form of `{"arguments", "server", "tool"}` for one call.
 * Approvers see it on the wire (ApprovalRequest.details / Proposal.rationale)
 * and can recompute the context_id from it.
 */
export function gatePreimage(server: string, tool: string, args: Record<string, unknown> | undefined): string {
  return canonicalize({ arguments: args ?? {}, server, tool });
}

/** SessionStartPayload.context_id for one call: `sha256:` + lowercase hex SHA-256 of {@link gatePreimage}. */
export function gateContextId(server: string, tool: string, args: Record<string, unknown> | undefined): string {
  return contextIdOf(gatePreimage(server, tool, args));
}

export function contextIdOf(preimage: string): string {
  return `sha256:${createHash('sha256').update(preimage, 'utf8').digest('hex')}`;
}
