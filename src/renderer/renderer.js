'use strict'

const pet = document.querySelector('#pet')
const sprite = document.querySelector('#sprite')
const status = document.querySelector('#status')
const detail = document.querySelector('#detail')
const note = document.querySelector('#note')
const connection = document.querySelector('#connection')
const bubble = document.querySelector('#bubble')
const actions = document.querySelector('#actions')

const STATE_LABELS = {
  idle: '准备好了', working: '正在使用工具', celebrate: '任务完成', error: '请求失败',
  disappointed: '休息一下', think: '正在深入思考', wait: '等待你的批准',
  welcome: '新会话', sleep: '正在等待 DSH', eat: '吃点东西', play: '一起玩吧',
  joy: '开心！', drag: '别拽我～', wake: '刚睡醒', walk: '散步中',
}

const BURST_NAMES = ['welcome', 'celebrate', 'error', 'disappointed']
const TICK_MS = 50
const TRANSIENT_MS = 1500 // eat/play 瞬发时长（与 whale-girl client 一致）
const WAKE_MS = 3000      // wake 过渡时长
const JOY_MS = 1600       // 互动后喜悦时长
const DRAG_RELEASE_MS = 1500 // 拖拽放下缓冲
const LEVEL_UP_CELEBRATE_MS = 4000 // 升级本地庆祝窗口（与回合完成窗口同长）

// 体验层默认值（与 whale-girl /whale-girl/config 的 DEFAULTS 数值一致；size 用
// manifest meta.stageSize 兜底，null 表示未配置）。消费 /config 后整体替换。
const CFG_DEFAULTS = {
  enabled: true, size: null, opacity: 1, bubbleMs: 2500, sleepAfterMs: 60000,
  walk: { enabled: true, minWaitMs: 18000, maxWaitMs: 40000, minMs: 3000, maxMs: 6000, speedPxPerSec: 45 },
}

let manifest = null
let character = null
let assetsUrl = ''
let snapshot = null
let connected = false
let currentState = 'sleep'
let frame = 0
let frameTimer = null
let bubbleTimer = null
let dragging = false
let dragMoved = false
let pointerOrigin = null
let cfg = { ...CFG_DEFAULTS, walk: { ...CFG_DEFAULTS.walk } }
let lastConfigRevision = 0
let stageSize = 150
// 行为运行时（与 shared.cjs 的纯决策 + whale-girl client 语义对齐）
let sleeping = false
let idleSince = 0
let transient = null // 'eat' | 'play' | 'wake' | null
let transientUntil = 0
let joyUntil = 0
let dragReleaseUntil = 0
let levelUpUntil = 0
let walking = false
let walkDir = 1
let walkAt = 0
let walkUntil = 0 // performance.now() 时钟（rAF 帧时刻）
let walkRaf = null
let lastWalkFrame = 0
let tickTimer = null

function randomBetween(min, max) {
  return min + Math.random() * Math.max(0, max - min)
}

// 行为优先级表：与 shared.cjs pickDisplayState 镜像（renderer 无法 import CommonJS，
// 同一张表两份，shared 版由 tests 守护——改动须同步两边）。
// 行序即优先级：drag > 放下缓冲 idle > 事件 burst > eat/play/wake > wait
// > 回合/升级 celebrate > working > think > joy > sleep > walk > idle。
function pickState(now = Date.now()) {
  if (!connected) return 'sleep'
  const activity = snapshot?.activity ?? {}
  if (dragging) return 'drag'
  if (dragReleaseUntil > now) return 'idle'
  if (BURST_NAMES.includes(activity.name) && activity.until > now) return activity.name
  if (transient === 'eat') return 'eat'
  if (transient === 'play') return 'play'
  if (transient === 'wake') return 'wake'
  if (activity.sessionWait === true) return 'wait'
  const celebrateUntil = Math.max(activity.turnCompletedUntil ?? 0, levelUpUntil)
  if (celebrateUntil > now) return 'celebrate'
  if (activity.name === 'working') return 'working'
  if (activity.sessionThink === true) return 'think'
  if (joyUntil > now) return 'joy'
  if (sleeping) return 'sleep'
  if (walking) return 'walk'
  return 'idle'
}

function renderFrame(stateConfig) {
  const frames = Math.max(1, stateConfig.frames ?? 1)
  sprite.style.width = `${stageSize}px`
  sprite.style.height = `${stageSize}px`
  sprite.style.backgroundSize = `${stageSize * frames}px ${stageSize}px`
  sprite.style.backgroundPosition = `${-frame * stageSize}px 0`
}

function animate(stateConfig) {
  clearInterval(frameTimer)
  frame = 0
  renderFrame(stateConfig)
  const frames = Math.max(1, stateConfig.frames ?? 1)
  if (frames === 1) return
  let direction = 1
  frameTimer = setInterval(() => {
    if (stateConfig.playback === 'pingpong') {
      frame += direction
      if (frame >= frames - 1 || frame <= 0) direction *= -1
    } else if (stateConfig.playback === 'once') {
      frame = Math.min(frames - 1, frame + 1)
    } else if (stateConfig.playback === 'blink') {
      frame = frame === 0 ? 1 + Math.floor(Math.random() * (frames - 1)) : 0
    } else {
      frame = (frame + 1) % frames
    }
    renderFrame(stateConfig)
  }, Math.max(80, 1000 / Math.max(1, stateConfig.fps ?? 2)))
}

// 账本信号显示：Lv/XP/任务/失败/会话 + 最近回忆或称号（whale-girl snapshot pet 字段）。
function renderLedger() {
  if (!connected || snapshot === null) {
    detail.textContent = '请启动 DSH Web 服务（端口 3080）'
    note.textContent = ''
    note.hidden = true
    return
  }
  const petData = snapshot.pet ?? {}
  const stats = petData.stats ?? {}
  const parts = [`Lv.${petData.level ?? 1}`, `XP ${petData.xp ?? 0}`, `${stats.tasksDone ?? 0} 任务`]
  if ((stats.failures ?? 0) > 0) parts.push(`失败 ${stats.failures}`)
  if ((stats.sessions ?? 0) > 0) parts.push(`会话 ${stats.sessions}`)
  detail.textContent = parts.join(' · ')
  const titles = Array.isArray(petData.titles) ? petData.titles : []
  const memory = Array.isArray(petData.memory) ? petData.memory : []
  const last = memory[memory.length - 1]
  if (typeof last === 'string' && last.length > 0) {
    note.textContent = last
    note.hidden = false
  } else if (titles.length > 0) {
    note.textContent = `称号「${titles.join('」「')}」`
    note.hidden = false
  } else {
    note.textContent = ''
    note.hidden = true
  }
}

function applyState(next) {
  if (character !== null && (next !== currentState || sprite.style.backgroundImage === '')) {
    const config = character.states[next] ?? character.states.idle
    currentState = next
    pet.dataset.state = next
    pet.dataset.motion = config.motion ?? ''
    sprite.style.backgroundImage = `url("${assetsUrl}/${config.sheet}")`
    animate(config)
  }
  status.textContent = STATE_LABELS[next] ?? next
  renderLedger()
  pet.dataset.attention = String(['wait', 'error'].includes(next))
}

function render() { applyState(pickState()) }

function showBubble(text) {
  bubble.textContent = text
  bubble.hidden = false
  clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => { bubble.hidden = true }, cfg.bubbleMs ?? 2500)
}

// ---- 行为运行时 ----

function resetTransient(now) {
  const wasFun = transient === 'eat' || transient === 'play'
  transient = null
  transientUntil = 0
  if (wasFun) joyUntil = now + JOY_MS
}

// 用户在场信号（拖拽放下/喂食/玩耍）：重置空闲计时，正睡着则播 wake 醒觉过渡
// （eat/play 瞬发会覆盖 wake——与 whale-girl client 一致）。
function releaseInteraction() {
  const wasSleeping = sleeping
  sleeping = false
  idleSince = 0
  if (wasSleeping) {
    transient = 'wake'
    transientUntil = Date.now() + WAKE_MS
  }
}

// 睡眠计时（与 whale-girl client 一致）：从「进入 idle 的时刻」起算持续空闲，
// 事件活动（burst/工作）重置；think/wait 是会话陪伴（优先级盖过 sleep，睡眠标志保留）。
function updateIdle(now) {
  const activity = snapshot?.activity ?? {}
  const isActive = activity.name !== 'idle' || (activity.until ?? 0) > now
  if (isActive) idleSince = 0
  else if (idleSince === 0) idleSince = now
  sleeping = connected && activity.name === 'idle' && idleSince !== 0 && now - idleSince > (cfg.sleepAfterMs ?? 60000)
}

function applyFlip() {
  // 素材统一朝左基准：向右走（walkDir=1）→ scaleX(-1) 镜像朝右。
  sprite.style.transform = `scaleX(${walkDir === 1 ? -1 : 1})`
}

function stopWalk() {
  walking = false
  walkAt = 0
  sprite.style.transform = ''
  if (walkRaf !== null) { cancelAnimationFrame(walkRaf); walkRaf = null }
}

function startWalk() {
  const w = cfg.walk ?? CFG_DEFAULTS.walk
  walking = true
  walkDir = Math.random() < 0.5 ? 1 : -1
  walkUntil = performance.now() + randomBetween(w.minMs, w.maxMs)
  applyFlip()
  lastWalkFrame = performance.now()
  walkRaf = requestAnimationFrame(walkStep)
}

// 游走：沿屏幕底部水平移动窗口（宠物随窗口走）；顶到工作区边缘由主进程返回
// moved:false，翻转方向。
function walkStep(t) {
  const w = cfg.walk ?? CFG_DEFAULTS.walk
  if (!walking || sleeping || dragging || transient !== null || t >= walkUntil) {
    stopWalk()
    return
  }
  const dt = Math.min(0.1, Math.max(0, (t - lastWalkFrame) / 1000))
  lastWalkFrame = t
  const dx = walkDir * (w.speedPxPerSec ?? 45) * dt
  window.desktopPet.walkMove(dx).then(result => {
    if (!walking) return
    if (result !== null && typeof result === 'object' && result.moved === false) {
      walkDir = -walkDir
      applyFlip()
    }
    walkRaf = requestAnimationFrame(walkStep)
  }).catch(() => stopWalk())
}

// 静态陪伴态（idle/think/wait）周期排程游走；睡着/交互/瞬发中不排。
function scheduleWalk(now) {
  const w = cfg.walk ?? CFG_DEFAULTS.walk
  if (!w.enabled || !connected) return
  if (currentState !== 'idle' && currentState !== 'think' && currentState !== 'wait') return
  if (sleeping || dragging || transient !== null || walking) return
  if (walkAt === 0) walkAt = now + randomBetween(w.minWaitMs, w.maxWaitMs)
  if (now >= walkAt) startWalk()
}

function tick() {
  const now = Date.now()
  if (transient !== null && now >= transientUntil) resetTransient(now)
  updateIdle(now)
  scheduleWalk(now)
  let next = pickState(now)
  // 睡醒视觉边沿：上一帧 sleep、本帧离开 sleep（非拖拽、无瞬发占用）→ 播 wake。
  if (currentState === 'sleep' && next !== 'sleep' && !dragging && transient === null) {
    transient = 'wake'
    transientUntil = now + WAKE_MS
    next = pickState(now)
  }
  applyState(next)
}

// ---- 配置（/whale-girl/config + configRevision 门控）----

async function fetchConfig() {
  try {
    const body = await window.desktopPet.config()
    return (body !== null && typeof body === 'object') ? body.config : null
  } catch {
    return null
  }
}

function applyConfig(config) {
  if (config === null || typeof config !== 'object') return
  cfg = {
    ...CFG_DEFAULTS,
    ...config,
    walk: { ...CFG_DEFAULTS.walk, ...(config.walk !== null && typeof config.walk === 'object' ? config.walk : {}) },
  }
  if (typeof config.size === 'number') stageSize = config.size
  else if (character !== null) stageSize = character.meta?.stageSize ?? 150
  if (typeof config.opacity === 'number') pet.style.opacity = String(config.opacity)
  // 尺寸变化 → 以新尺寸重排当前帧（不动动画状态）。
  if (character !== null && sprite.style.backgroundImage !== '') {
    renderFrame(character.states[currentState] ?? character.states.idle)
  }
}

function applyConfigIfRevisionChanged() {
  const rev = snapshot?.configRevision
  if (typeof rev === 'number' && rev !== lastConfigRevision) {
    lastConfigRevision = rev
    fetchConfig().then(config => { if (config !== null) applyConfig(config) })
  }
}

// ---- 互动 ----

async function interact(action) {
  stopWalk()
  releaseInteraction()
  transient = action === 'feed' ? 'eat' : 'play'
  transientUntil = Date.now() + TRANSIENT_MS
  render()
  try {
    const result = await window.desktopPet.interact(action)
    if (typeof result.reply === 'string') showBubble(result.reply)
  } catch (error) {
    showBubble(error.message)
  }
}

actions.addEventListener('click', event => {
  if (event.target.closest('button')?.dataset.action === 'quit') window.desktopPet.quit()
})

sprite.addEventListener('pointerdown', event => {
  if (event.button !== 0) return
  stopWalk()
  dragging = true
  dragMoved = false
  pointerOrigin = { x: event.screenX, y: event.screenY }
  pet.dataset.dragging = 'true'
  sprite.setPointerCapture(event.pointerId)
  window.desktopPet.dragStart({ x: event.screenX, y: event.screenY })
  event.preventDefault()
  render()
})

sprite.addEventListener('pointermove', event => {
  if (!dragging) return
  if (!dragMoved && Math.hypot(event.screenX - pointerOrigin.x, event.screenY - pointerOrigin.y) < 5) return
  dragMoved = true
  window.desktopPet.dragMove({ x: event.screenX, y: event.screenY })
})

const finishDrag = event => {
  if (!dragging) return
  const shouldFeed = !dragMoved && event.type === 'pointerup'
  const wasMoved = dragMoved
  dragging = false
  pet.dataset.dragging = 'false'
  pointerOrigin = null
  if (sprite.hasPointerCapture(event.pointerId)) sprite.releasePointerCapture(event.pointerId)
  window.desktopPet.dragEnd()
  if (wasMoved) {
    dragReleaseUntil = Date.now() + DRAG_RELEASE_MS // 放下缓冲：短暂回 idle 再进底层状态
    releaseInteraction()
  }
  if (shouldFeed) interact('feed')
  else render()
}
sprite.addEventListener('pointerup', finishDrag)
sprite.addEventListener('pointercancel', finishDrag)
sprite.addEventListener('contextmenu', event => {
  event.preventDefault()
  interact('play')
})

window.desktopPet.onSnapshot(value => {
  const prev = snapshot
  snapshot = value
  // levelUp 账本信号（快照等效）：观测到等级提升 → 气泡 + 本地庆祝窗口
  // （会话 XP 升级没有事件 burst，靠这里补庆祝）。
  if (prev !== null && Number.isFinite(prev.pet?.level) && Number.isFinite(value.pet?.level) && value.pet.level > prev.pet.level) {
    levelUpUntil = Date.now() + LEVEL_UP_CELEBRATE_MS
    showBubble(`升级到 Lv.${value.pet.level} 🎉`)
  }
  applyConfigIfRevisionChanged()
  render()
})
window.desktopPet.onConnection(value => {
  connected = value.connected === true
  connection.textContent = connected ? 'DSH 已连接' : 'DSH 未连接'
  if (connected && character === null) loadCharacter().catch(showAssetError)
  render()
})

async function loadCharacter() {
  manifest = await window.desktopPet.manifest()
  character = manifest.characters?.[manifest.default]
  if (!character?.states) throw new Error('鲸鱼娘资源清单无效')
  if (typeof cfg.size !== 'number') stageSize = character.meta?.stageSize ?? 150
  render()
}

function showAssetError(error) {
  connection.textContent = '资源加载失败'
  status.textContent = '鲸鱼娘暂时不可用'
  detail.textContent = error.message
  note.textContent = ''
  note.hidden = true
  pet.dataset.attention = 'true'
}

async function start() {
  const bootstrap = await window.desktopPet.bootstrap()
  assetsUrl = bootstrap.assetsUrl
  try {
    const body = await window.desktopPet.config()
    if (body !== null && typeof body === 'object' && body.config) applyConfig(body.config)
  } catch {}
  try { await loadCharacter() } catch {}
  try { snapshot = await window.desktopPet.refresh() } catch {}
  tickTimer = setInterval(tick, TICK_MS)
  render()
}

start().catch(showAssetError)
