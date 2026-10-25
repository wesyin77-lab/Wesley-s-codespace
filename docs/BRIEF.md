# Orb — design brief

This is the thinking behind the app. Section 0 describes the video you sent;
sections 1–4 answer your four questions; section 5 is your prompt rewritten so
it contains all of it. The app in this repo is built against section 5.

---

## 0. What the video actually shows (frame by frame)

Watched at 1 frame/sec plus enlarged crops (16 s, 544×960, Instagram post by a
Mac user, dated Tue Oct 20):

| Time | What happens | Detail worth copying |
|---|---|---|
| 0–2 s | "made a to-do list I won't forget to check" | Problem statement: **remembering to look**, not storing tasks |
| 2–4 s | "it lives in this little ball on my desktop" | A small always-on-top circle, over every app |
| 4–8 s | "hover for a quick look" | Hover → a frosted panel: date header ("October 20, Tuesday"), tabs *To-do / Pending / Completed / …*, sections **work · life · content · study**, monospace checkboxes, inline dates ("book flight ticket 10/26", "HW 6 — ddl 10/21") |
| 8–10 s | "it fades so it doesn't cover my work" | Panel goes translucent / disappears when the pointer leaves |
| 10–12 s | "my AI can add tasks from our chats" | In Claude (Opus, High) she types *add "book friday dinner" to my to-do* |
| 12–16 s | "so I don't have to explain it again" | Claude edits `To-Do.md` line 39 **and** `面板.html` line 151; it also offers "我把它排进日历" ("I'll put it in your calendar") and "要不要把时间占下来?" ("should I block out the time?") |

Two things the video does not say out loud:

1. **The data is a Markdown file.** That is why the AI can edit it. This is the
   right choice, so Orb keeps it.
2. **The AI edits the HTML at a line number.** That is brittle: one stray edit
   breaks the panel. Orb fixes this. The AI only ever touches the Markdown,
   through validated tools, and the panel re-renders itself.

Later, the creator's own page (lilian.world, from your screenshot) named the four
features: *always there · one-glance check ("the number tells you what's left") ·
stays out of the way (pin it; it fades) · AI can reach it too*. Orb implements all
four, and the calendar on top.

### What was reused from GitHub instead of written from scratch

| Repo | License | Used for |
|---|---|---|
| mini-yifan/dsh-orb-cordis (279★) | MIT | Ball geometry, drag, hover/pin, edge docking. Copied, with its 23 tests passing unchanged |
| obsidian-tasks-group/obsidian-tasks | MIT | Task-line regex, so Obsidian and Orb agree on what a task is |
| danjdewhurst/todo-md-mcp | MIT | MCP server structure. **Not** its storage: it rewrites the whole file, which would erase your sections |
| BUG-gao/floating-todo (closest finished app) | **none** | Not copied: no license means all rights reserved |

---

## 1. What top experts would do that you didn't ask for

**Treat "remembering to check" as the real problem, not "storing tasks".**
Psychologists call this *prospective memory*, meaning remembering to do
something later. People mostly fail at it because no cue reaches them at the
right moment, not because the list was lost. Experts would do three things:

- **Ambient cue.** The ball shows how many tasks are left (the creator's own
  page: "the number tells you what's left"). Its ring turns red when something
  is overdue and amber when something is due today. You get the information
  without opening anything.
  This is "calm technology" (Weiser & Brown, 1995): information lives at the
  edge of attention and moves to the centre only when it matters.
- **Time-based cue.** A notification fires when a planned block starts or a
  timed task is due.
- **Timeboxing.** A task becomes far more likely to get done once it has a
  *when*. Gollwitzer's research on *implementation intentions* ("when X
  happens, I'll do Y") shows this, with medium-to-large effects across ~94
  studies. This is exactly what the AI in the video offers ("should I block
  out the time?"). So the calendar here isn't decoration. It is where a task
  turns into a plan.

**Make the plain file the single source of truth ("local-first").** Kleppmann
et al. (2019) set out the ideals: your data is a readable file you own, it works
offline, and it outlives the app. Experts would also
- reuse an existing syntax instead of inventing one: GitHub-style task lists
  (`- [ ]`) plus `key:value` tags in the style of todo.txt,
- **preserve anything the user hand-writes** (notes, blank lines, odd
  formatting). The parser must round-trip byte-for-byte,
- write atomically (temp file + rename), keep rolling backups, and log *who*
  changed what (you, or Claude). Then you can trust AI edits instead of
  re-checking them.

**Give the AI a proper interface, not a text file to poke at.** The Model
Context Protocol (MCP) lets Claude Desktop and Claude Code call named tools
(`add_task`, `find_free_time`, `plan_task`, …) whose inputs are validated. The
AI can't corrupt the file. It also gets back structured answers, such as "these
two tasks match, which one?", instead of guessing.

**Use the calendar you already have.** Don't build a calendar database nobody
syncs. Read your real calendars through their iCalendar (RFC 5545) feeds:
Google Calendar's "secret address in iCal format", iCloud, and school LMS feeds
(Canvas, Schoology). Publish Orb's own due dates and time blocks *back* as an
`.ics` feed that Apple or Google Calendar can subscribe to. Recurring events
and time zones are where hand-written calendar code breaks, so use Mozilla's
`ical.js` (the parser behind Thunderbird).

**Respect accessibility rules for hover UI.** A panel that appears on hover
must pass WCAG 2.2 SC 1.4.13 *Content on Hover or Focus*: it must be
dismissible (Esc), stay open while the pointer is over it, and persist until
dismissed. It also needs a keyboard path (a global hotkey), must honour
`prefers-reduced-motion`, and needs ≥ 4.5:1 text contrast. The panel in the
video is translucent and low-contrast, which looks nice and reads badly. Orb
fades only when you are *not* looking at it, and is fully opaque while you are.

**Treat it as security-sensitive desktop software.** An always-on-top window
that fetches URLs and writes files follows the Electron security checklist:
context isolation, sandbox, no Node in the page, a strict Content Security
Policy, and loopback-only networking.

**Measure whether it works.** Experts ask "did I finish more, and did fewer
things go overdue?", not just "does it run". Orb keeps an activity log, so you
can compare a baseline week with the weeks after.

## 2. Primary, original sources (not pre-digested ones)

| Need | Primary source |
|---|---|
| What to build | The original video and its creator's actual artefacts (`To-Do.md`, the HTML panel, the Claude chat) |
| What *you* actually have to do | Your real task inputs: your school LMS calendar feed (Canvas/Schoology export an `.ics`), your Google Calendar, assignment emails, your current notes. Not tidy example lists |
| Calendar format | IETF **RFC 5545** (iCalendar), RFC 7986 (extensions), RFC 4791 (CalDAV) |
| Task format | GitHub-Flavored Markdown spec §5.3 *Task list items*; todo.txt format spec (Gina Trapani) |
| AI integration | **Model Context Protocol specification** (modelcontextprotocol.io) and the official TypeScript SDK source |
| Desktop windowing | Electron API docs / `electron.d.ts` type definitions (`BrowserWindow`, `setAlwaysOnTop` levels, `setVisibleOnAllWorkspaces`), Electron **Security** checklist; Apple Human Interface Guidelines (panels) |
| Accessibility | **WCAG 2.2**: SC 1.4.3 contrast, 1.4.13 content on hover/focus, 2.1.1 keyboard, 2.3.3 animation from interactions |
| Behavioural evidence | Gollwitzer (1999) *Implementation intentions*, Am. Psychologist 54(7); Gollwitzer & Sheeran (2006) meta-analysis; Masicampo & Baumeister (2011) "Consider it done!" (making a plan reduces intrusive thoughts about unfinished goals); Weiser & Brown (1995) *Designing Calm Technology*; Kleppmann et al. (2019) *Local-first software* |

## 3. Methods and tools

- **Electron** (one codebase → macOS + Windows) with a frameless, transparent,
  always-on-top window that resizes between "ball" and "panel"; custom drag
  instead of `-webkit-app-region` (which swallows hover).
- **Line-preserving Markdown parser** for tasks; atomic writes; rolling
  backups; an append-only activity log tagged by source (`panel`, `claude`,
  `file`).
- **chrono-node** for natural-language quick add ("dinner fri 7pm #life"), with
  a live preview of what it understood before you press Enter.
- **ical.js** for reading feeds (RRULE/EXDATE/TZID expansion) and writing
  Orb's own feed; a loopback HTTP server so Calendar apps can *subscribe*
  rather than one-time import.
- **@modelcontextprotocol/sdk** stdio server with **zod**-validated tools; a
  one-click "Connect to Claude Desktop" button that merges the config (with a
  backup).
- **Tests:** Node's built-in test runner; **fast-check** property tests
  (random files must round-trip exactly); ICS fixtures covering recurrence,
  time zones and all-day events; an MCP client↔server test; **Playwright**
  driving the real Electron app under Xvfb with screenshots; **axe-core**
  accessibility audit of the panel.
- **GitHub Actions**: tests on Linux, plus real builds on macOS and Windows
  runners that produce downloadable installers.

## 4. What, beyond you and me, can verify it's correct

- **Other software reading the same data.** The `.md` file opens in VS Code,
  Obsidian, or on GitHub, which render the checkboxes independently. Apple
  Calendar / Google Calendar subscribing to Orb's `.ics` feed are independent
  judges of the calendar output; the icalendar.org validator is another.
- **Clean machines.** GitHub Actions runners (macOS, Windows, Linux) build and
  test it from scratch on every push.
- **Official tooling.** The MCP Inspector (`npx @modelcontextprotocol/inspector`)
  checks the tool schemas; axe-core / WebAIM's contrast checker check
  accessibility; Doyensec's Electronegativity scans the Electron setup.
- **Property tests.** fast-check generates thousands of files nobody wrote by
  hand.
- **Reality.** Your own activity log after two weeks (completed vs overdue
  compared with your baseline week), and a friend using it without
  instructions.

---

## 5. Your prompt, revised

> Build me **Orb**, a desktop to-do app for macOS and Windows modelled on
> [this video]: a small ball that floats above all windows and expands into a
> task panel on hover. My real problem is *forgetting to check* my list and
> *not giving tasks a time*, so optimise for those, not for features.
>
> **Core loop:** capture → see → schedule → finish.
>
> 1. **See (ambient).** A draggable, always-on-top ball, on every desktop/Space
>    and over full-screen apps, showing how many tasks are left, with a ring
>    that turns red for overdue and amber for due today (the number and an
>    accessible label carry the meaning, not colour alone). Hover
>    expands it into a panel with today's date, tabs **To-do · Calendar ·
>    Done**, and my sections (**work, life, content, study**). It collapses
>    after I leave, or stays pinned if I click the ball. When pinned it dims
>    while I'm not using it and is fully opaque when I am. Esc dismisses it. A
>    global hotkey opens it with the cursor in quick add. Follow WCAG 2.2 SC
>    1.4.13, keep text contrast ≥ 4.5:1, and honour reduced motion.
> 2. **Capture.** A quick-add box that understands natural language
>    ("book friday dinner fri 7pm #life") and shows what it parsed before I
>    commit. **My AI must be able to add, find, complete, reschedule and plan
>    tasks from our chats** through an MCP server (Claude Desktop + Claude
>    Code), with validated tools and clear errors for ambiguous matches, never
>    by editing UI code. Include one-click setup for Claude Desktop and the
>    command for Claude Code.
> 3. **Schedule (calendar).** A Calendar tab with a month grid and a day
>    agenda that merges (a) tasks due that day, (b) time blocks I've planned
>    for tasks, and (c) read-only events from my real calendars via iCalendar
>    (RFC 5545) feed URLs (Google, iCloud, Canvas/Schoology), with recurrence
>    and time zones handled by a proven library. The AI gets a
>    `find_free_time` tool so it can propose and book a block. Orb publishes
>    my due dates and blocks as an `.ics` feed my calendar app can subscribe
>    to. Notify me when a block starts or a timed task is due.
> 4. **Finish.** Checking a task records the completion date; the Done tab
>    shows recent wins.
>
> **Data (local-first).** Everything lives in one human-readable Markdown file
> (`- [ ] task due:2026-10-27 plan:2026-10-26T19:00/45m`) that I or any AI can
> edit by hand. The app watches it and updates live, preserves anything it
> doesn't understand byte-for-byte, writes atomically, keeps rolling backups,
> and logs every change with its source (me / Claude / external edit). Document
> the format so any AI can follow it.
>
> **Engineering bar.** Electron with the security checklist (context
> isolation, sandbox, CSP, loopback only). Unit tests, property-based
> round-trip tests for the file format, ICS fixture tests (recurrence, TZ,
> all-day), an MCP client↔server test, and an end-to-end test that launches
> the real app, takes screenshots and runs an axe accessibility audit. CI on
> GitHub Actions that runs the tests and builds downloadable macOS and Windows
> installers.
>
> **Verification beyond the author.** The `.md` must render correctly in
> GitHub/Obsidian; the `.ics` feed must parse in ical.js and import cleanly
> into Apple/Google Calendar; MCP tools must work in the official MCP
> Inspector; CI must pass on clean macOS/Windows machines.
>
> **Success after 2 weeks of use:** fewer overdue items than my baseline week,
> and I never have to open a separate app to know what's due today.
>
> **Out of scope (deeper, not bigger):** accounts, cloud sync servers,
> collaboration, mobile apps, recurring *tasks*, priorities, tags beyond
> sections.
