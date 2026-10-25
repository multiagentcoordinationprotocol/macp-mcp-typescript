# @multiagentcoordinationprotocol/mcp

An MCP server that lets any MCP client (Claude Desktop, Claude Code, Cursor and
others) run or join a [MACP](https://multiagentcoordinationprotocol.io) Decision
session. It is the TypeScript twin of the Python
[macp-mcp](https://github.com/multiagentcoordinationprotocol/macp-mcp). Both
expose the same tool surface: the same names, input schemas and outputs,
pinned by one shared manifest ([Tool contract](#tool-contract)).

MCP decides which tools a model can call. MACP decides who may use them and
when, and records what was decided. The model drives every step through
ordinary MCP tool calls. The MACP runtime enforces who may propose, vote and
commit, ends the session in one binding Commitment, and gives that outcome an
RFC-MACP-0013 hash that anyone can recompute.

```
MCP client (model) ──stdio──▶ macp-mcp ──gRPC──▶ MACP runtime
   tool calls                 one MACP agent       enforces membership, order,
                              (macp-sdk-typescript) identity; records the Commitment
```

## Install

```bash
npx -y @multiagentcoordinationprotocol/mcp     # or: npm i -g @multiagentcoordinationprotocol/mcp
```

Node 20 or newer. The installed binary is called `macp-mcp`, like the Python
server's. It needs a MACP runtime to talk to. For local development:

```bash
docker run -p 50051:50051 -e MACP_ALLOW_INSECURE=1 -e MACP_MEMORY_ONLY=1 \
  ghcr.io/multiagentcoordinationprotocol/macp-runtime:0.9.0
```

One `macp-mcp` process is one MACP agent. For several agents to take part in a
session, run one server per agent (for example, one per MCP client), each with
its own `MACP_AGENT_ID`.

## Configure your MCP client

### Claude Desktop

Add the server to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "macp": {
      "command": "npx",
      "args": ["-y", "@multiagentcoordinationprotocol/mcp"],
      "env": {
        "MACP_RUNTIME_TARGET": "127.0.0.1:50051",
        "MACP_AGENT_ID": "coordinator",
        "MACP_ALLOW_INSECURE": "1"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add macp \
  --env MACP_RUNTIME_TARGET=127.0.0.1:50051 \
  --env MACP_AGENT_ID=coordinator \
  --env MACP_ALLOW_INSECURE=1 \
  -- npx -y @multiagentcoordinationprotocol/mcp
```

Then ask the model something like: *"Start a MACP decision with alice on
which deployment plan to use, propose a canary rollout, and vote for it."*

### Against a production runtime

Drop `MACP_ALLOW_INSECURE` and pass the bearer token the runtime issued for
this agent:

```json
"env": {
  "MACP_RUNTIME_TARGET": "macp.example.com:443",
  "MACP_AGENT_ID": "coordinator",
  "MACP_AUTH_TOKEN": "<token issued for coordinator>"
}
```

## Environment variables

These are the same variables, with the same defaults, as the Python server.

| Variable | Default | Meaning |
|---|---|---|
| `MACP_RUNTIME_TARGET` | `127.0.0.1:50051` | Runtime gRPC address (`host:port`). |
| `MACP_AGENT_ID` | `mcp-agent` | The MACP agent this server acts as. With dev-agent auth it is also the bearer token. With `MACP_AUTH_TOKEN` it is the identity the runtime must bind the token to. |
| `MACP_AUTH_TOKEN` | unset | Bearer token issued by the runtime. When unset, dev-agent auth is used, which needs a runtime started with `MACP_ALLOW_INSECURE=1`. |
| `MACP_ALLOW_INSECURE` | off | `1`/`true`/`yes`/`on` uses plaintext gRPC. For a local runtime only. |
| `MACP_TLS_CA_FILE` | system trust | PEM bundle for a private CA. Cannot be combined with `MACP_ALLOW_INSECURE`. |
| `MACP_DEFAULT_TTL_MS` | `300000` | Session TTL used when `start_session` is called without `ttl_ms`. |
| `MACP_REPLAY_IDLE_MS` | `1000` | How long a history read waits for the next envelope before treating the replay as complete. |

The server logs to stderr only, because stdout carries the MCP protocol. A bad
configuration exits with status 2 and a one-line message.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `start_session` | write | Start a Decision session with this agent as initiator. Takes `intent`, `participants` and optional `ttl_ms` and `context_id`. Returns the `session_id` to share. |
| `propose` | write | Put an option (`proposal_id`, `option`, `rationale`) up for decision. |
| `evaluate` | write | Record a scored assessment (`APPROVE` / `REVIEW` / `BLOCK` / `REJECT`, confidence 0..1) before voting. |
| `vote` | write | Cast this agent's `APPROVE` / `REJECT` / `ABSTAIN` vote on a proposal. |
| `commit` | write | Resolve the session with a binding Commitment (`action`, `authority_scope`, `reason`). Under the default policy only the initiator can commit. |
| `get_session` | read | The session's state, participants, proposals, evaluations, votes, approve totals and majority winner. |
| `get_commitment` | read | The resolved session's binding Commitment, the exact payload bytes (`payload_b64`) and its RFC-MACP-0013 `commitment_hash`. |
| `verify` | read | Recompute a commitment hash with the SDK verifier, either from the runtime's recorded history (`session_id`) or from bytes you hold (`payload_b64`). Returns `match`, `mismatch` or `cannot_verify`. |

Errors the model can act on, such as a runtime rejection or a bad argument,
come back as tool errors with the text `"<CODE>: <message>"`, for example
`FORBIDDEN: Forbidden` when a non-initiator tries to commit. The code is the
MACP error code: the Ack failure code, then the `macp-error-code` trailer, then
the gRPC status name.

The server is stateless. Every read replays the session from the runtime, so a
restart loses nothing, and several servers (agents) can share one session.

## Tool contract

[`contract/tools.json`](contract/tools.json) pins the tool names,
descriptions, annotations, input schemas and output schemas as fully inlined
JSON Schema 2020-12. The Python macp-mcp generates it, and this repo keeps a
byte-identical copy. This server does not derive its schemas from code: it
serves the manifest verbatim from `tools/list` and validates every call's
arguments against it with Ajv, so the advertised surface cannot drift from
the file. The file also ships in the npm package as
`@multiagentcoordinationprotocol/mcp/contract/tools.json`.

CI fails if the copy drifts from the Python repo's (`make verify-contract`).
After a deliberate surface change lands in macp-mcp, run `make sync-contract`
and implement the change here.

## Library use

The package also exports the pieces, for embedding the server in another
process or testing against it:

```ts
import { buildServer, loadSettings } from '@multiagentcoordinationprotocol/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const { server } = buildServer({ settings: loadSettings() });
await server.connect(new StdioServerTransport());
```

## Development

```bash
npm ci
npm run check && npm run lint && npm run format:check
npm test                   # unit tests (fake runtime, in-memory MCP client)
make verify-contract       # contract/tools.json == the Python macp-mcp's

# Acceptance: two stdio MCP clients drive a Decision session to RESOLVED
docker run -d --rm --name macp-runtime-test -p 50051:50051 \
  -e MACP_BIND_ADDR=0.0.0.0:50051 -e MACP_ALLOW_INSECURE=1 -e MACP_MEMORY_ONLY=1 \
  ghcr.io/multiagentcoordinationprotocol/macp-runtime:0.9.0
npx tsx scripts/wait-for-runtime.ts
npm run test:integration
```

Releases follow macp-sdk-typescript: release-please opens the release PR, and
merging it creates the GitHub release, which publishes to npmjs with
provenance.

## License

Apache-2.0
