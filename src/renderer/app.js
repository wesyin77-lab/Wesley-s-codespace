/* global orb */
/**
 * The panel page. The pointer/gesture state machine (hover to expand, click to
 * pin, drag, dock at a screen edge) is adapted from dsh-orb-cordis (MIT),
 * packages/helper/assets/shell.js. Everything about tasks and the calendar is Orb's.
 */
(() => {
  'use strict'

  const api = window.orb
  // 'widget': always open, fixed on the desktop. 'ball': the floating ball that expands on hover.
  const WIDGET = new URLSearchParams(location.search).get('mode') !== 'ball'
  const COLLAPSE_MS = 350
  const ANIMATION_MS = 300
  const DOCK_HOVER_DELAY_MS = 800
  const DOCK_DRAG_OFF_PX = 24
  const STATUS_MS = 4000

  const $ = (sel) => document.querySelector(sel)
  const ball = $('#ball')
  const ballCount = $('#ball-count')
  const dockTab = $('#dock-tab')
  const panel = $('#panel')
  const input = $('#quick-add')
  const preview = $('#preview')
  const statusLine = $('#status')

  let state = { today: '', sections: [], tasks: [], counts: { open: 0, overdue: 0, today: 0 } }
  let view = 'todo'
  let calendarMonth // 'YYYY-MM'
  let selectedDay
  let calendarDays = new Map()
  let editing // task id being edited or planned

  // ---- small helpers ------------------------------------------------------------

  const pad = (n) => String(n).padStart(2, '0')
  const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const localDateTime = (d) => `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  function parseLocal(text) {
    const [d, t = '00:00'] = text.split('T')
    const [y, m, day] = d.split('-').map(Number)
    const [h, min] = t.split(':').map(Number)
    return new Date(y, m - 1, day, h, min)
  }
  function addDays(text, n) {
    const d = parseLocal(text)
    d.setDate(d.getDate() + n)
    return localDate(d)
  }
  const time = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const minutesLabel = (m) => (m % 60 === 0 ? `${m / 60}h` : m > 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`)

  function dayLabel(day) {
    const today = state.today
    if (day === today) return 'Today'
    if (day === addDays(today, 1)) return 'Tomorrow'
    if (day === addDays(today, -1)) return 'Yesterday'
    const d = parseLocal(day)
    if (day > today && day <= addDays(today, 6)) return d.toLocaleDateString([], { weekday: 'short' })
    const sameYear = day.slice(0, 4) === today.slice(0, 4)
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
  }

  function dueLabel(due) {
    const label = dayLabel(due.slice(0, 10))
    return due.length > 10 ? `${label} ${time(parseLocal(due))}` : label
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue
      if (key === 'class') node.className = value
      else if (key === 'text') node.textContent = value
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
      else if (key === 'dataset') Object.assign(node.dataset, value)
      else node.setAttribute(key, value === true ? '' : value)
    }
    for (const child of children.flat()) if (child != null && child !== false) node.append(child)
    return node
  }

  let statusTimer
  function showStatus(text, isError = false) {
    statusLine.textContent = text
    statusLine.classList.toggle('error', isError)
    statusLine.hidden = false
    clearTimeout(statusTimer)
    statusTimer = setTimeout(() => { statusLine.hidden = true }, STATUS_MS)
  }

  async function attempt(fn) {
    try {
      return await fn()
    } catch (error) {
      showStatus(String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true)
      return undefined
    }
  }

  // ---- geometry & gestures (from dsh-orb-cordis) ----------------------------------

  let expanded = false
  let pinned = false
  let dragging = false
  let skipClick = false
  let skipDockCommit = false
  let suppressExpand = false
  let docked
  let dockHoverArmed = true
  let dockPointerInside = false
  let dockHoverTimer
  let collapseTimer
  let collapseFrame
  let pointerHeld = false
  let pointerId
  let pressAt = { x: 0, y: 0 }

  function applyDirection(s) {
    document.body.classList.toggle('expand-left', s.horizontal === 'left')
    document.body.classList.toggle('expand-right', s.horizontal === 'right')
    document.body.classList.toggle('expand-up', s.vertical === 'up')
    document.body.classList.toggle('expand-down', s.vertical === 'down')
  }

  function applyDocked(side) {
    const next = side === 'left' || side === 'right' ? side : undefined
    const becameDocked = docked === undefined && next !== undefined
    docked = next
    document.body.classList.toggle('docked', next !== undefined)
    document.body.classList.toggle('docked-left', next === 'left')
    document.body.classList.toggle('docked-right', next === 'right')
    clearTimeout(dockHoverTimer)
    dockHoverTimer = undefined
    if (next === undefined) {
      dockTab.hidden = true
      dockHoverArmed = true
      return
    }
    if (becameDocked) {
      // Right after docking the pointer is still on the edge; wait before hover can undock.
      dockHoverArmed = false
      dockHoverTimer = setTimeout(() => {
        dockHoverTimer = undefined
        dockHoverArmed = true
        if (dockPointerInside) void unsnapDocked()
      }, DOCK_HOVER_DELAY_MS)
    }
    dockTab.hidden = false
  }

  function applyDockedFrom(result) {
    if (result == null) return
    if (result.expanded === true) applyDirection(result)
    applyDocked(result.docked)
  }

  function beginPointer(element, event) {
    pressAt = { x: event.clientX, y: event.clientY }
    pointerId = event.pointerId
    pointerHeld = true
    element.setPointerCapture(event.pointerId)
  }

  function ownsPointer(event) {
    if (pointerId === undefined) return false
    return event.pointerId === undefined || event.pointerId === pointerId
  }

  window.addEventListener('blur', () => {
    if (pointerHeld) void finishGesture()
  })

  async function finishGesture() {
    const moved = dragging
    pointerHeld = false
    pointerId = undefined
    dragging = false
    if (!moved) return false
    skipClick = true
    const skipDock = skipDockCommit
    skipDockCommit = false
    if (!skipDock) applyDockedFrom(await api.dragEnd(true))
    return true
  }

  function startBallDrag() {
    dragging = true
    setPinned(false)
    void setExpanded(false, true)
    api.dragBegin()
  }

  function syncExpand() {
    if (pointerHeld || dragging) return
    if (docked !== undefined) {
      if (dockHoverArmed) void unsnapDocked()
      return
    }
    if (suppressExpand) return
    void setExpanded(true)
  }

  async function unsnapDocked() {
    if (docked === undefined) return
    suppressExpand = true
    if (dragging) skipDockCommit = true
    applyDocked(undefined)
    applyDockedFrom(await api.unsnap())
  }

  async function setExpanded(next, force = false) {
    if (WIDGET) return
    clearTimeout(collapseTimer)
    collapseTimer = undefined
    clearTimeout(collapseFrame)
    collapseFrame = undefined
    if (next) {
      if (expanded) return
      const s = await api.setExpanded(true)
      applyDocked(undefined)
      applyDirection(s)
      panel.hidden = false
      expanded = true
      ball.setAttribute('aria-expanded', 'true')
      // Let the browser lay out the unhidden panel before the transition starts.
      requestAnimationFrame(() => document.body.classList.add('expanded'))
      if (view === 'calendar') void loadCalendar()
      return
    }
    if (!force && pinned) return
    expanded = false
    ball.setAttribute('aria-expanded', 'false')
    document.body.classList.remove('expanded', 'away')
    void api.clickThrough(false)
    if (docked !== undefined) dockTab.hidden = false
    if (force) {
      panel.hidden = true
      await api.setExpanded(false)
      return
    }
    collapseFrame = setTimeout(() => {
      collapseFrame = undefined
      if (expanded) return
      panel.hidden = true
      void api.setExpanded(false)
    }, ANIMATION_MS)
  }

  function scheduleCollapse() {
    if (pinned || dragging) return
    clearTimeout(collapseTimer)
    collapseTimer = setTimeout(() => {
      collapseTimer = undefined
      void setExpanded(false)
    }, COLLAPSE_MS)
  }

  function setPinned(next) {
    pinned = next
    document.body.classList.toggle('pinned', pinned)
    ball.setAttribute('aria-pressed', String(pinned))
    if (!pinned) {
      document.body.classList.remove('away')
      void api.clickThrough(false)
    }
  }

  document.body.addEventListener('pointerenter', (event) => {
    if (WIDGET) return
    dockPointerInside = true
    if (pointerHeld && typeof event.buttons === 'number' && event.buttons === 0) void finishGesture()
    if (document.body.classList.contains('away')) {
      document.body.classList.remove('away')
      void api.clickThrough(false)
    }
    syncExpand()
  })
  document.body.addEventListener('pointerleave', () => {
    if (WIDGET) return
    dockPointerInside = false
    suppressExpand = false
    if (pointerHeld || dragging) return
    if (pinned && expanded) {
      // Dim, and let clicks fall through to the app underneath until the pointer returns.
      document.body.classList.add('away')
      void api.clickThrough(true)
      return
    }
    scheduleCollapse()
  })

  const isPrimary = (event) => event.button === 0
  const primaryHeld = (event) => (event.buttons & 1) === 1

  ball.addEventListener('pointerdown', (event) => {
    if (!isPrimary(event)) return
    dragging = false
    skipClick = false
    beginPointer(ball, event)
    api.dragPress()
  })
  ball.addEventListener('pointermove', (event) => {
    if (!ownsPointer(event)) return
    if (!primaryHeld(event)) {
      void finishGesture()
      return
    }
    if (!dragging) {
      if (Math.hypot(event.clientX - pressAt.x, event.clientY - pressAt.y) <= 4) return
      startBallDrag()
    }
    api.dragMove(true)
  })
  ball.addEventListener('pointerup', async (event) => {
    if (!isPrimary(event)) {
      void finishGesture()
      return
    }
    const dragged = await finishGesture()
    if (dragged || skipClick) {
      skipClick = false
      return
    }
    setPinned(!pinned)
    if (pinned) await setExpanded(true)
  })
  ball.addEventListener('pointercancel', () => { void finishGesture() })
  ball.addEventListener('lostpointercapture', () => { void finishGesture() })
  ball.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    void api.menu()
  })

  dockTab.addEventListener('pointerdown', (event) => {
    if (!isPrimary(event)) return
    dragging = false
    skipClick = true
    beginPointer(dockTab, event)
  })
  dockTab.addEventListener('pointermove', (event) => {
    if (!ownsPointer(event) || docked === undefined) return
    if (!primaryHeld(event)) {
      void finishGesture()
      return
    }
    const pulled = docked === 'right' ? pressAt.x - event.clientX : event.clientX - pressAt.x
    if (pulled <= DOCK_DRAG_OFF_PX) return
    dragging = true
    void unsnapDocked()
  })
  dockTab.addEventListener('pointerup', () => { void finishGesture() })
  dockTab.addEventListener('click', () => { void unsnapDocked() })

  // Typing anywhere in the panel pins it, so it can't collapse under your cursor mid-sentence.
  panel.addEventListener('focusin', (event) => {
    if (WIDGET) return
    if (event.target.matches('input[type="text"], input[type="url"], input[type="datetime-local"], select, .edit')) setPinned(true)
  })

  // WCAG 1.4.13: content shown on hover can be dismissed without moving the pointer.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (editing) {
      editing = undefined
      renderTodo()
      return
    }
    if (view === 'settings') {
      showView('todo')
      return
    }
    input.blur()
    if (WIDGET) return
    setPinned(false)
    void setExpanded(false, true)
  })

  api.onSummon(async () => {
    if (docked !== undefined) await unsnapDocked()
    if (!WIDGET) setPinned(true)
    await setExpanded(true)
    await api.focus()
    if (view === 'settings') showView('todo')
    input.focus()
  })

  // ---- ball -----------------------------------------------------------------------

  function renderBall() {
    const { open, overdue, today } = state.counts
    // "The number tells you what's left." Colour says how urgent: red overdue, amber due today.
    ballCount.textContent = open > 99 ? '99+' : String(open)
    ballCount.classList.toggle('quiet', open === 0)
    if (open === 0) ballCount.textContent = '✓'
    ball.classList.toggle('overdue', overdue > 0)
    ball.classList.toggle('today', overdue === 0 && today > 0)
    dockTab.classList.toggle('alert', overdue > 0)
    const parts = [`${open} to do`]
    if (overdue) parts.push(`${overdue} overdue`)
    if (today) parts.push(`${today} due today`)
    ball.setAttribute('aria-label', `Orb: ${parts.join(', ')}. Click to pin open.`)
    ball.title = parts.join(' · ')
  }

  function renderHeader() {
    if (!state.today) return
    const d = parseLocal(state.today)
    $('#date-weekday').textContent = d.toLocaleDateString([], { weekday: 'long' })
    $('#date-day').textContent = d.toLocaleDateString([], { month: 'long', day: 'numeric' })
  }

  // ---- views ----------------------------------------------------------------------

  const tabs = [...document.querySelectorAll('[role="tab"]')]

  function showView(name) {
    view = name
    for (const tab of tabs) {
      const selected = tab.dataset.view === name
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
    }
    for (const v of ['todo', 'calendar', 'done', 'settings']) $(`#view-${v}`).hidden = v !== name
    document.body.classList.toggle('settings', name === 'settings')
    $('#settings-button').setAttribute('aria-pressed', String(name === 'settings'))
    if (name === 'calendar') void loadCalendar()
    if (name === 'settings') void loadSettings()
    if (name === 'done') renderDone()
    if (name === 'todo') renderTodo()
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => showView(tab.dataset.view))
    tab.addEventListener('keydown', (event) => {
      const i = tabs.indexOf(tab)
      const next = event.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(i + tabs.length - 1) % tabs.length] : undefined
      if (!next) return
      event.preventDefault()
      next.focus()
      showView(next.dataset.view)
    })
  }
  $('#settings-button').addEventListener('click', () => showView(view === 'settings' ? 'todo' : 'settings'))
  $('#settings-back').addEventListener('click', () => showView('todo'))
  api.onShow(async (name) => {
    await setExpanded(true)
    if (!WIDGET) setPinned(true)
    showView(name)
  })

  // ---- to-do ----------------------------------------------------------------------

  function taskMeta(task) {
    const chips = []
    if (task.due) chips.push(el('span', { class: `chip due ${task.dueStatus ?? ''}`, text: task.dueStatus === 'overdue' ? `overdue · ${dueLabel(task.due)}` : dueLabel(task.due) }))
    if (task.plan) {
      const start = parseLocal(task.plan.start)
      chips.push(el('span', { class: 'chip plan', text: `◷ ${dayLabel(task.plan.start.slice(0, 10))} ${time(start)} · ${minutesLabel(task.plan.minutes)}` }))
    }
    return chips
  }

  function taskRow(task) {
    const row = el('li', { class: `task${task.done ? ' done' : ''}`, dataset: { id: task.id } })
    const box = el('input', {
      type: 'checkbox',
      'aria-label': `${task.done ? 'Reopen' : 'Complete'}: ${task.title}`,
      onchange: () => attempt(() => api.toggle(task.id, box.checked)),
    })
    box.checked = task.done
    row.append(box)

    if (editing === `edit:${task.id}`) {
      const field = el('input', { class: 'edit', type: 'text', value: [task.title, task.due ? `due:${task.due}` : ''].filter(Boolean).join(' '), 'aria-label': 'Edit task' })
      field.addEventListener('keydown', async (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          const parsed = await attempt(() => api.preview(field.value))
          if (!parsed?.title) return
          const patch = { title: parsed.title, due: parsed.due ?? null }
          if (parsed.section) patch.section = parsed.section
          editing = undefined
          await attempt(() => api.update(task.id, patch))
          renderTodo()
        }
      })
      field.addEventListener('blur', () => {
        if (editing === `edit:${task.id}`) {
          editing = undefined
          renderTodo()
        }
      })
      row.append(field)
      queueMicrotask(() => {
        field.focus()
        field.setSelectionRange(task.title.length, task.title.length)
      })
      return row
    }

    const title = el('span', { class: 'title', tabindex: '0', text: task.title, title: 'Double-click or press Enter to edit' })
    const startEdit = () => {
      editing = `edit:${task.id}`
      renderTodo()
    }
    title.addEventListener('dblclick', startEdit)
    title.addEventListener('keydown', (event) => { if (event.key === 'Enter') startEdit() })
    row.append(title)

    row.append(el('span', { class: 'actions' },
      task.done ? null : el('button', { class: 'icon', type: 'button', 'aria-label': `Plan time for: ${task.title}`, title: 'Block time for this', text: '◷', onclick: () => openPlan(task) }),
      el('button', { class: 'icon', type: 'button', 'aria-label': `Delete: ${task.title}`, title: 'Delete', text: '✕', onclick: () => attempt(() => api.remove(task.id)) }),
    ))
    row.append(el('div', { class: 'meta' }, taskMeta(task)))
    if (editing === `plan:${task.id}`) row.append(planForm(task))
    return row
  }

  let planDefault
  async function openPlan(task) {
    editing = `plan:${task.id}`
    planDefault = task.plan?.start
    if (!planDefault) {
      // Suggest the first free half hour today (or tomorrow if today is full).
      const today = await attempt(() => api.freeTime(state.today, 30))
      const tomorrow = today?.length ? today : await attempt(() => api.freeTime(addDays(state.today, 1), 30))
      const slot = tomorrow?.[0]
      planDefault = slot ? localDateTime(new Date(slot.start)) : `${addDays(state.today, 1)}T16:00`
    }
    renderTodo()
  }

  function planForm(task) {
    const start = el('input', { type: 'datetime-local', step: '900', value: planDefault, 'aria-label': 'Start' })
    const length = el('select', { 'aria-label': 'Length' },
      [15, 30, 45, 60, 90, 120, 180].map((m) => el('option', { value: String(m), text: minutesLabel(m), selected: m === (task.plan?.minutes ?? 30) })))
    const close = () => {
      editing = undefined
      renderTodo()
    }
    return el('form', {
      class: 'plan-form',
      onsubmit: async (event) => {
        event.preventDefault()
        if (!start.value) return
        await attempt(() => api.plan(task.id, start.value.slice(0, 16), Number(length.value)))
        close()
      },
    },
    start, length,
    el('button', { type: 'submit', class: 'primary', text: 'Plan' }),
    task.plan ? el('button', { type: 'button', text: 'Remove', onclick: async () => { await attempt(() => api.plan(task.id, null, 0)); close() } }) : null,
    el('button', { type: 'button', text: 'Cancel', onclick: close }))
  }

  function renderTodo() {
    const root = $('#view-todo')
    const open = state.tasks.filter((t) => !t.done && !t.cancelled)
    const names = [...state.sections]
    if (open.some((t) => !t.section)) names.unshift('')
    const blocks = names.map((name) => {
      const tasks = open.filter((t) => t.section === name)
      return el('section', { class: 'section', 'aria-label': name || 'Inbox' },
        el('h2', { text: name || 'inbox' }),
        el('ul', { class: 'tasks' }, tasks.map(taskRow)))
    })
    const scroll = root.scrollTop
    root.replaceChildren(...blocks)
    if (open.length === 0) {
      root.append(el('p', { class: 'empty' }, 'Nothing left. Add something below, or ask Claude: ', el('b', { text: '"add that to my to-do"' })))
    }
    root.scrollTop = scroll
  }

  function renderDone() {
    const root = $('#view-done')
    const done = state.tasks.filter((t) => t.done).sort((a, b) => (b.doneDate ?? '').localeCompare(a.doneDate ?? ''))
    const weekAgo = addDays(state.today, -6)
    const thisWeek = done.filter((t) => (t.doneDate ?? '') >= weekAgo).length
    const groups = new Map()
    for (const t of done) {
      const d = t.doneDate
      const key = !d ? 'Earlier' : d === state.today ? 'Today' : d === addDays(state.today, -1) ? 'Yesterday' : d >= weekAgo ? 'This week' : 'Earlier'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(t)
    }
    root.replaceChildren(
      el('p', { class: 'done-summary', text: done.length ? `${thisWeek} done in the last 7 days.` : 'Finished tasks show up here.' }),
      ...[...groups].map(([name, tasks]) => el('section', { class: 'section' }, el('h2', { text: name }), el('ul', { class: 'tasks' }, tasks.map(taskRow)))),
    )
  }

  // ---- quick add ------------------------------------------------------------------

  let previewSeq = 0
  input.addEventListener('input', async () => {
    const seq = ++previewSeq
    const text = input.value.trim()
    if (!text) {
      preview.replaceChildren()
      return
    }
    const parsed = await api.preview(text).catch(() => undefined)
    if (seq !== previewSeq || !parsed) return
    const bits = []
    const section = parsed.section ?? state.sections[0]
    if (section) bits.push(el('span', {}, '→ ', el('b', { text: section }), parsed.newSection ? ' (new section)' : ''))
    if (parsed.due) bits.push(el('span', {}, ' · due ', el('b', { text: dueLabel(parsed.due) })))
    if (parsed.plan) bits.push(el('span', {}, ' · planned ', el('b', { text: `${dueLabel(parsed.plan.start)} ${minutesLabel(parsed.plan.minutes)}` })))
    preview.replaceChildren(...bits)
  })

  $('#composer').addEventListener('submit', async (event) => {
    event.preventDefault()
    const text = input.value.trim()
    if (!text) return
    const done = await attempt(async () => {
      await api.add(text)
      return true
    })
    if (done) {
      input.value = ''
      preview.replaceChildren()
      if (view !== 'todo') showView('todo')
    }
  })

  // ---- calendar -------------------------------------------------------------------

  function monthRange(month) {
    const first = parseLocal(`${month}-01`)
    const start = new Date(first)
    start.setDate(1 - first.getDay())
    const end = new Date(start)
    end.setDate(start.getDate() + 41)
    return { first, start: localDate(start), end: localDate(end) }
  }

  let calendarSeq = 0
  async function loadCalendar() {
    if (!state.today) return
    calendarMonth ??= state.today.slice(0, 7)
    selectedDay ??= state.today
    const seq = ++calendarSeq
    const { start, end } = monthRange(calendarMonth)
    const result = await attempt(() => api.calendar(start, end))
    if (!result || seq !== calendarSeq) return
    calendarDays = new Map(result.days.map((d) => [d.day, d.items.map((item) => ({
      ...item,
      start: new Date(item.start),
      end: item.end ? new Date(item.end) : undefined,
    }))]))
    if (result.problems?.length) showStatus(result.problems[0].error, true)
    renderCalendar()
  }

  function renderCalendar() {
    const { first, start } = monthRange(calendarMonth)
    $('#month-label').textContent = first.toLocaleDateString([], { month: 'long', year: 'numeric' })
    const grid = $('#month-grid')
    const dows = []
    for (let i = 0; i < 7; i++) {
      const d = parseLocal(addDays(start, i))
      dows.push(el('div', { class: 'dow', role: 'columnheader', 'aria-label': d.toLocaleDateString([], { weekday: 'long' }), text: d.toLocaleDateString([], { weekday: 'narrow' }) }))
    }
    const cells = []
    for (let i = 0; i < 42; i++) {
      const day = addDays(start, i)
      const items = calendarDays.get(day) ?? []
      const dues = items.filter((x) => x.kind === 'due' && !x.task?.done)
      const events = items.filter((x) => x.kind === 'event')
      const plans = items.filter((x) => x.kind === 'plan')
      const dots = [
        ...dues.slice(0, 1).map(() => el('i', { class: dues.some((x) => x.task?.dueStatus === 'overdue') ? 'overdue' : 'task' })),
        ...plans.slice(0, 1).map(() => el('i', { class: 'task' })),
        ...events.slice(0, 2).map((e) => { const dot = el('i'); if (e.color) dot.style.background = e.color; return dot }),
      ].slice(0, 3)
      const summary = [events.length && `${events.length} event${events.length > 1 ? 's' : ''}`, dues.length && `${dues.length} due`, plans.length && `${plans.length} planned`].filter(Boolean).join(', ')
      const cell = el('button', {
        type: 'button',
        role: 'gridcell',
        class: `day${day.slice(0, 7) !== calendarMonth ? ' other' : ''}${day === state.today ? ' today' : ''}`,
        'aria-selected': String(day === selectedDay),
        'aria-label': `${parseLocal(day).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}${summary ? `: ${summary}` : ''}`,
        tabindex: day === selectedDay ? '0' : '-1',
        dataset: { day },
        onclick: () => selectDay(day),
      }, el('span', { class: 'n', text: String(Number(day.slice(8))) }), el('span', { class: 'dots' }, dots))
      cells.push(cell)
    }
    grid.replaceChildren(...dows, ...cells)
    renderAgenda()
  }

  function selectDay(day, focus = false) {
    selectedDay = day
    if (day.slice(0, 7) !== calendarMonth) {
      calendarMonth = day.slice(0, 7)
      void loadCalendar().then(() => focus && $(`#month-grid [data-day="${day}"]`)?.focus())
      return
    }
    renderCalendar()
    if (focus) $(`#month-grid [data-day="${day}"]`)?.focus()
  }

  $('#month-grid').addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key]
    if (!step || !selectedDay) return
    event.preventDefault()
    selectDay(addDays(selectedDay, step), true)
  })

  function shiftMonth(delta) {
    const d = parseLocal(`${calendarMonth}-01`)
    d.setMonth(d.getMonth() + delta)
    calendarMonth = localDate(d).slice(0, 7)
    selectedDay = `${calendarMonth}-01`
    void loadCalendar()
  }
  $('#prev-month').addEventListener('click', () => shiftMonth(-1))
  $('#next-month').addEventListener('click', () => shiftMonth(1))
  $('#today-button').addEventListener('click', () => {
    calendarMonth = state.today.slice(0, 7)
    selectDay(state.today)
  })

  function renderAgenda() {
    const items = calendarDays.get(selectedDay) ?? []
    $('#agenda-label').textContent = `${dayLabel(selectedDay)} · ${parseLocal(selectedDay).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}`
    const list = $('#agenda')
    if (items.length === 0) {
      list.replaceChildren(el('li', { class: 'empty' }, el('span'), el('span'), el('span', { text: 'Nothing scheduled. Use ◷ on a task to plan time for it.' })))
      return
    }
    list.replaceChildren(...items.map((item) => {
      const when = item.allDay ? (item.kind === 'due' ? 'due' : 'all day') : `${time(item.start)}`
      let what
      if (item.kind === 'due') {
        const box = el('input', { type: 'checkbox', onchange: () => attempt(() => api.toggle(item.task.id, box.checked)) })
        box.checked = item.task.done
        what = el('div', { class: `what${item.task.done ? ' done' : ''}` }, el('label', {}, box, el('span', { text: item.title })), el('small', { text: `due${item.task.section ? ` · ${item.task.section}` : ''}` }))
      } else if (item.kind === 'plan') {
        what = el('div', { class: 'what' }, el('span', { text: item.title }), el('small', { text: `planned · ${minutesLabel(Math.round((item.end - item.start) / 60000))}` }))
      } else {
        const end = item.allDay || !item.end ? '' : `until ${time(item.end)}`
        what = el('div', { class: 'what' }, el('span', { text: item.title }), el('small', { text: [item.calendar, end, item.location].filter(Boolean).join(' · ') }))
      }
      const bar = el('span', { class: `bar ${item.kind}` })
      if (item.kind === 'event' && item.color) bar.style.background = item.color
      return el('li', {}, el('span', { class: 'time', text: when }), bar, what)
    }))
  }

  // ---- settings -------------------------------------------------------------------

  async function loadSettings() {
    const s = await attempt(() => api.settings())
    if (!s) return
    const claudeText = {
      connected: 'Connected. In Claude Desktop, try: "add book friday dinner to my to-do". (Restart Claude Desktop once after connecting.)',
      outdated: 'Connected to an older copy of Orb. Click to update.',
      'not-connected': 'Not connected yet.',
      unreadable: 'Claude Desktop\'s settings file couldn\'t be read.',
    }[s.claude]
    $('#claude-status').textContent = claudeText
    $('#connect-claude').textContent = s.claude === 'connected' ? 'Reconnect' : 'Connect to Claude Desktop'
    $('#claude-code-command').textContent = s.claudeCode
    $('#claude-code-command').title = s.claudeCode
    $('#ics-url').textContent = s.icsUrl
    $('#data-dir').textContent = s.dataDir
    $('#hotkey').textContent = s.hotkey.replace('CommandOrControl', s.platform === 'darwin' ? '⌘' : 'Ctrl').replace(/\+/g, ' + ')
    $('#open-at-login').checked = s.openAtLogin
    $('#feed-list').replaceChildren(...s.feeds.map((feed, i) => {
      const status = feed.status
      const note = !status ? 'Loading…' : status.ok ? 'Up to date' : status.error
      const swatch = el('span', { class: 'swatch' })
      // CSSOM, not a style="" attribute: the page's CSP blocks inline style attributes.
      swatch.style.background = feed.color || ['#3573d0', '#0f9b8e', '#d9730d', '#7a5af5', '#c2417a', '#5b8a1e'][i % 6]
      return el('li', {},
        swatch,
        el('span', { class: 'name' }, feed.name, el('small', { class: status && !status.ok ? 'error' : '', text: note })),
        el('button', { type: 'button', class: 'link', text: 'Remove', 'aria-label': `Remove ${feed.name}`, onclick: async () => { await attempt(() => api.removeFeed(feed.url)); void loadSettings() } }))
    }))
  }

  $('#connect-claude').addEventListener('click', async () => {
    const result = await attempt(() => api.connectClaude())
    if (result) showStatus('Done. Quit and reopen Claude Desktop, then ask it to add something to your to-do.')
    void loadSettings()
  })
  $('#feed-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const name = $('#feed-name').value
    const url = $('#feed-url').value
    const button = event.submitter
    if (button) button.disabled = true
    const ok = await attempt(async () => {
      await api.addFeed(name, url)
      return true
    })
    if (button) button.disabled = false
    if (ok) {
      $('#feed-name').value = ''
      $('#feed-url').value = ''
      showStatus('Calendar added.')
    }
    void loadSettings()
  })
  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', async () => {
      await attempt(() => api.copy($(`#${button.dataset.copy}`).textContent))
      showStatus('Copied.')
    })
  }
  $('#open-file').addEventListener('click', () => attempt(() => api.openFile()))
  $('#open-folder').addEventListener('click', () => attempt(() => api.openFolder()))
  $('#open-at-login').addEventListener('change', (event) => attempt(() => api.setLogin(event.target.checked)))

  if (WIDGET) {
    // A widget is the panel itself: always open, no ball, moved by dragging its header.
    document.body.classList.remove('expand-left', 'expand-up')
    document.body.classList.add('widget')
    panel.hidden = false
    expanded = true
    requestAnimationFrame(() => document.body.classList.add('expanded'))
    $('#head').title = 'Drag here to move'
  }

  // ---- data -----------------------------------------------------------------------

  function applyState(next) {
    state = next
    renderBall()
    renderHeader()
    if (editing && !state.tasks.some((t) => editing.endsWith(`:${t.id}`))) editing = undefined
    if (view === 'todo') renderTodo()
    if (view === 'done') renderDone()
    if (view === 'calendar' && expanded) void loadCalendar()
  }

  api.onState(applyState)
  api.onCalendarChanged(() => { if (view === 'calendar' && expanded) void loadCalendar() })
  api.onError((message) => showStatus(message, true))
  void api.snapshot().then(applyState, (error) => showStatus(error.message, true))
})()
