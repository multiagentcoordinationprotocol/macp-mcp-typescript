/**
 * A stub upstream MCP server for gate tests (stdio). Tools:
 * - echo {text}: returns the text, with `_meta: {"stub/seen": true}` so the
 *   gate's _meta merge is observable.
 * - add {a, b}: returns a + b.
 * Every tools/call is appended as one JSON line to $STUB_CALL_LOG (if set),
 * so tests can assert whether the upstream was called at all.
 */

import * as fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'stub-upstream', version: '0.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo the text back.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    {
      name: 'add',
      description: 'Add two numbers.',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, (request) => {
  const { name, arguments: args = {} } = request.params;
  if (process.env.STUB_CALL_LOG) {
    fs.appendFileSync(process.env.STUB_CALL_LOG, `${JSON.stringify({ name, arguments: args })}\n`);
  }
  if (name === 'echo') {
    return { content: [{ type: 'text', text: String(args.text) }], _meta: { 'stub/seen': true } };
  }
  if (name === 'add') {
    const sum = Number(args.a) + Number(args.b);
    return { content: [{ type: 'text', text: String(sum) }], structuredContent: { sum } };
  }
  return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
});

void server.connect(new StdioServerTransport());
