// Launches the real Electron app and uses it the way a person would.
// Run: npm run e2e   (on Linux CI it runs under xvfb-run)
import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const axeSource = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8')
const shots = join(process.cwd(), 'docs', 'screenshots')

const pad = (n) => String(n).padStart(2, '0')
const day = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const utc = (offset, hour) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  d.setHours(hour, 0, 0, 0)
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

// The list from the video, with dates relative to today so the test means the same thing every day.
const TODO = `# To-do

## work
- [ ] weekly report due:${day(2)}
- [ ] traffic analysis
- [ ] register for Physical AI conference

## life
- [ ] get groceries due:${day(0)}
- [ ] buy iphone duo cases
- [ ] book flight ticket due:${day(1)} plan:${day(0)}T19:00/30m

## content
- [ ] organize raw clips

## study
- [ ] HW 6 due:${day(-2)}
- [x] read chapter 4 done:${day(0)}
`

const ICS = () => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
  'BEGIN:VEVENT', 'UID:chem@test', `DTSTAMP:${utc(0, 0)}`, `DTSTART:${utc(0, 9)}`, `DTEND:${utc(0, 10)}`, 'SUMMARY:AP Chem', 'LOCATION:Room 204', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:club@test', `DTSTAMP:${utc(0, 0)}`, `DTSTART:${utc(1, 15)}`, `DTEND:${utc(1, 16)}`, 'SUMMARY:Robotics club', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n')

let app
let page
let dir
let feedServer

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orb-e2e-'))
  await mkdir(join(dir, 'data'))
  await mkdir(shots, { recursive: true })
  await writeFile(join(dir, 'data', 'todo.md'), TODO)
  // These tests drive the floating-ball mode (the widget is the same panel, always open).
  await writeFile(join(dir, 'config.json'), JSON.stringify({ mode: 'ball' }))
  feedServer = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/calendar' }).end(ICS()))
  await new Promise((resolve) => feedServer.listen(0, '127.0.0.1', resolve))

  app = await electron.launch({
    args: ['.', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: { ...process.env, ORB_DIR: join(dir, 'data'), ORB_CONFIG: join(dir, 'config.json'), ORB_E2E: '1' },
  })
  page = await app.firstWindow()
  await page.waitForSelector('#ball-count:not(:empty)')
})

test.afterAll(async () => {
  await app?.close()
  feedServer?.close()
})

const todoFile = () => readFile(join(dir, 'data', 'todo.md'), 'utf8')
const windowSize = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())

async function expand() {
  await page.locator('#ball').hover()
  await expect(page.locator('body')).toHaveClass(/expanded/)
  await page.waitForTimeout(400) // let the open animation finish before screenshots
}

test('the ball shows what is left, red because something is overdue', async () => {
  await expect(page.locator('#ball-count')).toHaveText('8')
  await expect(page.locator('#ball')).toHaveClass(/overdue/)
  await expect(page.locator('#ball')).toHaveAttribute('aria-label', /8 to do, 1 overdue, 1 due today/)
  expect((await windowSize()).width).toBe(96)
  await page.screenshot({ path: join(shots, 'ball.png'), omitBackground: true })
})

test('hover opens the panel with sections from the file', async () => {
  await expand()
  expect((await windowSize()).width).toBe(364)
  await expect(page.locator('.section h2')).toHaveText(['work', 'life', 'content', 'study'])
  await expect(page.locator('.task .title').first()).toHaveText('weekly report')
  await expect(page.locator('.chip.overdue')).toContainText('overdue')
  await page.screenshot({ path: join(shots, 'todo.png'), omitBackground: true })
})

test('quick add understands dates and sections, and writes the file', async () => {
  await page.locator('#quick-add').fill('book friday dinner #life')
  await expect(page.locator('#preview')).toContainText('→ life')
  await expect(page.locator('#preview')).toContainText('due')
  await page.screenshot({ path: join(shots, 'quick-add.png'), omitBackground: true })
  await page.locator('#quick-add').press('Enter')
  await expect(page.locator('#ball-count')).toHaveText('9')
  expect(await todoFile()).toMatch(/- \[ \] book flight ticket[^\n]*\n- \[ \] book friday dinner due:\d{4}-\d{2}-\d{2}\n/)
  // Typing pinned the panel so it couldn't collapse mid-sentence.
  await expect(page.locator('body')).toHaveClass(/pinned/)
})

test('checking a task completes it in the file', async () => {
  await page.getByRole('checkbox', { name: 'Complete: get groceries' }).check()
  await expect(page.locator('#ball-count')).toHaveText('8')
  expect(await todoFile()).toContain(`- [x] get groceries done:${day(0)}`)
  await expect(page.locator('#ball')).toHaveAttribute('aria-label', /8 to do, 1 overdue/)
})

test('edits made outside Orb (by hand, or by Claude) show up live', async () => {
  const text = await todoFile()
  await writeFile(join(dir, 'data', 'todo.md'), text.replace('## content\n', '## content\n- [ ] film tiktok about orb\n'))
  await expect(page.locator('.task .title', { hasText: 'film tiktok about orb' })).toBeVisible({ timeout: 6000 })
  await expect(page.locator('#ball-count')).toHaveText('9')
  expect(await readFile(join(dir, 'data', 'activity.log'), 'utf8')).toMatch(/\tfile\tedited outside Orb/)
})

test('planning a task blocks time on it', async () => {
  const row = page.locator('.task', { hasText: 'traffic analysis' })
  await row.hover()
  await row.getByRole('button', { name: 'Plan time for: traffic analysis' }).click()
  const form = row.locator('.plan-form')
  await expect(form).toBeVisible()
  await form.locator('input[type="datetime-local"]').fill(`${day(1)}T16:00`)
  await form.locator('select').selectOption('45')
  await form.getByRole('button', { name: 'Plan' }).click()
  await expect.poll(todoFile).toContain(`- [ ] traffic analysis plan:${day(1)}T16:00/45m`)
})

test('subscribing to a calendar shows its events next to tasks', async () => {
  await page.locator('#settings-button').click()
  await expect(page.locator('#view-settings')).toBeVisible()
  await page.locator('#feed-name').fill('School')
  await page.locator('#feed-url').fill(`http://127.0.0.1:${feedServer.address().port}/school.ics`)
  await page.getByRole('button', { name: 'Add calendar' }).click()
  await expect(page.locator('#feed-list')).toContainText('Up to date')
  await page.screenshot({ path: join(shots, 'settings.png'), omitBackground: true })

  await page.locator('#settings-back').click()
  await page.getByRole('tab', { name: 'Calendar' }).click()
  await expect(page.locator('#agenda')).toContainText('AP Chem')
  await expect(page.locator('#agenda')).toContainText('book flight ticket') // planned block, 19:00
  await page.screenshot({ path: join(shots, 'calendar.png'), omitBackground: true })

  await page.keyboard.press('Tab')
  await page.locator(`#month-grid [data-day="${day(1)}"]`).click()
  await expect(page.locator('#agenda')).toContainText('Robotics club')
  await expect(page.locator('#agenda')).toContainText('traffic analysis')
})

test('Done shows finished work, and reopening works', async () => {
  await page.getByRole('tab', { name: 'Done' }).click()
  await expect(page.locator('#view-done')).toContainText('get groceries')
  await expect(page.locator('.done-summary')).toContainText('2 done in the last 7 days')
  await page.screenshot({ path: join(shots, 'done.png'), omitBackground: true })
})

test('passes an axe WCAG 2.2 AA audit in every view', async () => {
  await page.evaluate(axeSource)
  for (const tab of ['To-do', 'Calendar', 'Done']) {
    await page.getByRole('tab', { name: tab }).click()
    const result = await page.evaluate(() => window.axe.run('#panel', { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }))
    const problems = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)
    expect(problems, `${tab} view`).toEqual([])
  }
})

test('Escape dismisses the panel (WCAG 1.4.13)', async () => {
  await page.getByRole('tab', { name: 'To-do' }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('body')).not.toHaveClass(/expanded/)
  await expect.poll(async () => (await windowSize()).width).toBe(96)
})

test('the published .ics feed contains due dates and planned blocks', async () => {
  const ics = await readFile(join(dir, 'data', 'orb.ics'), 'utf8')
  expect(ics).toContain('SUMMARY:Due: weekly report')
  expect(ics).toContain('SUMMARY:traffic analysis')
  expect(ics).not.toContain('get groceries') // done
})
