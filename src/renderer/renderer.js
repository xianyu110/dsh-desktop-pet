'use strict'

const pet = document.querySelector('#pet')
const stage = document.querySelector('#stage')
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
let stageSize = 128
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
let blinkAt = 0 // 常态帧 0 静止，随机间隔眨眼（对齐网页端 nextBlinkAt 节奏）
let blinkActive = false
let flip = 1 // 素材朝左基准：1=朝左，-1=镜像朝右（对齐网页端 flip；动作间保持连续）
let facingAt = 0 // 静态陪伴态（idle/think/wait）下次随机转身时刻（对齐网页端 nextFacingAt）
let lastPointerX = 0 // 拖拽方向朝向（对比上一指针位置）

function randomBetween(min, max) {
  return min + Math.random() * Math.max(0, max - min)
}

// 桌面端展示尺寸：素材帧 256px 取整数倍缩放（128=2x 最清晰，非整数倍发虚）；
// 夹取 128–160——config.size 默认 110 是给网页端小尺寸的，桌面窗口里太小像贴纸。
function desktopStage(size) {
  return Math.min(160, Math.max(128, size))
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
  // stage 与 sprite 同步尺寸（stage 承载位移动画，sprite 承载帧图与翻转）
  stage.style.width = `${stageSize}px`
  stage.style.height = `${stageSize}px`
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
  blinkAt = 0
  blinkActive = false
  frameTimer = setInterval(() => {
    if (stateConfig.playback === 'pingpong') {
      frame += direction
      if (frame >= frames - 1 || frame <= 0) direction *= -1
    } else if (stateConfig.playback === 'once') {
      frame = Math.min(frames - 1, frame + 1)
    } else if (stateConfig.playback === 'blink') {
      // 常态帧 0 静止，随机间隔（3-9s）眨一次眼（0→1→…→N-1→0）——对齐网页端，
      // 不再每个 tick 随机跳帧（旧版每 500ms 乱跳像抽搐）。
      if (blinkActive) {
        frame += 1
        if (frame >= frames) {
          frame = 0
          blinkActive = false
          blinkAt = Date.now() + 3000 + Math.random() * 6000
        }
      } else {
        if (frame !== 0) frame = 0
        if (blinkAt === 0) blinkAt = Date.now() + 3000 + Math.random() * 6000
        if (Date.now() >= blinkAt) blinkActive = true
      }
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

// ---- 会话气泡（/whale-girl/sessions：每会话 thinking / tool:<name> / waiting / done）----
// 三种模式：all=全部竖叠 / one=单个+背后卡片（左键动画切下一个）/ count=数量圆点；
// 任一会话等待批准时三模式都有红色提醒。模式持久化到 localStorage。
const bubbleZone = document.querySelector('#bubble-zone')
const MODES = ['all', 'one', 'count']
const MODE_GLYPH = { all: '≡', one: '▣', count: '●' }
const SESSION_POLL_MS = 2000
const DONE_HIDE_MS = 60000 // 已完成会话展示窗口：完成后 1 分钟内可见（完成反馈），超时隐藏
const TOOL_LABELS = {
  bash: '运行命令', pwsh: '运行命令', powershell: '运行命令', shell: '运行命令', cmd: '运行命令',
  edit: '编辑文件', write: '写文件', read: '读取文件', glob: '查找文件', grep: '搜索内容',
  webfetch: '浏览网页', browse: '浏览网页', fetch: '拉取数据',
}

let sessions = [] // 排序后的会话视图 [{ id, title, activity, since }]
let bubbleMode = 'all'
let oneIndex = 0
let lastCount = -1
let lastWaitingIds = new Set()
let sessionPollTimer = null
let doneSince = new Map() // 会话 id → 变为 done 的时刻（驱动 DONE_HIDE_MS 隐藏）
let shownIds = new Set()  // 最近一次渲染展示的会话 id（轮询据此判断可见性变化）

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function isWaiting(s) { return s.activity === 'waiting' }
function isActive(s) { return s.activity !== 'done' }
function sessionRank(s) {
  if (s.activity === 'waiting') return 0
  if (s.activity === 'thinking' || (typeof s.activity === 'string' && s.activity.startsWith('tool:'))) return 1
  return 2
}
function sortSessions(list) {
  return [...list].sort((a, b) => sessionRank(a) - sessionRank(b) || (b.since ?? 0) - (a.since ?? 0))
}

// 展示列表：已完成会话仅在 DONE_HIDE_MS 窗口内可见（完成反馈），超时隐藏
function visibleSessions() {
  const now = Date.now()
  return sessions.filter(s => s.activity !== 'done' || now - (doneSince.get(s.id) ?? now) <= DONE_HIDE_MS)
}

function activityLabel(s) {
  const a = s.activity
  if (a === 'thinking') return { text: '思考中…', cls: 'dot-thinking' }
  if (a === 'waiting') return { text: '等待你的批准', cls: 'dot-waiting' }
  if (a === 'done') return { text: '已完成', cls: 'dot-done' }
  if (typeof a === 'string' && a.startsWith('tool:')) {
    const tool = a.slice(5)
    return { text: TOOL_LABELS[tool] ?? `使用 ${tool}`, cls: 'dot-tool' }
  }
  return { text: String(a), cls: 'dot-done' }
}

function cardBody(s) {
  const act = activityLabel(s)
  return `<div class="s-title">${escapeHtml(s.title ?? '未命名会话')}</div>`
    + `<div class="s-activity"><span class="s-dot ${act.cls}"></span>${act.text}</div>`
}

// 活动类别 → data-activity（驱动卡片 --card-state 上色：左条/右指示/圆点）
function activityKind(s) {
  return s.activity === 'thinking' ? 'thinking'
    : s.activity === 'waiting' ? 'waiting'
      : s.activity === 'done' ? 'done'
        : typeof s.activity === 'string' && s.activity.startsWith('tool:') ? 'tool' : 'idle'
}

function cardHTML(s, changed) {
  return `<div class="session-card${changed ? ' s-flash' : ''}" data-activity="${activityKind(s)}" data-waiting="${isWaiting(s)}" data-done="${s.activity === 'done'}">${cardBody(s)}</div>`
}

function setMode(mode) {
  bubbleMode = mode
  try { localStorage.setItem('pet:bubble-mode', mode) } catch {}
  renderBubbles()
}

// 窗口贴合内容高度（Tauri）：气泡区 + 宠物 236px + 上下边距；
// 内容变化时让后端 resize（窗口向上生长，保持宠物贴屏幕底部），
// 彻底消除透明窗口大块隐形背景挡住桌面操作的问题。
let sizeSyncTimer = null
function syncWindowSize() {
  clearTimeout(sizeSyncTimer)
  sizeSyncTimer = setTimeout(() => {
    if (typeof window.desktopPet.resizeToContent !== 'function') return
    const zoneH = bubbleZone.hidden ? 0 : bubbleZone.offsetHeight + 6
    const height = 266 + zoneH // 10 上边距 + 气泡区 + 间距 + 236 宠物 + 14 下边距
    window.desktopPet.resizeToContent(height)
  }, 60)
}

function bindModeBadge() {
  bubbleZone.querySelector('.mode-badge')?.addEventListener('click', () => {
    setMode(MODES[(MODES.indexOf(bubbleMode) + 1) % MODES.length])
  })
}

function renderAllMode(changedIds) {
  bubbleZone.dataset.mode = 'all'
  bubbleZone.innerHTML = `<div class="bubble-toolbar"><button class="mode-badge" title="切换显示模式" data-mode="all">${MODE_GLYPH.all}</button></div>`
    + `<div class="bubble-stack">${visibleSessions().map(s => cardHTML(s, changedIds.has(s.id))).join('')}</div>`
  bindModeBadge()
}

function animateDeckNext(deck) {
  if (deck.dataset.animating === 'true') return // 连点防抖：动画中忽略
  deck.dataset.animating = 'true'
  const front = deck.querySelector('.deck-front')
  const height = front.offsetHeight || 56
  front.animate(
    [{ transform: 'translateY(0)', opacity: 1 }, { transform: `translateY(-${height + 10}px)`, opacity: 0 }],
    { duration: 170, easing: 'ease-in' },
  ).finished.then(() => {
    oneIndex = (oneIndex + 1) % onePoolLength()
    renderBubbles()
    const nextFront = bubbleZone.querySelector('.deck-front')
    if (nextFront !== null) {
      nextFront.animate(
        [{ transform: 'translateY(12px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }],
        { duration: 210, easing: 'ease-out' },
      )
    }
  }).catch(() => {})
}

// 单会话模式的循环池：活跃会话优先（思考/工具/等待），全部完成时回退可见会话
function onePool() {
  const visible = visibleSessions()
  const active = visible.filter(isActive)
  return active.length > 0 ? active : visible
}
function onePoolLength() { return Math.max(1, onePool().length) }

function renderOneMode(changedIds) {
  bubbleZone.dataset.mode = 'one'
  const pool = onePool()
  if (pool.length === 0) return
  if (oneIndex >= pool.length) oneIndex = 0
  const front = pool[oneIndex]
  const hasBehind = pool.length > 1 // 只有一个活跃会话时不露背后卡片
  const behind = hasBehind
    ? [pool[(oneIndex + 1) % pool.length], pool[(oneIndex + 2) % pool.length]]
    : []
  bubbleZone.innerHTML = `<div class="bubble-toolbar"><button class="mode-badge" title="切换显示模式" data-mode="one">${MODE_GLYPH.one}</button></div>`
    + `<div class="bubble-deck${hasBehind ? '' : ' deck-single'}">`
    + behind.map((s, i) => `<div class="session-card deck-behind" style="top:${8 + i * 6}px;z-index:${2 - i}" data-activity="${activityKind(s)}" data-done="${s.activity === 'done'}">${cardBody(s)}</div>`).join('')
    + `<div class="session-card deck-front${changedIds.has(front.id) ? ' s-flash' : ''}" style="top:${hasBehind ? 20 : 0}px" data-activity="${activityKind(front)}" data-waiting="${isWaiting(front)}" data-done="${front.activity === 'done'}">${cardBody(front)}</div>`
    + `</div>`
  bindModeBadge()
  if (!hasBehind) return // 单会话：无可切换目标，不绑点击
  bubbleZone.querySelector('.bubble-deck').addEventListener('click', event => {
    if (event.target.closest('.mode-badge') !== null) return
    animateDeckNext(bubbleZone.querySelector('.bubble-deck'))
  })
}

function renderCountMode() {
  bubbleZone.dataset.mode = 'count'
  const visible = visibleSessions()
  const count = visible.filter(isActive).length
  const waiting = visible.some(isWaiting)
  const dots = visible.map(s => `<span class="status-dot ${activityLabel(s).cls}" title="${escapeHtml(s.title ?? '未命名会话')}：${escapeHtml(activityLabel(s).text)}"></span>`).join('')
  bubbleZone.innerHTML = `<div class="bubble-toolbar"><button class="mode-badge" title="切换显示模式" data-mode="count">${MODE_GLYPH.count}</button>`
    + `<button class="bubble-count" data-waiting="${waiting}" data-zero="${visible.length === 0}" aria-label="${count} 个活跃会话，点击展开" title="会话状态，点击展开">${dots}</button></div>`
  bindModeBadge()
  const dot = bubbleZone.querySelector('.bubble-count')
  dot.addEventListener('click', () => setMode('one'))
  if (count !== lastCount) {
    lastCount = count
    dot.animate(
      [{ transform: 'scale(1.4)' }, { transform: 'scale(1)' }],
      { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' },
    )
  }
}

function renderBubbles(changedIds = new Set()) {
  const visible = visibleSessions()
  if (!connected || visible.length === 0) {
    bubbleZone.hidden = true
    document.body.classList.remove('has-bubbles')
    shownIds = new Set()
    lastWaitingIds = new Set() // 断线/清空后复位，重连时新等待会话能再次自动聚焦
    syncWindowSize()
    return
  }
  shownIds = new Set(visible.map(s => s.id))
  bubbleZone.hidden = false
  document.body.classList.add('has-bubbles')
  bubbleZone.dataset.waiting = String(visible.some(isWaiting))
  // 新模式等待批准的会话：自动聚焦（提醒用户），但不打断用户手动切换
  const waitingIds = new Set(visible.filter(isWaiting).map(s => s.id))
  if ([...waitingIds].some(id => !lastWaitingIds.has(id))) {
    const firstWaiting = visible.findIndex(isWaiting)
    if (firstWaiting !== -1) oneIndex = firstWaiting
  }
  lastWaitingIds = waitingIds
  if (bubbleMode === 'count') renderCountMode()
  else if (bubbleMode === 'one') renderOneMode(changedIds)
  else renderAllMode(changedIds)
  syncWindowSize()
}

async function pollSessions() {
  if (!connected) {
    if (sessions.length > 0) { sessions = []; renderBubbles() }
    return
  }
  try {
    const list = await window.desktopPet.sessions()
    if (!Array.isArray(list)) return
    const now = Date.now()
    const prev = new Map(sessions.map(s => [s.id, s.activity]))
    const next = sortSessions(list)
    // 维护 done 计时：进入 done 记时刻；离开 done 或不在列表则清除（防 Map 无限增长）
    const nextIds = new Set(next.map(s => s.id))
    for (const id of doneSince.keys()) if (!nextIds.has(id)) doneSince.delete(id)
    for (const s of next) {
      if (s.activity === 'done') { if (!doneSince.has(s.id)) doneSince.set(s.id, now) }
      else doneSince.delete(s.id)
    }
    const changedIds = new Set(next.filter(s => prev.get(s.id) !== s.activity).map(s => s.id))
    // 可见性变化（含已完成会话跨过 DONE_HIDE_MS 隐藏窗口）也要触发重渲染
    const isVisible = s => s.activity !== 'done' || now - (doneSince.get(s.id) ?? now) <= DONE_HIDE_MS
    const nextVisible = new Set(next.filter(isVisible).map(s => s.id))
    const visibilityChanged = nextVisible.size !== shownIds.size
      || [...nextVisible].some(id => !shownIds.has(id))
    if (changedIds.size === 0 && !visibilityChanged) return
    sessions = next
    renderBubbles(changedIds)
  } catch {}
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

// 朝向刷新：flip 是共享朝向（1=朝左 / -1=朝右），walk/drag/静态转身都写它，
// 动作间保持连续（对齐网页端 flip 语义）。
function applyFacing() {
  sprite.style.transform = `scaleX(${flip})`
}

// 静态陪伴态（idle/think/wait）偶尔随机转身（10–25s，对齐网页端 nextFacingAt）；
// 离开静态态时清排程，下次重进重新随机——不转身的态不误触发旧时刻。
function updateFacing(now) {
  if (currentState === 'idle' || currentState === 'think' || currentState === 'wait') {
    if (facingAt === 0) facingAt = now + 10000 + Math.random() * 15000
    if (now >= facingAt) {
      flip = -flip
      applyFacing()
      facingAt = now + 10000 + Math.random() * 15000
    }
  } else if (facingAt !== 0) {
    facingAt = 0
  }
}

function stopWalk() {
  walking = false
  walkAt = 0
  // 不重置 flip：朝向连续（walk 停止后保持最后朝向，静态态随机转身再改写）
  if (walkRaf !== null) { cancelAnimationFrame(walkRaf); walkRaf = null }
}

function startWalk() {
  const w = cfg.walk ?? CFG_DEFAULTS.walk
  walking = true
  walkDir = Math.random() < 0.5 ? 1 : -1
  // 素材统一朝左基准：向右走（walkDir=1）→ 镜像朝右（flip=-1）
  flip = -walkDir
  walkUntil = performance.now() + randomBetween(w.minMs, w.maxMs)
  applyFacing()
  lastWalkFrame = performance.now()
  walkRaf = requestAnimationFrame(walkStep)
}

// 游走：沿屏幕底部水平移动窗口（宠物随窗口走）；顶到工作区边缘由主进程返回
// moved:false，翻转方向。
function walkStep(t) {
  const w = cfg.walk ?? CFG_DEFAULTS.walk
  const activity = snapshot?.activity ?? {}
  // 会话活跃（think/wait 陪伴）或睡着/交互/瞬发 → 停走（与网页端一致：
  // 否则窗口在动、动画却停在 think/wait——走路动画不触发）
  if (!walking || sleeping || dragging || transient !== null
    || activity.sessionThink === true || activity.sessionWait === true || t >= walkUntil) {
    stopWalk()
    return
  }
  const dt = Math.min(0.1, Math.max(0, (t - lastWalkFrame) / 1000))
  lastWalkFrame = t
  const dx = walkDir * (w.speedPxPerSec ?? 45) * dt
  window.desktopPet.walkMove(dx).then(result => {
    if (!walking) return
    if (result?.unavailable === true) {
      stopWalk()
      return
    }
    if (result !== null && typeof result === 'object' && result.moved === false) {
      walkDir = -walkDir
      flip = -flip
      applyFacing()
    }
    walkRaf = requestAnimationFrame(walkStep)
  }).catch(() => stopWalk())
}

// 只在纯 idle 时排程游走（think/wait 是会话陪伴态，网页端同样不游走；
// 游走开始后 pickState 的 walk 行才能命中——否则窗口在动却显示陪伴动画）。
function scheduleWalk(now) {
  const w = cfg.walk ?? CFG_DEFAULTS.walk
  if (!w.enabled || !connected) return
  if (currentState !== 'idle') return
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
  updateFacing(now)
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
  if (typeof config.size === 'number') stageSize = desktopStage(config.size)
  else if (character !== null) stageSize = desktopStage(character.meta?.stageSize ?? 128)
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
  lastPointerX = event.screenX
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
  // 拖拽方向 → 朝向（对齐网页端：向左拖朝左 flip=1，向右拖朝右 flip=-1）
  const nextFlip = event.screenX < lastPointerX ? 1 : -1
  if (nextFlip !== flip) {
    flip = nextFlip
    applyFacing()
  }
  lastPointerX = event.screenX
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
  if (connected) pollSessions()
  else renderBubbles()
  render()
  syncWindowSize()
})
async function loadCharacter() {
  manifest = await window.desktopPet.manifest()
  if (manifest === null) throw new Error('DSH 尚未启动')
  character = manifest.characters?.[manifest.default]
  if (!character?.states) throw new Error('鲸鱼娘资源清单无效')
  if (typeof cfg.size !== 'number') stageSize = desktopStage(character.meta?.stageSize ?? 128)
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
  try {
    const saved = localStorage.getItem('pet:bubble-mode')
    if (MODES.includes(saved)) bubbleMode = saved
  } catch {}
  tickTimer = setInterval(tick, TICK_MS)
  sessionPollTimer = setInterval(pollSessions, SESSION_POLL_MS)
  pollSessions()
  render()
  syncWindowSize()
}

start().catch(showAssetError)
