/**
 * Environment-driven configuration for the macp-mcp server.
 *
 * One server process is one MACP agent. Every setting comes from the
 * environment, because MCP clients (Claude Desktop, Claude Code, Cursor)
 * launch the server as a subprocess and pass configuration through an `env`
 * block, not flags. Same variables, defaults and validation as the Python
 * macp-mcp (`macp_mcp/config.py`).
 */

import * as fs from 'node:fs';
import { Auth, type AuthConfig } from 'macp-sdk-typescript';

export const DEFAULT_TARGET = '127.0.0.1:50051';
export const DEFAULT_AGENT_ID = 'mcp-agent';
export const DEFAULT_TTL_MS = 300_000;
export const DEFAULT_REPLAY_IDLE_MS = 1_000;

const TRUE = new Set(['1', 'true', 'yes', 'on']);

/** Thrown when the environment holds an unusable configuration. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface Settings {
  /** Runtime gRPC address (`host:port`). */
  target: string;
  /** The MACP identity this server acts as (also the dev-agent bearer value). */
  agentId: string;
  /** Bearer token issued by the runtime, or undefined for dev-agent auth. */
  token?: string;
  /** Use a plaintext channel instead of TLS (local development only). */
  allowInsecure: boolean;
  /** PEM bundle for a private CA, or undefined for the system trust store. */
  rootCertificates?: Buffer;
  /** TTL used by `start_session` when the caller passes 0. */
  defaultTtlMs: number;
  /** How long a history replay waits for the next envelope before treating the replay as complete. */
  replayIdleMs: number;
}

export function defaultSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    target: DEFAULT_TARGET,
    agentId: DEFAULT_AGENT_ID,
    allowInsecure: false,
    defaultTtlMs: DEFAULT_TTL_MS,
    replayIdleMs: DEFAULT_REPLAY_IDLE_MS,
    ...overrides,
  };
}

/**
 * The SDK auth config for this agent. A token selects bearer auth bound to
 * `agentId`; no token selects dev-agent auth, whose bearer value is the agent
 * id itself (the runtime's dev fallback binds it verbatim).
 */
export function authFor(settings: Settings): AuthConfig {
  return settings.token
    ? Auth.bearer(settings.token, { expectedSender: settings.agentId })
    : Auth.devAgent(settings.agentId);
}

export function authMode(settings: Settings): 'bearer' | 'dev-agent' {
  return settings.token ? 'bearer' : 'dev-agent';
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = (env[name] ?? '').trim();
  if (!raw) return fallback;
  if (!/^[+-]?\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer, got '${raw}'`);
  const value = Number(raw);
  if (value <= 0) throw new ConfigError(`${name} must be positive, got ${value}`);
  return value;
}

/**
 * Build {@link Settings} from `env` (defaults to `process.env`).
 *
 * - `MACP_RUNTIME_TARGET`: runtime address (default `127.0.0.1:50051`).
 * - `MACP_AGENT_ID`: this agent's identity (default `mcp-agent`).
 * - `MACP_AUTH_TOKEN`: bearer token; unset means dev-agent auth.
 * - `MACP_ALLOW_INSECURE`: `1`/`true`/`yes`/`on` for a plaintext channel.
 * - `MACP_TLS_CA_FILE`: PEM file for a private CA (exclusive with insecure).
 * - `MACP_DEFAULT_TTL_MS`: default session TTL (default 300000).
 * - `MACP_REPLAY_IDLE_MS`: replay idle cutoff (default 1000).
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const target = (env.MACP_RUNTIME_TARGET ?? '').trim() || DEFAULT_TARGET;
  const agentId = (env.MACP_AGENT_ID ?? '').trim() || DEFAULT_AGENT_ID;
  const token = (env.MACP_AUTH_TOKEN ?? '').trim() || undefined;
  const allowInsecure = TRUE.has((env.MACP_ALLOW_INSECURE ?? '').trim().toLowerCase());

  let rootCertificates: Buffer | undefined;
  const caFile = (env.MACP_TLS_CA_FILE ?? '').trim();
  if (caFile) {
    if (allowInsecure) throw new ConfigError('MACP_TLS_CA_FILE and MACP_ALLOW_INSECURE are mutually exclusive');
    try {
      rootCertificates = fs.readFileSync(caFile);
    } catch (err) {
      throw new ConfigError(`cannot read MACP_TLS_CA_FILE '${caFile}': ${(err as Error).message}`);
    }
  }

  return {
    target,
    agentId,
    token,
    allowInsecure,
    rootCertificates,
    defaultTtlMs: positiveInt(env, 'MACP_DEFAULT_TTL_MS', DEFAULT_TTL_MS),
    replayIdleMs: positiveInt(env, 'MACP_REPLAY_IDLE_MS', DEFAULT_REPLAY_IDLE_MS),
  };
}
