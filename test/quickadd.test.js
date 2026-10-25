import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { quickAdd } from '../src/core/quickadd.js'

// Sunday 25 October 2026, 10:00 local.
const now = new Date(2026, 9, 25, 10, 0)
const sections = ['work', 'life', 'content', 'study']
const qa = (text) => quickAdd(text, { now, sections })

describe('quick add', () => {
  it('the video\'s example keeps its title and picks up Friday', () => {
    const r = qa('book friday dinner #life')
    assert.equal(r.title, 'book friday dinner')
    assert.equal(r.due, '2026-10-30')
    assert.equal(r.section, 'life')
    assert.equal(r.newSection, false)
  })

  it('a trailing date with a time is removed from the title', () => {
    assert.deepEqual(
      (({ title, due }) => ({ title, due }))(qa('dentist next tuesday 4:30pm')),
      { title: 'dentist', due: '2026-10-27T16:30' },
    )
  })

  it('"at 3" means 3 pm', () => {
    const r = qa('call mom tomorrow at 3')
    assert.equal(r.title, 'call mom')
    assert.equal(r.due, '2026-10-26T15:00')
  })

  it('a month/day that just passed is this year (overdue), not next year', () => {
    const r = qa('HW 6 due 10/21 #study')
    assert.equal(r.title, 'HW 6')
    assert.equal(r.due, '2026-10-21')
  })

  it('a month/day a few weeks out stays in the future, even across New Year', () => {
    assert.equal(qa('study for AP chem test on Nov 3').due, '2026-11-03')
    assert.equal(qa('return library books jan 5').due, '2027-01-05')
  })

  it('no date, no due', () => {
    const r = qa('weekly report #Work')
    assert.deepEqual([r.title, r.due, r.section], ['weekly report', undefined, 'work'])
  })

  it('a new #section is flagged so the preview can say so', () => {
    const r = qa('call grandma #family')
    assert.equal(r.section, 'family')
    assert.equal(r.newSection, true)
  })

  it('quoted text is never read as a date', () => {
    const r = qa('watch "friday night lights"')
    assert.equal(r.title, 'watch friday night lights')
    assert.equal(r.due, undefined)
  })

  it('explicit tags win over guessing', () => {
    const r = qa('essay due:2026-11-02 plan:2026-11-01T19:00/2h')
    assert.equal(r.title, 'essay')
    assert.equal(r.due, '2026-11-02')
    assert.deepEqual(r.plan, { start: '2026-11-01T19:00', minutes: 120 })
  })
})
