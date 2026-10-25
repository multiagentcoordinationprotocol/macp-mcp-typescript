export {
  MacpBridge,
  ToolArgumentError,
  defaultClientFactory,
  stateName,
  COMMITMENT_HASH_LABEL,
  REPLAY_MAX_MS,
} from './bridge';
export type { BridgeClient, ClientFactory } from './bridge';
export * from './config';
export { CONTRACT_PATH, loadContract } from './contract';
export type { Contract, ToolContract, ToolAnnotations } from './contract';
export type * from './results';
export { buildServer, errorText, type BuildServerOptions } from './server';
export { VERSION } from './version';
export {
  GateApprover,
  GateRefusal,
  GATE_ACTION_APPROVE,
  GATE_ACTION_DENY,
  GATE_GRACE_MS,
  GATE_PROPOSAL_ID,
  settle,
} from './gate/approval';
export type { GateCommitment, GateOutcome, GatedCall } from './gate/approval';
export { GATE_DEFAULT_TTL_MS, loadGateConfig, matchRule, parseGateConfig, requiredApprovals } from './gate/config';
export type { GateConfig, GateMode, GateRule } from './gate/config';
export { contextIdOf, gateContextId, gatePreimage } from './gate/context-id';
export { GATE_CONTRACT_DIR, loadGateSchema } from './gate/contract';
export { canonicalize, CanonicalizationError } from './gate/jcs';
export { GATE_META_KEY, GATE_SERVER_NAME, buildGateServer, withCommitment } from './gate/proxy';
export type { Approver, Upstream } from './gate/proxy';
export { parseGateArgs, runGate, upstreamEnv } from './gate/cli';
