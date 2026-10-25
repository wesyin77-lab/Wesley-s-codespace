// The only bridge between the page and the main process. The page never gets
// Node or Electron objects, just these calls.
const { contextBridge, ipcRenderer } = require('electron')

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args)
const listen = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('orb', {
  snapshot: invoke('orb:snapshot'),
  preview: invoke('orb:preview'),
  add: invoke('orb:add'),
  toggle: invoke('orb:toggle'),
  update: invoke('orb:update'),
  remove: invoke('orb:remove'),
  plan: invoke('orb:plan'),
  removeSection: invoke('orb:remove-section'),
  calendar: invoke('orb:calendar'),
  freeTime: invoke('orb:free-time'),
  settings: invoke('orb:settings'),
  addFeed: invoke('orb:add-feed'),
  removeFeed: invoke('orb:remove-feed'),
  refreshFeeds: invoke('orb:refresh-feeds'),
  connectClaude: invoke('orb:connect-claude'),
  setLogin: invoke('orb:login'),
  openFile: invoke('orb:open-file'),
  openFolder: invoke('orb:open-folder'),
  copy: invoke('orb:copy'),
  menu: invoke('orb:menu'),
  clickThrough: invoke('orb:click-through'),

  setExpanded: invoke('orb:expand'),
  focus: invoke('orb:focus'),
  dragPress: () => ipcRenderer.send('orb:drag-press'),
  dragBegin: () => ipcRenderer.send('orb:drag-begin'),
  dragMove: (canDock) => ipcRenderer.send('orb:drag-move', canDock !== false),
  dragEnd: invoke('orb:drag-end'),
  unsnap: invoke('orb:unsnap'),
  resizeBegin: (direction) => ipcRenderer.send('orb:resize-begin', direction),
  resizeMove: () => ipcRenderer.send('orb:resize-move'),
  resizeEnd: () => ipcRenderer.send('orb:resize-end'),

  onState: listen('orb:state'),
  onCalendarChanged: listen('orb:calendar-changed'),
  onSummon: listen('orb:summon'),
  onShow: listen('orb:show'),
  onError: listen('orb:error'),
})
