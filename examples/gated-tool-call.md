# Gated tool call: a transcript

A real run of `macp-mcp gate` in front of the stub upstream used by the
integration tests (`tests/fixtures/stub-upstream.ts`, tools `echo` and `add`),
against a local `ghcr.io/multiagentcoordinationprotocol/macp-runtime:0.9.0`
started with `MACP_ALLOW_INSECURE=1`. Two approvers, `alice` and `bob`, are
plain MACP agents that vote through the runtime. Session ids and hashes are
from that run, so yours will differ.

## Setup

`gate.json`:

```json
{
  "version": 1,
  "server": "stub",
  "rules": [
    {
      "tool": "echo",
      "mode": "macp.mode.quorum.v1",
      "participants": ["alice", "bob"],
      "threshold": 2,
      "ttl_ms": 60000
    },
    { "tool": "slow*", "mode": "macp.mode.quorum.v1", "participants": ["alice"], "ttl_ms": 1500 }
  ]
}
```

The MCP client (here a script; in practice Claude Desktop, an IDE or an agent)
launches the gate as its server:

```bash
MACP_RUNTIME_TARGET=127.0.0.1:50051 MACP_AGENT_ID=gate MACP_ALLOW_INSECURE=1 \
  macp-mcp gate --policy gate.json --upstream node --import tsx tests/fixtures/stub-upstream.ts
```

## 1. An ungated call passes straight through

`tools/call` `add {"a": 2, "b": 3}` matches no rule, so the upstream answers
directly and no session is opened:

```json
{ "content": [{ "type": "text", "text": "5" }], "structuredContent": { "sum": 5 } }
```

## 2. Approved: the call is forwarded with its commitment

`tools/call` `echo {"text": "deploy v1.2 to prod"}` matches the first rule.
The gate computes the call's binding:

```text
preimage   {"arguments":{"text":"deploy v1.2 to prod"},"server":"stub","tool":"echo"}
context_id sha256:d6d246b0c7fc085b2f06d60e437df1f5016f572a0b14b7c2301790792b86429b
```

and opens a Quorum session. This is what `alice` sees when she lists sessions:

```json
{
  "session_id": "45f2739e-6e02-44d5-a7c3-29e8c59942d5",
  "mode": "macp.mode.quorum.v1",
  "initiator": "gate",
  "participants": ["alice", "bob"],
  "context_id": "sha256:d6d246b0c7fc085b2f06d60e437df1f5016f572a0b14b7c2301790792b86429b"
}
```

The session's ApprovalRequest carries `request_id` = the context_id, `action`
`tools/call:echo`, `summary` `stub/echo` and the preimage as `details`, so an
approver can recompute the context_id before voting. `alice` and `bob` each
send `Approve`. With two approvals the threshold is met, the gate commits
`macp.gate.approve`, forwards the call, and returns the upstream's result with
the commitment added beside the upstream's own `_meta` key:

```json
{
  "_meta": {
    "stub/seen": true,
    "io.multiagentcoordinationprotocol/commitment": {
      "session_id": "45f2739e-6e02-44d5-a7c3-29e8c59942d5",
      "mode": "macp.mode.quorum.v1",
      "outcome": "approve",
      "commitment_hash": "sha256:69fcce4ddda43cccfa692136a90a154c50576ce1eda904ab2654c347b671e944"
    }
  },
  "content": [{ "type": "text", "text": "deploy v1.2 to prod" }]
}
```

Anyone holding the session id can check the hash, for example with the base
server's `verify` tool (`{"commitment_hash": "sha256:69fc…", "session_id":
"45f2739e-…"}` → `"outcome": "match"`).

## 3. Rejected: POLICY_DENIED, upstream never called

`echo {"text": "drop table users"}` opens a second session. `alice` approves
and `bob` rejects. Two approvals out of two are now out of reach, so the gate
commits `macp.gate.deny` and refuses the call:

```json
{
  "content": [
    {
      "type": "text",
      "text": "POLICY_DENIED: tool call echo denied by session 14ca9eab-5126-4789-9a43-8b98aec29943 (commitment sha256:ca87e5d23ce9f99f0bddba3be8b17e6650832ab4badf31695617a364032e346d)"
    }
  ],
  "isError": true
}
```

## 4. Nobody votes: SESSION_NOT_OPEN

`slowpoke {}` matches `slow*` with a 1.5 s TTL. No ballot arrives, the runtime
expires the session, and the gate refuses the call without a commitment:

```json
{
  "content": [
    {
      "type": "text",
      "text": "SESSION_NOT_OPEN: session fe667ef0-b9dd-4d03-90a5-504828a590b0 ended EXPIRED without a commitment; tool call slowpoke was not forwarded"
    }
  ],
  "isError": true
}
```

If the runtime has not ended the session 5 s after its TTL, the gate cancels
it itself and the refusal says `ended CANCELLED`.
