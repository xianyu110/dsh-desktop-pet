'use strict'

const pet = document.querySelector('#pet')
const sprite = document.querySelector('#sprite')
const status = document.querySelector('#status')
const detail = document.querySelector('#detail')
const connection = document.querySelector('#connection')
const bubble = document.querySelector('#bubble')
const actions = document.querySelector('#actions')

const STATE_LABELS = {
  idle: '准备好了', working: '正在使用工具', celebrate: '任务完成', error: '请求失败',
  disappointed: '休息一下', think: '正在深入思考', wait: '等待你的批准',
  welcome: '新会话', sleep: '正在等待 DSH', eat: '吃点东西', play: '一起玩吧',
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

function chooseState(value, now = Date.now()) {
  if (!connected || value === null) return 'sleep'
  const activity = value.activity ?? {}
  if (activity.turnCompletedUntil > now) return 'celebrate'
  if (['welcome', 'celebrate', 'error', 'disappointed'].includes(activity.name) && activity.until > now) return activity.name
  if (activity.sessionWait === true) return 'wait'
  if (activity.sessionThink === true) return 'think'
  if (activity.name === 'working') return 'working'
  return 'idle'
}

function renderFrame(stateConfig) {
  const frames = Math.max(1, stateConfig.frames ?? 1)
  const stage = 150
  sprite.style.width = `${stage}px`
  sprite.style.height = `${stage}px`
  sprite.style.backgroundSize = `${stage * frames}px ${stage}px`
  sprite.style.backgroundPosition = `${-frame * stage}px 0`
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

function applyState(next) {
  if (character === null) return
  const config = character.states[next] ?? character.states.idle
  if (next !== currentState || sprite.style.backgroundImage === '') {
    currentState = next
    pet.dataset.state = next
    pet.dataset.motion = config.motion ?? ''
    sprite.style.backgroundImage = `url("${assetsUrl}/${config.sheet}")`
    animate(config)
  }
  status.textContent = STATE_LABELS[next] ?? next
  const stats = snapshot?.pet?.stats
  detail.textContent = connected && stats
    ? `等级 ${snapshot.pet.level ?? 1} · 已完成 ${stats.tasksDone ?? 0} 个任务 · 所有会话`
    : '请启动 DSH Web 服务（端口 3080）'
  pet.dataset.attention = String(['wait', 'error'].includes(next))
}

function render() { applyState(chooseState(snapshot)) }

function showBubble(text) {
  bubble.textContent = text
  bubble.hidden = false
  clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => { bubble.hidden = true }, 2500)
}

async function interact(action) {
  try {
    applyState(action === 'feed' ? 'eat' : 'play')
    const result = await window.desktopPet.interact(action)
    if (typeof result.reply === 'string') showBubble(result.reply)
    setTimeout(render, 1500)
  } catch (error) {
    showBubble(error.message)
  }
}

actions.addEventListener('click', event => {
  if (event.target.closest('button')?.dataset.action === 'quit') window.desktopPet.quit()
})

sprite.addEventListener('pointerdown', event => {
  if (event.button !== 0) return
  dragging = true
  dragMoved = false
  pointerOrigin = { x: event.screenX, y: event.screenY }
  pet.dataset.dragging = 'true'
  sprite.setPointerCapture(event.pointerId)
  window.desktopPet.dragStart({ x: event.screenX, y: event.screenY })
  event.preventDefault()
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
  dragging = false
  pet.dataset.dragging = 'false'
  pointerOrigin = null
  if (sprite.hasPointerCapture(event.pointerId)) sprite.releasePointerCapture(event.pointerId)
  window.desktopPet.dragEnd()
  if (shouldFeed) interact('feed')
}
sprite.addEventListener('pointerup', finishDrag)
sprite.addEventListener('pointercancel', finishDrag)
sprite.addEventListener('contextmenu', event => {
  event.preventDefault()
  interact('play')
})

window.desktopPet.onSnapshot(value => { snapshot = value; render() })
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
  render()
}

function showAssetError(error) {
  connection.textContent = '资源加载失败'
  status.textContent = '鲸鱼娘暂时不可用'
  detail.textContent = error.message
  pet.dataset.attention = 'true'
}

async function start() {
  const bootstrap = await window.desktopPet.bootstrap()
  assetsUrl = bootstrap.assetsUrl
  try { await loadCharacter() } catch {}
  try { snapshot = await window.desktopPet.refresh() } catch {}
  render()
}

start().catch(showAssetError)
