// 大肥鱼（dsh-desktop-pet）Tauri 后端：从 Electron 版 main.cjs 移植。
// 职责：透明置顶窗口 + 托盘 + DSH 连接（SSE /state 推送）+ 在场心跳 +
// 窗口拖拽/游走/贴合内容尺寸 + HTTP IPC。
//
// 相对 Electron 的修正：
// - 没有 Ctrl+W 默认关闭绑定；且 CloseRequested 一律 prevent（宠物只能经托盘/按钮退出）
// - 窗口宽度贴合内容（224px），高度由渲染端按气泡内容动态 resize，
//   不再有 280×520 的大块隐形背景挡住桌面点击

use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Window};

const WINDOW_WIDTH: i32 = 224; // 贴合内容：190 宠物/气泡 + 两侧 16/18 边距
const WINDOW_HEIGHT_MIN: f64 = 260.0; // 最小高度（无气泡时）
const RETRY_MIN_MS: u64 = 1000;
const RETRY_MAX_MS: u64 = 15000;
const PRESENCE_INTERVAL_MS: u64 = 15_000; // 与 whale-girl presence 契约一致

struct AppState {
    dsh_url: String,
    client: reqwest::Client,
    quitting: AtomicBool,
    /// 拖拽记账：(pointerX, pointerY, windowX, windowY)
    drag_origin: Mutex<Option<(f64, f64, i32, i32)>>,
}

// ---------- 工具 ----------

fn cli_value(name: &str) -> Option<String> {
    let args: Vec<String> = env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn normalize_dsh_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim_end_matches('/');
    let rest = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))
        .ok_or("DSH 地址必须使用 HTTP 或 HTTPS")?;
    let host = rest.split(['/', ':', '?', '#']).next().unwrap_or("");
    let loopback = ["127.0.0.1", "localhost", "::1", "[::1]"];
    if !loopback.contains(&host) {
        return Err("DSH 地址必须指向本机".into());
    }
    Ok(trimmed.to_string())
}

fn endpoint(base: &str, path: &str) -> String {
    format!("{}{}", base, path)
}

/// 会话显示后端（移植 linuxDisplayBackend）：Wayland 下合成器接管窗口移动，
/// 程序化 set_position 不可用（渲染端据此禁用拖拽/游走）。
fn display_backend() -> &'static str {
    if let Ok(v) = env::var("DSH_DESKTOP_PET_OZONE") {
        return if v == "wayland" { "wayland" } else { "x11" };
    }
    let wayland = env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland")
        || env::var("WAYLAND_DISPLAY").map(|v| !v.is_empty()).unwrap_or(false);
    if wayland { "wayland" } else { "x11" }
}

fn can_programmatically_move() -> bool {
    display_backend() != "wayland"
}

// ---------- 位置持久化 ----------

fn state_file(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|p| p.join("window-state.json"))
        .unwrap_or_else(|_| PathBuf::from("window-state.json"))
}

fn load_position(app: &AppHandle) -> Option<(i32, i32)> {
    let text = fs::read_to_string(state_file(app)).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    Some((v.get("x")?.as_i64()? as i32, v.get("y")?.as_i64()? as i32))
}

fn save_position(app: &AppHandle, x: i32, y: i32) {
    if let Some(parent) = state_file(app).parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(state_file(app), json!({ "x": x, "y": y }).to_string());
}

/// 把目标位置 clamp 进当前显示器（无工作区 API，用显示器全尺寸近似）。
fn clamp_position(window: &Window, x: i32, y: i32) -> (i32, i32) {
    let Some(monitor) = window.current_monitor().ok().flatten() else {
        return (x, y);
    };
    let mpos = monitor.position();
    let msize = monitor.size();
    let wsize = window.outer_size().unwrap_or(PhysicalSize::new(0, 0));
    let max_x = mpos.x + msize.width as i32 - wsize.width as i32;
    let max_y = mpos.y + msize.height as i32 - wsize.height as i32;
    (x.clamp(mpos.x, max_x), y.clamp(mpos.y, max_y))
}

// ---------- HTTP ----------

/// 普通请求超时（SSE 长连接不走这里——见 follow_events）。
const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

async fn read_json(client: &reqwest::Client, url: &str) -> Result<Value, String> {
    let fut = async {
        let res = client.get(url).send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("HTTP {}", res.status()));
        }
        res.json::<Value>().await.map_err(|e| e.to_string())
    };
    tokio::time::timeout(HTTP_TIMEOUT, fut).await.map_err(|_| "HTTP 超时".to_string())?
}

/// 拉 /state 并广播给渲染端（snapshot + connection）。
async fn fetch_and_emit(app: &AppHandle) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let snapshot = read_json(&state.client, &endpoint(&state.dsh_url, "/whale-girl/state")).await?;
    let _ = app.emit("pet:snapshot", &snapshot);
    let _ = app.emit("pet:connection", json!({ "connected": true, "dshUrl": state.dsh_url }));
    Ok(snapshot)
}

/// SSE 跟随：收到任意 data: 事件即刷新 /state（轮询兜底由渲染端 2s sessions 轮询 + 本循环重连覆盖）。
async fn follow_events(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let url = endpoint(&state.dsh_url, "/whale-girl/events");
    let res = state
        .client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("SSE HTTP {}", res.status()));
    }
    // 连接成功即先刷新一次（对齐 Electron 版）
    let _ = fetch_and_emit(&app).await;
    let mut stream = res.bytes_stream();
    let mut buffer = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buffer.find("\n\n") {
            let event = buffer[..pos].to_string();
            buffer.drain(..pos + 2);
            if event.lines().any(|l| l.starts_with("data:")) {
                let _ = fetch_and_emit(&app).await;
            }
        }
    }
    Err("SSE connection closed".into())
}

async fn connection_loop(app: AppHandle) {
    let mut retry = RETRY_MIN_MS;
    loop {
        if app.state::<AppState>().quitting.load(Ordering::SeqCst) {
            return;
        }
        match follow_events(app.clone()).await {
            Ok(()) => retry = RETRY_MIN_MS,
            Err(message) => {
                if app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                    return;
                }
                let _ = app.emit(
                    "pet:connection",
                    json!({ "connected": false, "dshUrl": app.state::<AppState>().dsh_url, "message": message }),
                );
                tokio::time::sleep(std::time::Duration::from_millis(retry)).await;
                retry = (retry * 2).min(RETRY_MAX_MS);
            }
        }
    }
}

// ---------- 在场心跳（桌面伴侣在线 → 网页端宠物隐藏） ----------

async fn poke_presence(app: &AppHandle, online: bool) {
    let state = app.state::<AppState>();
    let url = endpoint(&state.dsh_url, "/whale-girl/presence");
    let fut = state
        .client
        .post(&url)
        .header("content-type", "application/json")
        .body(format!(r#"{{"online":{}}}"#, online))
        .send();
    let _ = tokio::time::timeout(HTTP_TIMEOUT, fut).await;
}

async fn presence_loop(app: AppHandle) {
    loop {
        if app.state::<AppState>().quitting.load(Ordering::SeqCst) {
            return;
        }
        poke_presence(&app, true).await;
        tokio::time::sleep(std::time::Duration::from_millis(PRESENCE_INTERVAL_MS)).await;
    }
}

// ---------- IPC 命令 ----------

#[derive(Deserialize)]
struct Point {
    x: f64,
    y: f64,
}

#[tauri::command]
fn bootstrap(app: AppHandle) -> Value {
    let state = app.state::<AppState>();
    json!({
        "dshUrl": state.dsh_url,
        "assetsUrl": endpoint(&state.dsh_url, "/whale-girl/assets/characters/whale-girl"),
        "canProgrammaticallyMove": can_programmatically_move(),
    })
}

#[tauri::command]
async fn manifest(app: AppHandle) -> Option<Value> {
    let state = app.state::<AppState>();
    read_json(&state.client, &endpoint(&state.dsh_url, "/whale-girl/assets/manifest.json")).await.ok()
}

#[tauri::command]
async fn config(app: AppHandle) -> Option<Value> {
    let state = app.state::<AppState>();
    read_json(&state.client, &endpoint(&state.dsh_url, "/whale-girl/config")).await.ok()
}

#[tauri::command]
async fn sessions(app: AppHandle) -> Option<Value> {
    let state = app.state::<AppState>();
    read_json(&state.client, &endpoint(&state.dsh_url, "/whale-girl/sessions")).await.ok()
}

#[tauri::command]
async fn refresh(app: AppHandle) -> Option<Value> {
    fetch_and_emit(&app).await.ok()
}

#[tauri::command]
async fn interact(app: AppHandle, action: String) -> Result<Value, String> {
    if action != "feed" && action != "play" {
        return Err("不支持的互动方式".into());
    }
    let state = app.state::<AppState>();
    let fut = async {
        let res = state
            .client
            .post(endpoint(&state.dsh_url, "/whale-girl/interact"))
            .header("content-type", "application/json")
            .body(json!({ "action": action }).to_string())
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("HTTP {}", res.status()));
        }
        res.json::<Value>().await.map_err(|e| e.to_string())
    };
    tokio::time::timeout(HTTP_TIMEOUT, fut).await.map_err(|_| "HTTP 超时".to_string())?
}

#[tauri::command]
fn drag_start(app: AppHandle, window: Window, point: Point) {
    if !can_programmatically_move() {
        return;
    }
    if let Ok(pos) = window.outer_position() {
        *app.state::<AppState>().drag_origin.lock().unwrap() = Some((point.x, point.y, pos.x, pos.y));
    }
}

#[tauri::command]
fn drag_move(app: AppHandle, window: Window, point: Point) {
    if !can_programmatically_move() {
        return;
    }
    let origin = *app.state::<AppState>().drag_origin.lock().unwrap();
    if let Some((px, py, wx, wy)) = origin {
        let target_x = (wx as f64 + point.x - px).round() as i32;
        let target_y = (wy as f64 + point.y - py).round() as i32;
        let (x, y) = clamp_position(&window, target_x, target_y);
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

#[tauri::command]
fn drag_end(app: AppHandle, window: Window) {
    *app.state::<AppState>().drag_origin.lock().unwrap() = None;
    if let Ok(pos) = window.outer_position() {
        save_position(&app, pos.x, pos.y);
    }
}

#[tauri::command]
fn walk_move(window: Window, dx: f64) -> Value {
    if !can_programmatically_move() {
        return json!({ "moved": false, "unavailable": true });
    }
    if !dx.is_finite() || dx == 0.0 {
        return json!({ "moved": false });
    }
    let Ok(pos) = window.outer_position() else {
        return json!({ "moved": false });
    };
    let target_x = (pos.x as f64 + dx).round() as i32;
    let (x, y) = clamp_position(&window, target_x, pos.y);
    let _ = window.set_position(PhysicalPosition::new(x, y));
    json!({ "moved": x != pos.x })
}

/// 渲染端按内容高度调用：窗口改为目标高度并向"上"生长（保持底部贴边，
/// 底部 = 宠物所在边），彻底消除大块隐形背景。
#[tauri::command]
fn resize_to_content(window: Window, height: f64) {
    let h = height.round().max(WINDOW_HEIGHT_MIN) as u32;
    let scale = window.scale_factor().unwrap_or(1.0);
    let phys_h = (h as f64 * scale).round() as u32;
    let phys_w = (WINDOW_WIDTH as f64 * scale).round() as u32;
    let (cur_x, cur_y) = window.outer_position().map(|p| (p.x, p.y)).unwrap_or((0, 0));
    let cur_phys_h = window.outer_size().map(|s| s.height).unwrap_or(phys_h);
    let _ = window.set_size(PhysicalSize::new(phys_w, phys_h));
    let dy = phys_h as i32 - cur_phys_h as i32;
    if dy != 0 {
        let _ = window.set_position(PhysicalPosition::new(cur_x, cur_y - dy));
    }
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // 干净退出先通知 whale-girl 下线（网页端宠物立即恢复；崩溃由 TTL 兜底）
        poke_presence(&handle, false).await;
        handle.exit(0);
    });
}

// ---------- 托盘 ----------

fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "打开网页端", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&show, &hide, &open, &PredefinedMenuItem::separator(app)?, &quit_item],
    )?;
    let mut builder = TrayIconBuilder::with_id("pet-tray").tooltip("大肥鱼").menu(&menu);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "hide" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            "open" => {
                use tauri_plugin_opener::OpenerExt;
                let url = app.state::<AppState>().dsh_url.clone();
                let _ = app.opener().open_url(url, None::<&str>);
            }
            "quit" => quit(app.clone()),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

// ---------- 入口 ----------

pub fn run() {
    let dsh_url = cli_value("--dsh-url")
        .or_else(|| env::var("DSH_URL").ok())
        .unwrap_or_else(|| "http://127.0.0.1:3080".into());
    let dsh_url = normalize_dsh_url(&dsh_url).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(2);
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            dsh_url: dsh_url.clone(),
            client: reqwest::Client::builder()
                // 只限制连接超时；SSE 长连接由 tokio 侧无总超时（见 follow_events）
                .connect_timeout(std::time::Duration::from_secs(5))
                .build()
                .expect("reqwest client"),
            quitting: AtomicBool::new(false),
            drag_origin: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            manifest,
            config,
            sessions,
            refresh,
            interact,
            drag_start,
            drag_move,
            drag_end,
            walk_move,
            resize_to_content,
            quit
        ])
        .setup(|app| {
            // 窗口由 tauri.conf.json 创建；setup 阶段窗口可能未就绪，稍后恢复位置。
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                if let Some((x, y)) = load_position(&handle) {
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.set_position(PhysicalPosition::new(x, y));
                    }
                }
            });
            let _ = create_tray(app);
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(connection_loop(handle.clone()));
            tauri::async_runtime::spawn(presence_loop(handle));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Ctrl+W / Alt+F4 / WM 关闭一律不允许——宠物只能经托盘「退出」或
                // 窗口内的退出按钮（quit 命令会先置 quitting 再 exit）。
                let quitting = window
                    .app_handle()
                    .state::<AppState>()
                    .quitting
                    .load(Ordering::SeqCst);
                if !quitting {
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
