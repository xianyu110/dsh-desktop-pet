'use strict'
// Tauri 后端桥：把渲染端沿用的 window.desktopPet 接口映射到 Tauri invoke/listen
// （替代 Electron 的 preload.cjs）。index.html 在 renderer.js 之前加载本文件。
// Electron 环境下 preload.cjs 已提供 window.desktopPet，本文件自动跳过。
if (window.__TAURI__ !== undefined) {
  const invoke = window.__TAURI__.core.invoke
  const listen = window.__TAURI__.event.listen

  window.desktopPet = {
    bootstrap: () => invoke('bootstrap'),
    manifest: () => invoke('manifest'),
    config: () => invoke('config'),
    sessions: () => invoke('sessions'),
    refresh: () => invoke('refresh'),
    interact: action => invoke('interact', { action }),
    // Electron 的点击穿透开关在 Tauri 下无对应（窗口已贴合内容，无需穿透）
    setClickThrough: () => {},
    dragStart: point => invoke('drag_start', { point }),
    dragMove: point => invoke('drag_move', { point }),
    dragEnd: () => invoke('drag_end'),
    walkMove: dx => invoke('walk_move', { dx }),
    // 内容高度 → 窗口贴合（解决隐形背景挡住桌面操作）
    resizeToContent: height => invoke('resize_to_content', { height }),
    quit: () => invoke('quit'),
    onSnapshot: listener => listen('pet:snapshot', event => listener(event.payload)),
    onConnection: listener => listen('pet:connection', event => listener(event.payload)),
  }
}
