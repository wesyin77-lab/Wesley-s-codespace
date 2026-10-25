import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import {
  parse, addTask, updateTask, deleteTask, findByText, findById, formatTask,
  parseDuration, formatDuration, isValidDue, starterFile, TaskNotFoundError, deleteSection,
} from '../src/core/format.js'

// The file from the video, typed out.
const VIDEO = `# To-do

## work
- [ ] weekly report
- [ ] traffic analysis
- [ ] register for Physical AI conference

## life
- [ ] get groceries
- [ ] buy iphone duo cases
- [ ] book flight ticket due:2026-10-26

## content
- [ ] organize raw clips
Notes I wrote by hand stay here.

## study
- [ ] HW 6 due:2026-10-21
`

describe('parse', () => {
  it('reads sections, tasks and tags from the video\'s list', () => {
    const doc = parse(VIDEO)
    assert.deepEqual(doc.sections.map((s) => s.name), ['work', 'life', 'content', 'study'])
    assert.equal(doc.tasks.length, 8)
    const flight = doc.tasks.find((t) => t.title === 'book flight ticket')
    assert.equal(flight.section, 'life')
    assert.equal(flight.due, '2026-10-26')
    assert.equal(doc.tasks.at(-1).section, 'study')
  })

  it('understands every Obsidian-style list marker and status', () => {
    const doc = parse('* [x] a\n+ [ ] b\n1. [ ] c\n2) [-] d\n  - [/] e\n> - [ ] f')
    assert.deepEqual(doc.tasks.map((t) => [t.title, t.done, t.cancelled]), [
      ['a', true, false], ['b', false, false], ['c', false, false], ['d', false, true], ['e', false, false], ['f', false, false],
    ])
  })

  it('leaves invalid tag values in the title instead of dropping them', () => {
    const [task] = parse('- [ ] pay rent due:someday plan:2026-13-01T10:00/1h').tasks
    assert.equal(task.title, 'pay rent due:someday plan:2026-13-01T10:00/1h')
    assert.equal(task.due, undefined)
  })

  it('reads plan blocks and done dates', () => {
    const [task] = parse('- [x] essay due:2026-10-30T23:59 plan:2026-10-29T19:00/1h30m done:2026-10-29').tasks
    assert.equal(task.title, 'essay')
    assert.deepEqual(task.plan, { start: '2026-10-29T19:00', minutes: 90 })
    assert.equal(task.doneDate, '2026-10-29')
    assert.equal(task.done, true)
  })

  it('rejects impossible dates', () => {
    assert.equal(isValidDue('2026-02-30'), false)
    assert.equal(isValidDue('2026-10-26T24:00'), false)
    assert.equal(isValidDue('2026-10-26T23:59'), true)
  })
})

describe('durations', () => {
  it('round-trips', () => {
    for (const m of [1, 45, 60, 90, 120, 1440]) assert.equal(parseDuration(formatDuration(m)), m)
    assert.equal(parseDuration('0m'), undefined)
    assert.equal(parseDuration(''), undefined)
  })
})

describe('addTask', () => {
  it('appends to the end of the named section, keeping everything else byte-for-byte', () => {
    const { text } = addTask(VIDEO, { title: 'book friday dinner', section: 'life' })
    const expected = VIDEO.replace('- [ ] book flight ticket due:2026-10-26\n', '- [ ] book flight ticket due:2026-10-26\n- [ ] book friday dinner\n')
    assert.equal(text, expected)
  })

  it('puts a task after hand-written notes in its section, not inside the next section', () => {
    const { text } = addTask(VIDEO, { title: 'cut reel', section: 'Content' })
    assert.match(text, /Notes I wrote by hand stay here\.\n- \[ \] cut reel\n\n## study/)
  })

  it('creates a missing section at the end', () => {
    const { text } = addTask(VIDEO, { title: 'call grandma', section: 'family' })
    assert.ok(text.endsWith('- [ ] HW 6 due:2026-10-21\n\n## family\n- [ ] call grandma\n'))
  })

  it('works on an empty file and on the starter file', () => {
    assert.equal(addTask('', { title: 'x' }).text, '- [ ] x\n')
    const { text } = addTask(starterFile(), { title: 'x', section: 'study' })
    assert.equal(parse(text).tasks[0].section, 'study')
  })

  it('keeps Windows line endings', () => {
    const crlf = VIDEO.replace(/\n/g, '\r\n')
    const { text } = addTask(crlf, { title: 'x', section: 'work' })
    assert.ok(!/[^\r]\n/.test(text), 'every newline is still CRLF')
  })

  it('validates', () => {
    assert.throws(() => addTask(VIDEO, { title: '  ' }), /needs a title/)
    assert.throws(() => addTask(VIDEO, { title: 'x', due: 'friday' }), /Bad due date/)
    assert.throws(() => addTask(VIDEO, { title: 'x', plan: { start: '2026-10-26', minutes: 30 } }), /Bad plan start/)
  })
})

describe('updateTask', () => {
  const today = '2026-10-25'

  it('completing writes done:<today>; reopening removes it', () => {
    const task = findByText(parse(VIDEO), 'groceries')
    const done = updateTask(VIDEO, task, { done: true }, today)
    assert.match(done, /- \[x\] get groceries done:2026-10-25\n/)
    const again = updateTask(done, findByText(parse(done), 'groceries', { includeDone: true }), { done: false }, today)
    assert.equal(again, VIDEO)
  })

  it('sets and clears due and plan', () => {
    const task = findByText(parse(VIDEO), 'weekly report')
    const planned = updateTask(VIDEO, task, { due: '2026-10-27', plan: { start: '2026-10-26T19:00', minutes: 45 } }, today)
    assert.match(planned, /- \[ \] weekly report due:2026-10-27 plan:2026-10-26T19:00\/45m\n/)
    const cleared = updateTask(planned, findByText(parse(planned), 'weekly'), { due: null, plan: null }, today)
    assert.equal(cleared, VIDEO)
  })

  it('moves a task to another section', () => {
    const task = findByText(parse(VIDEO), 'HW 6')
    const moved = updateTask(VIDEO, task, { section: 'work' }, today)
    const doc = parse(moved)
    assert.equal(findByText(doc, 'HW 6').section, 'work')
    assert.equal(doc.tasks.length, 8)
  })

  it('keeps a trailing Obsidian block link last', () => {
    const text = '- [ ] read chapter ^abc123\n'
    const out = updateTask(text, parse(text).tasks[0], { due: '2026-11-01' }, today)
    assert.equal(out, '- [ ] read chapter due:2026-11-01 ^abc123\n')
  })
})

describe('finding tasks', () => {
  it('prefers exact, then prefix, then substring, and reports ambiguity', () => {
    const doc = parse('- [ ] book\n- [ ] book flight\n- [ ] book hotel\n')
    assert.equal(findByText(doc, 'book').title, 'book')
    assert.equal(findByText(doc, 'book f').title, 'book flight')
    assert.throws(() => findByText(doc, 'boo'), (e) => e instanceof TaskNotFoundError && e.candidates.length === 3)
    assert.throws(() => findByText(doc, 'zzz'), TaskNotFoundError)
  })

  it('an id stops working when its line changed, but follows a line that only moved', () => {
    const doc = parse(VIDEO)
    const task = findByText(doc, 'traffic')
    const edited = VIDEO.replace('traffic analysis', 'traffic analysis v2')
    assert.throws(() => findById(parse(edited), task.id), TaskNotFoundError)
    const shifted = `\n${VIDEO}`
    assert.equal(findById(parse(shifted), task.id).title, 'traffic analysis')
  })

  it('deleteTask removes exactly one line', () => {
    const task = findByText(parse(VIDEO), 'clips')
    const out = deleteTask(VIDEO, task)
    assert.equal(out.split('\n').length, VIDEO.split('\n').length - 1)
    assert.ok(out.includes('Notes I wrote by hand'))
  })
})

describe('properties (fast-check)', () => {
  const lineArb = fc.oneof(
    fc.string(),
    fc.constantFrom('## work', '## life', '', '- [ ] a', '- [x] b done:2026-01-02', '  * [ ] c due:2026-10-26', 'note'),
    fc.tuple(fc.constantFrom('- [ ] ', '- [x] ', '1. [ ] '), fc.string()).map(([a, b]) => a + b),
  )
  const fileArb = fc.tuple(fc.array(lineArb, { maxLength: 30 }), fc.constantFrom('\n', '\r\n'))
    .map(([lines, eol]) => lines.map((l) => l.replace(/[\r\n]/g, '')).join(eol))

  it('adding then deleting a task gives back the original file (ignoring a final newline)', () => {
    fc.assert(fc.property(fileArb, fc.constantFrom('work', 'life', 'new one', ''), (file, section) => {
      const added = addTask(file, { title: 'zz-probe-zz', section })
      const doc = parse(added.text)
      const task = doc.tasks.find((t) => t.title === 'zz-probe-zz')
      assert.ok(task, 'the added task is found')
      const back = deleteTask(added.text, task)
      const norm = (s) => s.replace(/(\r?\n)+$/, '')
      // A brand-new section heading stays behind; everything else must be untouched.
      if (parse(file).sections.some((s) => s.name.toLowerCase() === (section || parse(file).sections[0]?.name || '').toLowerCase()) || !section) {
        assert.equal(norm(back), norm(file))
      } else {
        assert.ok(norm(back).startsWith(norm(file).trimEnd()))
      }
    }), { numRuns: 500 })
  })

  it('editing a task never changes any other line', () => {
    fc.assert(fc.property(fileArb, (file) => {
      const doc = parse(file)
      fc.pre(doc.tasks.length > 0)
      const task = doc.tasks[0]
      const out = updateTask(file, task, { due: '2026-12-01' }, '2026-10-25')
      const a = file.split(/\r?\n/)
      const b = out.split(/\r?\n/)
      assert.equal(a.length, b.length)
      a.forEach((line, i) => { if (i !== task.line) assert.equal(b[i], line) })
    }), { numRuns: 500 })
  })

  it('formatTask output parses back to the same fields', () => {
    const titleArb = fc.string({ minLength: 1 }).map((s) => s.replace(/[\r\n]/g, ' ').replace(/\s+/g, ' ').trim())
      .filter((s) => s && !/(^|\s)(due|plan|done):/.test(s) && !/ \^[a-zA-Z0-9-]+$/.test(` ${s}`))
    fc.assert(fc.property(titleArb, fc.option(fc.constantFrom('2026-10-26', '2026-10-26T09:30')), (title, due) => {
      const line = formatTask({ title, due: due ?? undefined })
      const [task] = parse(line).tasks
      assert.equal(task.title, title)
      assert.equal(task.due, due ?? undefined)
    }), { numRuns: 500 })
  })
})

describe('deleteSection', () => {
  it('removes an empty section and the blank line with it', () => {
    const text = '## work\n- [ ] a\n\n## studdy\n\n## study\n- [ ] b\n'
    assert.equal(deleteSection(text, 'studdy'), '## work\n- [ ] a\n\n## study\n- [ ] b\n')
  })

  it('refuses while open tasks are left, and changes nothing', () => {
    assert.throws(() => deleteSection(VIDEO, 'life'), /still has 3 tasks/)
  })

  it('keeps finished tasks (they join the section above)', () => {
    const text = '## work\n- [ ] a\n\n## old\n- [x] done thing done:2026-10-01\n'
    const out = deleteSection(text, 'OLD')
    assert.equal(out, '## work\n- [ ] a\n- [x] done thing done:2026-10-01\n')
    assert.equal(parse(out).tasks.length, 2)
  })

  it('says so when the section does not exist', () => {
    assert.throws(() => deleteSection(VIDEO, 'nope'), /no section called "nope"/)
  })
})
