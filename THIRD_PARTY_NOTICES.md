# Third-party code

Orb copies or adapts code from these MIT-licensed projects. Their licenses require this notice.

## dsh-orb-cordis: https://github.com/mini-yifan/dsh-orb-cordis

Used in:
- `src/main/geometry.js`: copied from `packages/helper/src/geometry.ts`, with TypeScript types stripped and the panel resized to 340×460.
- `test/geometry.test.js`: copied from `packages/helper/tests/geometry.test.ts`, with types stripped and otherwise unchanged.
- `src/main/main.js`: window options and drag/dock IPC, adapted from `packages/helper/src/main.ts`.
- `src/renderer/app.js`, `src/renderer/styles.css`: hover/pin/drag/dock gesture logic and ball/dock-tab styles, adapted from `packages/helper/assets/shell.js` and `floating.css`.

```
MIT License

Copyright (c) 2026 mini-yifan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## obsidian-tasks: https://github.com/obsidian-tasks-group/obsidian-tasks

`src/core/format.js`: the task-line regular expressions, from `src/Task/TaskRegularExpressions.ts`. MIT License, Copyright (c) the obsidian-tasks contributors.

## todo-md-mcp: https://github.com/danjdewhurst/todo-md-mcp

`src/mcp/tools.js`: the MCP server's structure (Markdown-file-backed tools for Claude Desktop) follows this project. Its storage code was not used, because it rewrites the whole file and would erase sections and notes. MIT License, Copyright (c) 2025 Daniel Dewhurst.

## Libraries (installed from npm, unmodified)

ical.js (MPL-2.0), chrono-node (MIT), @modelcontextprotocol/sdk (MIT), zod (MIT), Electron (MIT).
