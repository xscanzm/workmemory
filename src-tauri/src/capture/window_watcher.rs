/**
 * WindowWatcher：活跃窗口监听器（Rust 实现）
 *
 * 通过 `windows` crate 调用 Win32 API 轮询前台窗口，
 * 检测窗口切换 / 标题改变 / 滚动停止推断 / 关键帧（5 分钟）。
 *
 * 架构：
 *  - Win32WindowInfoProvider：真实 Windows 实现（windows crate FFI）
 *  - StubWindowInfoProvider：非 Windows 环境降级（仅日志警告，不伪造数据）
 *
 * 事件通过 `tokio::sync::mpsc` 推送，供 CaptureManager 等下游消费。
 *
 * 硬约束：本模块仅监听窗口句柄切换与标题变化，绝不监听键盘/鼠标硬件输入。
 */
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

// ===================== WindowInfo =====================

/// 前台窗口信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInfo {
    /// 窗口句柄（Windows HWND 数值；非 Windows 环境为 0）
    #[serde(default)]
    pub hwnd: u64,
    /// 进程名，如 chrome.exe
    #[serde(default)]
    pub process_name: String,
    /// 进程可执行文件完整路径
    #[serde(default)]
    pub process_path: String,
    /// 窗口标题
    #[serde(default)]
    pub window_title: String,
    /// 应用名（进程名去除扩展名）
    #[serde(default)]
    pub app_name: String,
}

// ===================== WindowEvent =====================

/// WindowWatcher 推送的事件类型
#[derive(Debug, Clone)]
pub enum WindowEvent {
    /// 窗口切换（hwnd 或进程变化）
    WindowChange(WindowInfo),
    /// 同一窗口标题变化
    TitleChange(WindowInfo),
    /// 页面滚动停止推断（标题稳定 2 秒）
    ScrollStop(WindowInfo),
    /// 关键帧（同一窗口标题持续 5 分钟）
    Keyframe(WindowInfo),
}

// ===================== WindowInfoProvider trait =====================

/// 窗口信息提供者抽象接口
pub trait WindowInfoProvider: Send + Sync {
    /// 提供者是否可用（真实 Windows API 已加载）
    fn is_available(&self) -> bool;
    /// 获取当前前台窗口信息；不可用时返回 None（不伪造）
    fn get_active_window(&self) -> Option<WindowInfo>;
}

// ===================== Win32 实现 =====================

#[cfg(target_os = "windows")]
mod win32 {
    use super::WindowInfo;
    use std::path::Path;
    use windows::Win32::Foundation::{BOOL, HANDLE, PWSTR};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, HWND,
    };

    /// Windows 进程查询权限标志
    const PROCESS_QUERY_LIMITED: u32 = PROCESS_QUERY_LIMITED_INFORMATION.0;

    /// 通过 windows crate 调用 Win32 API 获取前台窗口信息。
    /// 调用链：GetForegroundWindow → GetWindowTextW → GetWindowThreadProcessId →
    ///         OpenProcess → QueryFullProcessImageNameW → CloseHandle
    pub fn get_active_window() -> Option<WindowInfo> {
        unsafe {
            // 1. 获取前台窗口句柄
            let hwnd: HWND = GetForegroundWindow();
            if hwnd.0 == 0 {
                return None;
            }

            // 2. 获取窗口标题
            let window_title = get_window_text(hwnd);

            // 3. 获取进程 ID
            let pid = get_process_id(hwnd);

            // 4. 查询进程路径
            let process_path = query_process_path(pid);
            let process_name = if process_path.is_empty() {
                String::new()
            } else {
                Path::new(&process_path)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
            };
            let app_name = if process_name.is_empty() {
                String::new()
            } else {
                // 去除扩展名
                match process_name.rfind('.') {
                    Some(pos) => process_name[..pos].to_string(),
                    None => process_name.clone(),
                }
            };

            Some(WindowInfo {
                hwnd: hwnd.0 as u64,
                process_name,
                process_path,
                window_title,
                app_name,
            })
        }
    }

    /// 获取窗口标题文本
    unsafe fn get_window_text(hwnd: HWND) -> String {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let buf_size = (len + 1) as usize;
        let mut buf = vec![0u16; buf_size];
        let copied = GetWindowTextW(hwnd, &mut buf);
        if copied <= 0 {
            return String::new();
        }
        // copied 是实际拷贝的字符数（不含 null terminator）
        let actual_len = copied as usize;
        String::from_utf16_lossy(&buf[..actual_len])
    }

    /// 获取窗口所属进程 ID
    unsafe fn get_process_id(hwnd: HWND) -> u32 {
        let mut pid: u32 = 0;
        let _thread_id = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        pid
    }

    /// 查询进程可执行文件完整路径
    unsafe fn query_process_path(pid: u32) -> String {
        if pid == 0 {
            return String::new();
        }
        let h_process = match OpenProcess(
            windows::Win32::System::Threading::PROCESS_ACCESS_RIGHTS(PROCESS_QUERY_LIMITED),
            BOOL(0),
            pid,
        ) {
            Ok(h) => h,
            Err(_) => return String::new(),
        };
        // 确保 handle 被关闭
        let result = query_process_path_inner(h_process);
        let _ = windows::Win32::Foundation::CloseHandle(h_process);
        result
    }

    unsafe fn query_process_path_inner(h_process: HANDLE) -> String {
        let mut buf = vec![0u16; 1024];
        let mut size: u32 = buf.len() as u32;
        let pwstr = PWSTR(buf.as_mut_ptr());
        let ok = QueryFullProcessImageNameW(h_process, 0, pwstr, &mut size);
        if ok.is_err() || size == 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..size as usize])
    }
}

// ===================== Win32WindowInfoProvider =====================

/// Win32 窗口信息提供者（仅 Windows 平台可用）
#[cfg(target_os = "windows")]
pub struct Win32WindowInfoProvider {
    available: bool,
}

#[cfg(target_os = "windows")]
impl Win32WindowInfoProvider {
    pub fn new() -> Self {
        // windows crate 在编译时链接，运行时始终可用
        Self { available: true }
    }
}

#[cfg(target_os = "windows")]
impl WindowInfoProvider for Win32WindowInfoProvider {
    fn is_available(&self) -> bool {
        self.available
    }

    fn get_active_window(&self) -> Option<WindowInfo> {
        if !self.available {
            return None;
        }
        win32::get_active_window()
    }
}

// ===================== StubWindowInfoProvider（非 Windows 降级） =====================

/// 非 Windows 环境降级提供者。
/// 不伪造任何窗口数据，get_active_window 始终返回 None。
/// 这不是 mock——真实 Windows 上会使用 Win32WindowInfoProvider。
pub struct StubWindowInfoProvider {
    warned: std::sync::atomic::AtomicBool,
}

impl StubWindowInfoProvider {
    pub fn new() -> Self {
        Self {
            warned: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

impl Default for StubWindowInfoProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowInfoProvider for StubWindowInfoProvider {
    fn is_available(&self) -> bool {
        false
    }

    fn get_active_window(&self) -> Option<WindowInfo> {
        if !self.warned.swap(true, std::sync::atomic::Ordering::Relaxed) {
            log::warn!(
                "[StubWindowInfoProvider] 当前环境无 Windows API 支持，窗口监听处于降级模式，不会产生任何窗口事件或片段。"
            );
        }
        None
    }
}

// ===================== 提供者工厂 =====================

/// 根据运行环境选择窗口信息提供者。
/// Windows 上使用 Win32WindowInfoProvider；其他平台使用 Stub。
pub fn create_window_info_provider() -> Box<dyn WindowInfoProvider> {
    #[cfg(target_os = "windows")]
    {
        let win32 = Win32WindowInfoProvider::new();
        if win32.is_available() {
            return Box::new(win32);
        }
        log::warn!("[WindowWatcher] Win32WindowInfoProvider 不可用，降级到 StubWindowInfoProvider");
        return Box::new(StubWindowInfoProvider::new());
    }
    #[cfg(not(target_os = "windows"))]
    {
        log::warn!(
            "[WindowWatcher] 当前平台非 Windows，使用 StubWindowInfoProvider 降级模式"
        );
        Box::new(StubWindowInfoProvider::new())
    }
}

// ===================== WindowWatcher =====================

/// 轮询间隔（毫秒）— spec T2.3.3 要求 2 秒
const POLL_INTERVAL_MS: u64 = 2000;
/// 标题稳定判定时长（毫秒），用于推断滚动停止
const TITLE_STABLE_MS: u64 = 2000;
/// 关键帧触发时长（毫秒），同一标题持续 5 分钟
const KEYFRAME_MS: u64 = 5 * 60 * 1000;

/// WindowWatcher：轮询前台窗口，检测变化并通过 mpsc 推送事件。
///
/// 事件：
///  - WindowChange：窗口切换（hwnd 或进程名变化）
///  - TitleChange：同一窗口标题变化
///  - ScrollStop：标题稳定 2 秒后推断页面滚动停止
///  - Keyframe：同一窗口标题持续 5 分钟触发关键帧
pub struct WindowWatcher {
    provider: Box<dyn WindowInfoProvider>,
    /// 事件接收端（消费者持有）；start 时创建
    rx: Option<mpsc::Receiver<WindowEvent>>,
    /// 轮询任务句柄
    poll_handle: Option<JoinHandle<()>>,
    /// 最近一次窗口信息（供 get_last_window_info 同步查询）
    last_window_info: std::sync::Arc<tokio::sync::Mutex<Option<WindowInfo>>>,
}

impl WindowWatcher {
    /// 创建 WindowWatcher，使用默认提供者工厂
    pub fn new() -> Self {
        Self::with_provider(create_window_info_provider())
    }

    /// 创建 WindowWatcher，使用指定提供者
    pub fn with_provider(provider: Box<dyn WindowInfoProvider>) -> Self {
        Self {
            provider,
            rx: None,
            poll_handle: None,
            last_window_info: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    /// 提供者是否可用
    pub fn is_provider_available(&self) -> bool {
        self.provider.is_available()
    }

    /// 启动轮询，返回事件接收端
    ///
    /// 内部 `tokio::spawn` 异步循环，每 POLL_INTERVAL_MS 轮询一次。
    /// 检测到窗口切换/标题变化/滚动停止/关键帧时通过 mpsc 发送事件。
    pub fn start(&mut self) -> mpsc::Receiver<WindowEvent> {
        if self.poll_handle.is_some() {
            // 已启动，返回现有接收端（如有）
            return self.rx.take().expect("WindowWatcher 已启动但无接收端");
        }

        if !self.provider.is_available() {
            log::warn!("[WindowWatcher] 提供者不可用，轮询不会产生事件");
        }

        let (tx, rx) = mpsc::channel::<WindowEvent>(64);
        self.rx = Some(rx);

        // 克隆共享状态供异步任务使用
        let last_info = self.last_window_info.clone();
        let provider_available = self.provider.is_available();

        // 将 provider 装箱发送到异步任务中
        // 由于 provider 是 Box<dyn WindowInfoProvider + Send + Sync>，可以安全移动
        let provider = std::mem::replace(
            &mut self.provider,
            Box::new(StubWindowInfoProvider::new()),
        );

        self.poll_handle = Some(tokio::spawn(async move {
            let mut state = PollState::new();
            // 使用 Pin<Box<Sleep>> 使 Sleep 可跨 await 持有（Sleep 非 Unpin）
            let mut title_stable_timer: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
            let mut keyframe_timer: Option<std::pin::Pin<Box<tokio::time::Sleep>>> =
                Some(Box::pin(tokio::time::sleep(Duration::from_millis(KEYFRAME_MS))));

            let mut interval =
                tokio::time::interval(Duration::from_millis(POLL_INTERVAL_MS));
            interval.tick().await; // 首次立即触发

            loop {
                // 等待下一个轮询周期或计时器到期
                tokio::select! {
                    _ = interval.tick() => {
                        if !provider_available {
                            continue;
                        }
                        let info = match provider.as_ref().get_active_window() {
                            Some(i) => i,
                            None => continue,
                        };
                        // 更新共享状态
                        {
                            let mut guard = last_info.lock().await;
                            *guard = Some(info.clone());
                        }
                        // 处理窗口信息，生成事件
                        let events = state.handle_window_info(&info);
                        for event in events {
                            if tx.send(event).await.is_err() {
                                // 接收端关闭，停止轮询
                                return;
                            }
                        }
                        // 标题变化或窗口切换时重置稳定计时器
                        if state.last_event_was_change {
                            title_stable_timer = Some(Box::pin(tokio::time::sleep(Duration::from_millis(TITLE_STABLE_MS))));
                        }
                    }
                    _ = async {
                        if let Some(t) = title_stable_timer.as_mut() {
                            t.as_mut().await;
                        } else {
                            // 永不完成，让 select 优先走 interval
                            std::future::pending::<()>().await;
                        }
                    } => {
                        // 标题稳定 TITLE_STABLE_MS，推断滚动停止
                        if let Some(info) = state.current_info() {
                            if tx.send(WindowEvent::ScrollStop(info.clone())).await.is_err() {
                                return;
                            }
                        }
                        title_stable_timer = None;
                    }
                    _ = async {
                        if let Some(t) = keyframe_timer.as_mut() {
                            t.as_mut().await;
                        } else {
                            std::future::pending::<()>().await;
                        }
                    } => {
                        // 同一窗口标题持续 KEYFRAME_MS，触发关键帧
                        if let Some(info) = state.current_info() {
                            if tx.send(WindowEvent::Keyframe(info.clone())).await.is_err() {
                                return;
                            }
                        }
                        // 重置以支持后续周期性关键帧
                        keyframe_timer = Some(Box::pin(tokio::time::sleep(Duration::from_millis(KEYFRAME_MS))));
                    }
                }
            }
        }));

        // 取回 rx 返回给调用者
        self.rx.take().expect("rx 应已创建")
    }

    /// 停止轮询并清理任务
    pub fn stop(&mut self) {
        if let Some(handle) = self.poll_handle.take() {
            handle.abort();
        }
        self.rx = None;
    }

    /// 获取最近一次窗口信息（异步）
    pub async fn get_last_window_info(&self) -> Option<WindowInfo> {
        self.last_window_info.lock().await.clone()
    }

    /// 立即读取一次当前活动窗口快照（不依赖轮询事件）
    pub fn get_active_window_snapshot(&self) -> Option<WindowInfo> {
        self.provider.get_active_window()
    }
}

impl Default for WindowWatcher {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for WindowWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

// ===================== PollState =====================

/// 轮询内部状态
struct PollState {
    last_window_info: Option<WindowInfo>,
    /// 标记本次轮询是否触发了窗口切换或标题变化
    last_event_was_change: bool,
}

impl PollState {
    fn new() -> Self {
        Self {
            last_window_info: None,
            last_event_was_change: false,
        }
    }

    fn current_info(&self) -> Option<&WindowInfo> {
        self.last_window_info.as_ref()
    }

    /// 处理窗口信息，返回需要发送的事件列表
    fn handle_window_info(&mut self, info: &WindowInfo) -> Vec<WindowEvent> {
        let mut events = Vec::new();
        let prev = self.last_window_info.take();

        match &prev {
            None => {
                // 首次获取
                self.last_event_was_change = true;
            }
            Some(prev) => {
                if prev.hwnd != info.hwnd || prev.process_name != info.process_name {
                    // 窗口切换
                    events.push(WindowEvent::WindowChange(info.clone()));
                    self.last_event_was_change = true;
                } else if prev.window_title != info.window_title {
                    // 同一窗口标题变化
                    events.push(WindowEvent::TitleChange(info.clone()));
                    self.last_event_was_change = true;
                } else {
                    // 标题未变化
                    self.last_event_was_change = false;
                }
            }
        }

        self.last_window_info = Some(info.clone());
        events
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试 StubWindowInfoProvider 始终返回 None
    #[tokio::test]
    async fn test_stub_provider_returns_none() {
        let stub = StubWindowInfoProvider::new();
        assert!(!stub.is_available());
        assert!(stub.get_active_window().is_none());
    }

    /// 测试 PollState 首次获取不产生事件
    #[test]
    fn test_poll_state_first_info_no_event() {
        let mut state = PollState::new();
        let info = WindowInfo {
            hwnd: 100,
            process_name: "chrome.exe".to_string(),
            process_path: "C:\\chrome.exe".to_string(),
            window_title: "Google".to_string(),
            app_name: "chrome".to_string(),
        };
        let events = state.handle_window_info(&info);
        assert!(events.is_empty());
        assert!(state.last_event_was_change);
    }

    /// 测试 PollState 窗口切换产生 WindowChange 事件
    #[test]
    fn test_poll_state_window_change() {
        let mut state = PollState::new();
        let info1 = WindowInfo {
            hwnd: 100,
            process_name: "chrome.exe".to_string(),
            process_path: "C:\\chrome.exe".to_string(),
            window_title: "Google".to_string(),
            app_name: "chrome".to_string(),
        };
        let info2 = WindowInfo {
            hwnd: 200,
            process_name: "code.exe".to_string(),
            process_path: "C:\\code.exe".to_string(),
            window_title: "main.rs".to_string(),
            app_name: "code".to_string(),
        };
        state.handle_window_info(&info1);
        let events = state.handle_window_info(&info2);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WindowEvent::WindowChange(i) => assert_eq!(i.hwnd, 200),
            _ => panic!("期望 WindowChange 事件"),
        }
    }

    /// 测试 PollState 标题变化产生 TitleChange 事件
    #[test]
    fn test_poll_state_title_change() {
        let mut state = PollState::new();
        let info1 = WindowInfo {
            hwnd: 100,
            process_name: "chrome.exe".to_string(),
            process_path: "C:\\chrome.exe".to_string(),
            window_title: "Google".to_string(),
            app_name: "chrome".to_string(),
        };
        let info2 = WindowInfo {
            hwnd: 100,
            process_name: "chrome.exe".to_string(),
            process_path: "C:\\chrome.exe".to_string(),
            window_title: "GitHub".to_string(),
            app_name: "chrome".to_string(),
        };
        state.handle_window_info(&info1);
        let events = state.handle_window_info(&info2);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WindowEvent::TitleChange(i) => assert_eq!(i.window_title, "GitHub"),
            _ => panic!("期望 TitleChange 事件"),
        }
    }

    /// 测试 PollState 标题未变化不产生事件
    #[test]
    fn test_poll_state_no_change_no_event() {
        let mut state = PollState::new();
        let info = WindowInfo {
            hwnd: 100,
            process_name: "chrome.exe".to_string(),
            process_path: "C:\\chrome.exe".to_string(),
            window_title: "Google".to_string(),
            app_name: "chrome".to_string(),
        };
        state.handle_window_info(&info);
        let events = state.handle_window_info(&info);
        assert!(events.is_empty());
        assert!(!state.last_event_was_change);
    }

    /// 测试 WindowWatcher start/stop 生命周期（Stub 模式）
    #[tokio::test]
    async fn test_window_watcher_start_stop_stub() {
        let mut watcher = WindowWatcher::with_provider(Box::new(StubWindowInfoProvider::new()));
        let mut rx = watcher.start();
        // Stub 模式不会产生事件，短暂等待后停止
        tokio::time::sleep(Duration::from_millis(100)).await;
        watcher.stop();
        // 确保接收端已分离
        drop(rx);
    }
}
