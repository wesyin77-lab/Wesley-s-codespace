#!/usr/bin/env node
// Entry point Claude starts over stdio:
//   node src/mcp/server.js
// or, from an installed app with no Node: the Orb binary with ELECTRON_RUN_AS_NODE=1.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './tools.js'

await createServer().connect(new StdioServerTransport())
