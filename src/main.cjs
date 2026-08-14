'use strict'

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, shell } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { endpoint, normalizeDshUrl, validateSnapshot } = require('./shared.cjs')

const WINDOW_WIDTH = 280
const WINDOW_HEIGHT = 250
const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 15000
// 桌面伴侣在场心跳（与 whale-girl src/presence.mjs 的 TTL/间隔契约一致）：
// 在线期间 whale-girl 隐藏网页端宠物（避免双大肥鱼），退出/崩溃后心跳过期自动恢复。
const PRESENCE_TTL_MS = 45000
const PRESENCE_INTERVAL_MS = 15000

function cliValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

let dshUrl
try {
  dshUrl = normalizeDshUrl(cliValue('--dsh-url') ?? process.env.DSH_URL)
} catch (error) {
  console.error(error.message)
  process.exit(2)
}

let mainWindow = null
let tray = null
let stopped = false
let retryMs = RETRY_MIN_MS
let streamAbort = null
let dragOrigin = null
let stateSaveTimer = null
let presenceTimer = null

function stateFile() {
  return join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState() {
  try {
    const value = JSON.parse(readFileSync(stateFile(), 'utf8'))
    if (Number.isFinite(value.x) && Number.isFinite(value.y)) return { x: value.x, y: value.y }
  } catch {}
  return {}
}

function saveWindowState() {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  const [x, y] = mainWindow.getPosition()
  try { writeFileSync(stateFile(), JSON.stringify({ x, y })) } catch {}
}

function createWindow() {
  const capturePath = cliValue('--capture')
  const savedPosition = loadWindowState()
  const workArea = screen.getPrimaryDisplay().workArea
  const position = Number.isFinite(savedPosition.x) && Number.isFinite(savedPosition.y)
    ? savedPosition
    : {
        x: workArea.x + workArea.width - WINDOW_WIDTH - 24,
        y: workArea.y + workArea.height - WINDOW_HEIGHT - 24,
      }
  mainWindow = new BrowserWindow({
    ...position,
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  mainWindow.setAlwaysOnTop(true, 'floating')
  mainWindow.setVisibleOnAllWorkspaces(true)
  mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.showInactive())
  if (capturePath !== undefined) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const image = await mainWindow.webContents.capturePage()
        writeFileSync(capturePath, image.toPNG())
        app.quit()
      }, 2000)
    })
  }
  mainWindow.on('moved', () => {
    // 防抖：游走/拖拽会高频触发 moved，同步落盘太频繁（游走时 ~20 次/秒）。
    clearTimeout(stateSaveTimer)
    stateSaveTimer = setTimeout(saveWindowState, 500)
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

function send(channel, payload) {
  if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

async function readJson(path) {
  const response = await fetch(endpoint(dshUrl, path), { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function refresh() {
  const snapshot = validateSnapshot(await readJson('/whale-girl/state'))
  if (snapshot === null) throw new Error('鲸鱼娘状态数据版本不受支持')
  send('pet:snapshot', snapshot)
  send('pet:connection', { connected: true, dshUrl })
  return snapshot
}

async function followEvents() {
  streamAbort?.abort()
  streamAbort = new AbortController()
  const response = await fetch(endpoint(dshUrl, '/whale-girl/events'), { signal: streamAbort.signal })
  if (!response.ok || response.body === null) throw new Error(`SSE HTTP ${response.status}`)
  retryMs = RETRY_MIN_MS
  await refresh()
  const decoder = new TextDecoder()
  let buffered = ''
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, { stream: true })
    let boundary
    while ((boundary = buffered.indexOf('\n\n')) !== -1) {
      const event = buffered.slice(0, boundary)
      buffered = buffered.slice(boundary + 2)
      if (event.split('\n').some(line => line.startsWith('data:'))) await refresh()
    }
  }
  throw new Error('SSE connection closed')
}

async function connectionLoop() {
  while (!stopped) {
    try {
      await followEvents()
    } catch (error) {
      if (stopped) return
      send('pet:connection', { connected: false, dshUrl, message: error.message })
      await new Promise(resolve => setTimeout(resolve, retryMs))
      retryMs = Math.min(RETRY_MAX_MS, retryMs * 2)
    }
  }
}

async function createTray() {
  const response = await fetch(endpoint(dshUrl, '/whale-girl/assets/characters/whale-girl/idle.png'), {
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) return
  const sheet = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()))
  const icon = sheet.crop({ x: 0, y: 0, width: 256, height: 256 }).resize({ width: 16, height: 16 })
  if (icon.isEmpty()) return
  tray = new Tray(icon)
  tray.setToolTip('大肥鱼.exe')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示', click: () => mainWindow?.showInactive() },
    { label: '隐藏', click: () => mainWindow?.hide() },
    { label: '打开网页端', click: () => shell.openExternal(dshUrl) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]))
}

ipcMain.handle('pet:get-bootstrap', async () => ({
  dshUrl,
  assetsUrl: endpoint(dshUrl, '/whale-girl/assets/characters/whale-girl'),
}))
ipcMain.handle('pet:get-manifest', () => readJson('/whale-girl/assets/manifest.json'))
ipcMain.handle('pet:get-config', () => readJson('/whale-girl/config'))
ipcMain.handle('pet:refresh', refresh)
ipcMain.handle('pet:interact', async (_event, action) => {
  if (!['feed', 'play'].includes(action)) throw new Error('不支持的互动方式')
  const response = await fetch(endpoint(dshUrl, '/whale-girl/interact'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
})
ipcMain.on('pet:set-click-through', (_event, ignored) => {
  mainWindow?.setIgnoreMouseEvents(Boolean(ignored), { forward: true })
})
ipcMain.on('pet:drag-start', (_event, point) => {
  if (mainWindow === null || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return
  const [windowX, windowY] = mainWindow.getPosition()
  dragOrigin = { pointerX: point.x, pointerY: point.y, windowX, windowY }
})
ipcMain.on('pet:drag-move', (_event, point) => {
  if (mainWindow === null || dragOrigin === null || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return
  const targetX = Math.round(dragOrigin.windowX + point.x - dragOrigin.pointerX)
  const targetY = Math.round(dragOrigin.windowY + point.y - dragOrigin.pointerY)
  const display = screen.getDisplayNearestPoint({ x: targetX, y: targetY })
  const area = display.workArea
  const x = Math.min(area.x + area.width - WINDOW_WIDTH, Math.max(area.x, targetX))
  const y = Math.min(area.y + area.height - WINDOW_HEIGHT, Math.max(area.y, targetY))
  mainWindow.setPosition(x, y)
})
ipcMain.on('pet:drag-end', () => {
  dragOrigin = null
  saveWindowState()
})
// 游走：沿屏幕水平移动窗口（宠物在窗口内视觉随窗口移动）。dx 为本次位移（px）；
// 返回 { moved: false } 表示已顶到工作区边缘（渲染端据此翻转方向）。
ipcMain.handle('pet:walk-move', (_event, dx) => {
  if (mainWindow === null || !Number.isFinite(dx) || dx === 0) return { moved: false }
  const [x, y] = mainWindow.getPosition()
  const targetX = Math.round(x + dx)
  const display = screen.getDisplayNearestPoint({ x: targetX, y })
  const area = display.workArea
  const clamped = Math.min(area.x + area.width - WINDOW_WIDTH, Math.max(area.x, targetX))
  mainWindow.setPosition(clamped, y)
  return { moved: clamped !== x }
})
ipcMain.on('pet:quit', () => app.quit())

// 在场心跳：在线期间 whale-girl 隐藏网页端宠物；退出/崩溃后 TTL 过期自动恢复。
// DSH 未启动/断线时静默失败，下一轮重试（不阻塞主流程）。
function pokePresence(online) {
  fetch(endpoint(dshUrl, '/whale-girl/presence'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ online }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {})
}

app.whenReady().then(() => {
  createWindow()
  createTray().catch(() => {})
  connectionLoop()
  pokePresence(true)
  presenceTimer = setInterval(() => pokePresence(true), PRESENCE_INTERVAL_MS)
})

app.on('before-quit', () => {
  stopped = true
  streamAbort?.abort()
  clearInterval(presenceTimer)
  // 干净退出即时恢复网页端宠物（best-effort；进程被杀时由 TTL 兜底恢复）。
  pokePresence(false)
  saveWindowState()
})
app.on('window-all-closed', event => event.preventDefault())
