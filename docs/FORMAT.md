# todo.md format

Orb keeps your whole list in one plain Markdown file (by default
`~/Documents/Orb/todo.md`). You, Orb and any AI can edit it, and Orb picks up changes
within a second. **This page is written so an AI can follow it, too.**

```markdown
# To-do

## work
- [ ] weekly report due:2026-10-27
- [ ] traffic analysis plan:2026-10-26T16:00/45m

## life
- [ ] book friday dinner due:2026-10-30T19:00
- [x] get groceries done:2026-10-25

## study
- [ ] HW 6 due:2026-10-21
Notes like this line are kept exactly as written.
```

| Thing | Syntax | Notes |
|---|---|---|
| Section | `## name` | Tasks belong to the heading above them. `#` (level 1) is just a title. |
| Task | `- [ ] text` | `*`, `+`, `1.` also work (same rules as Obsidian Tasks). |
| Done | `- [x] text done:YYYY-MM-DD` | Orb writes the date when you check it off. |
| Due date | `due:YYYY-MM-DD` or `due:YYYY-MM-DDTHH:MM` | Local time, 24-hour clock. |
| Time block | `plan:YYYY-MM-DDTHH:MM/45m` | Length as `30m`, `2h` or `1h30m`. Shows on the calendar and sends a reminder when it starts. |
| Cancelled | `- [-] text` | Hidden from lists, kept in the file. |

Rules Orb follows when it writes:

- Only the line being changed is rewritten. Everything else, including notes, blank
  lines and odd formatting, stays byte-for-byte the same.
- A tag Orb can't read (say `due:friday`) stays in the title, so nothing you wrote
  disappears.
- A new task goes at the end of its section. A section that doesn't exist is created
  at the end of the file.
- Before every write the old file is copied to `.orb/backups/` (the last 50 are
  kept), and the change is logged in `activity.log` with who made it: `panel`,
  `claude`, or `file` (edited by hand).

## For an AI without the Orb tools

If you can edit files but the Orb MCP tools aren't connected: change only the lines
you need, keep `## section` headings, and use the tags exactly as above. Prefer the
MCP tools when they're available. They validate input and can't corrupt the file.
