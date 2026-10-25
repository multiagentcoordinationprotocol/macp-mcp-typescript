import { vi } from 'vitest';
import {
  Auth,
  MacpClient,
  MacpTimeoutError,
  MODE_DECISION,
  buildEnvelope,
  type Ack,
  type Envelope,
  type MacpStream,
  type SessionMetadata,
} from 'macp-sdk-typescript';
import { MacpBridge } from '../../src/bridge';
import { defaultSettings, type Settings } from '../../src/config';

/** A replay stream fed from a fixed list; `read` times out (or ends) once the list is drained. */
export class FakeStream {
  subscribed: { sessionId: string; afterSequence: number }[] = [];
  closed = false;
  constructor(
    private readonly items: (Envelope | Error)[],
    private readonly atEnd: 'timeout' | 'end' = 'timeout',
  ) {}
  async sendSubscribe(sessionId: string, afterSequence = 0): Promise<void> {
    this.subscribed.push({ sessionId, afterSequence });
  }
  async read(timeoutMs?: number): Promise<Envelope | null> {
    const item = this.items.shift();
    if (item instanceof Error) throw item;
    if (item) return item;
    if (this.atEnd === 'end') return null;
    throw new MacpTimeoutError(`stream read timed out after ${timeoutMs}ms`);
  }
  close(): void {
    this.closed = true;
  }
}

export const SID = 'sess-unit-test-0000000001';

export const METADATA: SessionMetadata = {
  sessionId: SID,
  mode: MODE_DECISION,
  state: 'SESSION_STATE_OPEN',
  initiator: 'alice',
  participants: ['alice', 'bob'],
  modeVersion: '1.0.0',
  configurationVersion: 'config.default',
  policyVersion: 'policy.default',
  startedAtUnixMs: '1700000000000',
  expiresAtUnixMs: '1700000300000',
};

export interface Harness {
  bridge: MacpBridge;
  client: MacpClient;
  sent: Envelope[];
  streams: FakeStream[];
  setHistory(items: (Envelope | Error)[], atEnd?: 'timeout' | 'end'): void;
  setMetadata(metadata: SessionMetadata): void;
  setAck(ack: (envelope: Envelope) => Ack): void;
}

export function harness(overrides: Partial<Settings> = {}, clock?: () => number): Harness {
  const settings = defaultSettings({ agentId: 'alice', allowInsecure: true, replayIdleMs: 5, ...overrides });
  const client = new MacpClient({
    address: '127.0.0.1:1',
    secure: false,
    allowInsecure: true,
    auth: Auth.devAgent(settings.agentId),
  });
  const sent: Envelope[] = [];
  const streams: FakeStream[] = [];
  let history: (Envelope | Error)[] = [];
  let atEnd: 'timeout' | 'end' = 'timeout';
  let metadata = METADATA;
  let ack = (envelope: Envelope): Ack => ({
    ok: true,
    duplicate: false,
    messageId: envelope.messageId,
    sessionId: envelope.sessionId,
    sessionState: envelope.messageType === 'Commitment' ? 'SESSION_STATE_RESOLVED' : 'SESSION_STATE_OPEN',
  });
  vi.spyOn(client, 'send').mockImplementation(async (envelope: Envelope) => {
    sent.push(envelope);
    return ack(envelope);
  });
  vi.spyOn(client, 'getSession').mockImplementation(async () => ({ metadata }));
  vi.spyOn(client, 'openStream').mockImplementation(() => {
    const stream = new FakeStream([...history], atEnd);
    streams.push(stream);
    return stream as unknown as MacpStream;
  });
  const bridge = new MacpBridge(settings, () => client, clock);
  return {
    bridge,
    client,
    sent,
    streams,
    setHistory: (items, end = 'timeout') => {
      history = items;
      atEnd = end;
    },
    setMetadata: (m) => {
      metadata = m;
    },
    setAck: (fn) => {
      ack = fn;
    },
  };
}

let counter = 0;

/** A Decision-mode envelope whose payload is encoded by the real ProtoRegistry. */
export function envelope(
  client: MacpClient,
  messageType: string,
  sender: string,
  payload: Record<string, unknown>,
  sessionId = SID,
): Envelope {
  counter += 1;
  return buildEnvelope({
    mode: MODE_DECISION,
    messageType,
    sessionId,
    sender,
    messageId: `m-${counter}`,
    payload: client.protoRegistry.encodeKnownPayload(MODE_DECISION, messageType, payload),
  });
}
