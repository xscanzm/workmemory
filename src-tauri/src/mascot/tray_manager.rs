//! TrayManager：系统托盘管理（对应 electron/mascot/TrayManager.ts）
//!
//! 功能：
//!  - 创建托盘（用纯代码生成 PNG 图标：纯色圆形 + 中心白点）
//!  - 托盘图标颜色随状态变化（绿=recording/黄=paused/紫=privacy/青=ocr_scanning/蓝=report_ready）
//!  - 托盘右键菜单：打开主窗口、暂停/恢复记录、生成日报、设置、退出
//!  - 双击托盘：显示主窗口
//!  - update_icon(state)：更新托盘图标颜色
//!
//! 图标通过纯代码生成 PNG buffer（无外部图片依赖），与 TS 版本一致。

use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, MenuEvent},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};

use crate::models::MascotState;

/// 托盘图标尺寸
const ICON_SIZE: u32 = 16;

/// 状态颜色映射（RGB）
fn state_color(state: &MascotState) -> (u8, u8, u8) {
    match state {
        MascotState::Recording => (34, 181, 106),    // 绿色 #22b56a
        MascotState::Paused => (245, 166, 35),       // 黄色 #f5a623
        MascotState::Privacy => (139, 92, 246),      // 紫色 #8b5cf6
        MascotState::OcrScanning => (34, 197, 216),  // 青色 #22c5d8
        MascotState::ReportReady => (43, 127, 255),  // 蓝色 #2b7fff
        MascotState::Focused => (34, 181, 106),      // 与 recording 同色
    }
}

/// TrayManager：系统托盘管理器。
///
/// 通过 Tauri `TrayIconBuilder` 创建托盘，图标由纯代码生成 PNG。
pub struct TrayManager {
    /// AppHandle 用于创建托盘与菜单
    app: AppHandle,
    /// 当前状态
    current_state: Mutex<MascotState>,
    /// 托盘是否已创建
    created: Mutex<bool>,
}

impl TrayManager {
    /// 创建 TrayManager 实例（不立即创建托盘）
    pub fn new(app: &AppHandle) -> Self {
        Self {
            app: app.clone(),
            current_state: Mutex::new(MascotState::Recording),
            created: Mutex::new(false),
        }
    }

    /// 创建并配置系统托盘（setup 钩子调用入口）
    pub fn setup(&mut self) {
        self.create();
    }

    /// 创建系统托盘
    pub fn create(&mut self) {
        let mut created = self.created.lock().unwrap();
        if *created {
            return;
        }
        let state = self.current_state.lock().unwrap().clone();
        let png = create_circle_png(ICON_SIZE, ICON_SIZE, state_color(&state));

        let icon = match tauri::image::Image::from_bytes(&png) {
            Ok(img) => img,
            Err(e) => {
                log::warn!("[TrayManager] 创建图标失败: {}", e);
                return;
            }
        };

        let result = TrayIconBuilder::<Wry>::new()
            .icon(icon)
            .tooltip("WorkMemory 今日记忆")
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } = event
                {
                    let app = tray.app_handle();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            })
            .on_menu_event(|app, event: MenuEvent| {
                handle_menu_event(app, event.id().as_ref());
            })
            .build(&self.app);

        match result {
            Ok(_) => {
                *created = true;
                // 创建后立即更新右键菜单
                drop(created);
                self.update_context_menu();
            }
            Err(e) => {
                log::warn!("[TrayManager] 创建托盘失败: {}", e);
            }
        }
    }

    /// 更新托盘图标颜色
    pub fn update_icon(&self, state: MascotState) {
        {
            let mut current = self.current_state.lock().unwrap();
            *current = state.clone();
        }
        let png = create_circle_png(ICON_SIZE, ICON_SIZE, state_color(&state));
        let icon = match tauri::image::Image::from_bytes(&png) {
            Ok(img) => img,
            Err(e) => {
                log::warn!("[TrayManager] 更新图标失败: {}", e);
                return;
            }
        };
        if let Some(tray) = self.app.tray_by_id("main-tray") {
            let _ = tray.set_icon(Some(icon));
        }
    }

    /// 更新右键菜单
    pub fn update_context_menu(&self) {
        let menu = match build_context_menu(&self.app) {
            Ok(m) => m,
            Err(e) => {
                log::warn!("[TrayManager] 构建菜单失败: {}", e);
                return;
            }
        };
        if let Some(tray) = self.app.tray_by_id("main-tray") {
            let _ = tray.set_menu(Some(menu));
        }
    }

    /// 显示主窗口
    pub fn show_main_window(&self) {
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    /// 销毁托盘
    pub fn destroy(&self) {
        // Tauri 2 的 TrayIcon 无 destroy 方法，通过移除托盘 ID 实现
        if let Some(tray) = self.app.tray_by_id("main-tray") {
            let _ = tray.set_visible(false);
        }
        let mut created = self.created.lock().unwrap();
        *created = false;
    }

    /// 当前是否已创建托盘
    pub fn is_created(&self) -> bool {
        *self.created.lock().unwrap()
    }
}

/// 处理托盘菜单事件
fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "open_main" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        "toggle_pause" => {
            // 真实场景下调用 CaptureManager.pause/resume
            log::info!("[TrayManager] 切换暂停/恢复记录");
        }
        "generate_report" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.emit("mascot:navigate-main", "reports");
            }
        }
        "settings" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.emit("mascot:navigate-main", "settings");
            }
        }
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

use tauri::Emitter;

/// 构建托盘右键菜单
fn build_context_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let open_main = MenuItem::with_id(app, "open_main", "打开主窗口", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let toggle_pause = MenuItem::with_id(app, "toggle_pause", "暂停/恢复记录", true, None::<&str>)?;
    let generate_report = MenuItem::with_id(app, "generate_report", "生成今日日报", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[&open_main, &sep1, &toggle_pause, &generate_report, &sep2, &settings, &sep3, &quit],
    )
}

// ===================== PNG 图标生成（纯代码） =====================

/// 生成圆形图标的 PNG bytes。
/// 中心为白色小点，外围为状态颜色圆，背景透明。
pub fn create_circle_png(width: u32, height: u32, color: (u8, u8, u8)) -> Vec<u8> {
    let (r, g, b) = color;
    let center_x = width as f64 / 2.0;
    let center_y = height as f64 / 2.0;
    let outer_radius = (width.min(height) as f64 / 2.0) - 1.0;
    let dot_radius = (1.5_f64).max(outer_radius * 0.3);

    let get_pixel = |x: u32, y: u32| -> (u8, u8, u8, u8) {
        let dx = x as f64 - center_x + 0.5;
        let dy = y as f64 - center_y + 0.5;
        let dist = (dx * dx + dy * dy).sqrt();

        if dist <= dot_radius {
            // 中心白点
            (255, 255, 255, 255)
        } else if dist <= outer_radius {
            // 状态颜色圆，边缘抗锯齿
            let edge_alpha = if dist > outer_radius - 1.0 {
                outer_radius - dist
            } else {
                1.0
            };
            let alpha = (255.0 * edge_alpha.max(0.0).min(1.0)).round() as u8;
            (r, g, b, alpha)
        } else {
            // 透明背景
            (0, 0, 0, 0)
        }
    };

    encode_png(width, height, get_pixel)
}

/// 最小 PNG 编码器：生成 RGBA 8-bit PNG。
fn encode_png<F>(width: u32, height: u32, get_pixel: F) -> Vec<u8>
where
    F: Fn(u32, u32) -> (u8, u8, u8, u8),
{
    // PNG 签名
    let mut result = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    // IHDR
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.push(8); // bit depth
    ihdr.push(6); // color type: RGBA
    ihdr.push(0); // compression method
    ihdr.push(0); // filter method
    ihdr.push(0); // interlace method
    append_chunk(&mut result, b"IHDR", &ihdr);

    // 原始像素数据（每行前加 filter type 字节 0 = none）
    let row_size = 1 + (width as usize) * 4;
    let mut raw_data = Vec::with_capacity((height as usize) * row_size);
    for y in 0..height {
        raw_data.push(0u8); // filter type: none
        for x in 0..width {
            let (r, g, b, a) = get_pixel(x, y);
            raw_data.push(r);
            raw_data.push(g);
            raw_data.push(b);
            raw_data.push(a);
        }
    }

    // zlib 弩缩（使用 flate2 替代；此处用简单存储式 deflate 兼容实现）
    let compressed = zlib_compress(&raw_data);
    append_chunk(&mut result, b"IDAT", &compressed);

    // IEND
    append_chunk(&mut result, b"IEND", &[]);

    result
}

/// 追加 PNG chunk（length + type + data + crc32）
fn append_chunk(buf: &mut Vec<u8>, chunk_type: &[u8; 4], data: &[u8]) {
    buf.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let type_data_start = buf.len();
    buf.extend_from_slice(chunk_type);
    buf.extend_from_slice(data);
    let crc = crc32(&buf[type_data_start..]);
    buf.extend_from_slice(&crc.to_be_bytes());
}

/// CRC32 计算（PNG 标准，多项式 0xedb88320）
fn crc32(data: &[u8]) -> u32 {
    let table = crc32_table();
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc = table[((crc ^ byte as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

/// CRC32 查找表
fn crc32_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    for n in 0..256u32 {
        let mut c = n;
        for _ in 0..8 {
            if c & 1 != 0 {
                c = 0xEDB8_8320 ^ (c >> 1);
            } else {
                c >>= 1;
            }
        }
        table[n as usize] = c;
    }
    table
}

/// 简单 zlib 压缩（使用 stored block，无实际压缩但符合 zlib 格式）。
/// 生产环境可替换为 flate2；此处保持零依赖。
fn zlib_compress(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 11);
    // zlib 头：CM=8, CINFO=7, FCHECK 使 (CMF*256 + FLG) % 31 == 0
    out.push(0x78);
    out.push(0x01);

    // stored block（无压缩）
    let mut offset = 0;
    while offset < data.len() {
        let remaining = data.len() - offset;
        let block_len = remaining.min(65535) as u16;
        let is_final = remaining <= 65535;
        out.push(if is_final { 0x01 } else { 0x00 }); // BFINAL=1, BTYPE=00 (stored)
        out.extend_from_slice(&block_len.to_le_bytes());
        out.extend_from_slice(&(!block_len).to_le_bytes());
        out.extend_from_slice(&data[offset..offset + block_len as usize]);
        offset += block_len as usize;
    }

    // adler32 校验
    let adler = adler32(data);
    out.extend_from_slice(&adler.to_be_bytes());
    out
}

/// Adler32 校验和
fn adler32(data: &[u8]) -> u32 {
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for &byte in data {
        a = (a + byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_state_color_mapping() {
        // 验证各状态颜色映射
        assert_eq!(state_color(&MascotState::Recording), (34, 181, 106));
        assert_eq!(state_color(&MascotState::Paused), (245, 166, 35));
        assert_eq!(state_color(&MascotState::Privacy), (139, 92, 246));
        assert_eq!(state_color(&MascotState::OcrScanning), (34, 197, 216));
        assert_eq!(state_color(&MascotState::ReportReady), (43, 127, 255));
        // Focused 复用 recording 颜色
        assert_eq!(state_color(&MascotState::Focused), (34, 181, 106));
    }

    #[test]
    fn test_create_circle_png_valid_header() {
        // 生成的 PNG 应包含正确的签名
        let png = create_circle_png(16, 16, (34, 181, 106));
        assert_eq!(&png[0..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        // IHDR chunk 应紧跟签名
        assert_eq!(&png[12..16], b"IHDR");
        // IEND chunk 应存在
        assert!(png.windows(4).any(|w| w == b"IEND"));
    }

    #[test]
    fn test_crc32_known_value() {
        // CRC32("123456789") == 0xCBF43926
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn test_adler32_known_value() {
        // Adler32("Wikipedia") == 0x11E60398
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
    }

    #[test]
    fn test_zlib_compress_header() {
        // zlib 头应为 0x78 0x01（低压缩级别）
        let compressed = zlib_compress(b"hello world");
        assert_eq!(compressed[0], 0x78);
        // 第二字节低 5 位为 FCHECK，使 (CMF*256 + FLG) % 31 == 0
        let cmf = compressed[0] as u32;
        let flg = compressed[1] as u32;
        assert_eq!((cmf * 256 + flg) % 31, 0);
    }
}
