/**
 * Screenshot：屏幕截图采集 + 感知哈希（dHash）— Rust 实现
 *
 * 截图能力：
 *  - capture_window(hwnd)：通过 Win32 GDI 截取指定窗口
 *  - capture_screen()：截取整屏（仅供显式整屏降级调用，不自动触发）
 *  - capture_active_window(hwnd)：截取指定前台窗口，返回 ScreenshotResult
 *
 * 截图降级策略（V0.4 Trust & Beauty）：
 *  - capture_active_window 找不到目标窗口时返回 Failed { reason: WindowNotFound }，
 *    绝不自动调用 capture_screen()。
 *  - 整屏降级需由调用方（CaptureDecision）在用户显式开启 allowFullScreenshotFallback
 *    时主动调用 capture_screen()，并在结果中携带 display_bounds 以明确多屏范围。
 *
 * 临时/持久截图管理：
 *  - save_temp_screenshot(buffer)：保存到系统临时目录，OCR 后由调用方删除
 *  - delete_temp_screenshot(path)：删除临时截图
 *  - save_screenshot(buffer, date, segment_id)：按设置保存到 app_data/screenshots/YYYY-MM-DD/
 *  - clean_expired_screenshots(max_days)：清理过期截图
 *
 * 感知哈希（dHash，基于 image crate）：
 *  - calculate_image_hash(buffer)：8x8 dHash，缩放到 9x8 灰度，比较相邻像素得 64bit 字符串
 *  - hamming_distance(hash1, hash2)：汉明距离
 *  - is_similar(hash1, hash2, threshold)：相似度判定
 */
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::repositories::settings_store::APP_DATA_DIR;

// ===================== 类型定义 =====================

/// 屏幕范围（display bounds），整屏降级时记录以明确多屏范围
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// 截图来源：窗口截图或整屏降级截图
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScreenshotSource {
    Window,
    Screen,
}

/// 截图失败原因
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScreenshotFailureReason {
    WindowNotFound,
    CaptureError,
    EmptyImage,
}

/// 截图结果（判别枚举）：成功携带画面，失败携带原因
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ScreenshotResult {
    Ok {
        buffer: Vec<u8>,
        width: u32,
        height: u32,
        source: ScreenshotSource,
        /// 屏幕范围，仅整屏降级（source='screen'）时携带
        #[serde(skip_serializing_if = "Option::is_none")]
        display_bounds: Option<DisplayBounds>,
    },
    Failed {
        reason: ScreenshotFailureReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

// ===================== 常量 =====================

/// 临时截图目录名
const TEMP_DIR_NAME: &str = "workmemory-screenshots";
/// dHash 宽度（9 列，比较 8 对相邻像素）
const DHASH_WIDTH: u32 = 9;
/// dHash 高度（8 行）
const DHASH_HEIGHT: u32 = 8;
/// 默认相似度阈值
const DEFAULT_SIMILARITY_THRESHOLD: usize = 10;

// ===================== Win32 GDI 截图实现 =====================

#[cfg(target_os = "windows")]
mod win32_capture {
    use super::{DisplayBounds, ScreenshotFailureReason, ScreenshotResult, ScreenshotSource};
    use image::{ImageBuffer, Rgba, RgbaImage};
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, GetSystemMetrics, GetWindowDC, GetWindowRect, SelectObject, SetProcessDPIAware,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::SM_CXSCREEN;

    /// 截取指定窗口区域
    pub fn capture_window(hwnd_val: u64) -> ScreenshotResult {
        if hwnd_val == 0 {
            return ScreenshotResult::Failed {
                reason: ScreenshotFailureReason::WindowNotFound,
                error: None,
            };
        }
        let hwnd = HWND(hwnd_val as *mut _);
        unsafe {
            // 尝试启用 DPI 感知，避免高 DPI 下截图像素不足
            let _ = SetProcessDPIAware();

            // 获取窗口矩形
            let mut rect: RECT = std::mem::zeroed();
            if GetWindowRect(hwnd, &mut rect).is_err() {
                return ScreenshotResult::Failed {
                    reason: ScreenshotFailureReason::WindowNotFound,
                    error: None,
                };
            }
            let width = (rect.right - rect.left).max(1);
            let height = (rect.bottom - rect.top).max(1);
            if width <= 0 || height <= 0 {
                return ScreenshotResult::Failed {
                    reason: ScreenshotFailureReason::EmptyImage,
                    error: Some("窗口尺寸无效".to_string()),
                };
            }

            capture_region(GetWindowDC(hwnd), width, height, ScreenshotSource::Window, None)
        }
    }

    /// 截取整屏
    pub fn capture_screen() -> ScreenshotResult {
        unsafe {
            let _ = SetProcessDPIAware();
            let screen_w = GetSystemMetrics(SM_CXSCREEN);
            let screen_h = GetSystemMetrics(windows::Win32::UI::WindowsAndMessaging::SM_CYSCREEN);
            if screen_w <= 0 || screen_h <= 0 {
                return ScreenshotResult::Failed {
                    reason: ScreenshotFailureReason::CaptureError,
                    error: Some("无法获取屏幕尺寸".to_string()),
                };
            }
            let display_bounds = DisplayBounds {
                x: 0,
                y: 0,
                width: screen_w,
                height: screen_h,
            };
            let hdc = GetDC(HWND(std::ptr::null_mut()));
            capture_region(
                hdc,
                screen_w,
                screen_h,
                ScreenshotSource::Screen,
                Some(display_bounds),
            )
        }
    }

    /// 从指定 DC 截取区域
    unsafe fn capture_region(
        hdc: windows::Win32::Graphics::Gdi::HDC,
        width: i32,
        height: i32,
        source: ScreenshotSource,
        display_bounds: Option<DisplayBounds>,
    ) -> ScreenshotResult {
        if hdc.is_invalid() {
            return ScreenshotResult::Failed {
                reason: ScreenshotFailureReason::CaptureError,
                error: Some("无法获取设备上下文".to_string()),
            };
        }

        let width_u = width as u32;
        let height_u = height as u32;

        // 创建兼容内存 DC
        let mem_dc = match CreateCompatibleDC(hdc) {
            Ok(dc) => dc,
            Err(e) => {
                return ScreenshotResult::Failed {
                    reason: ScreenshotFailureReason::CaptureError,
                    error: Some(format!("CreateCompatibleDC 失败: {}", e)),
                };
            }
        };

        // 创建兼容位图
        let bitmap = match CreateCompatibleBitmap(hdc, width, height) {
            Ok(b) => b,
            Err(e) => {
                let _ = DeleteDC(mem_dc);
                return ScreenshotResult::Failed {
                    reason: ScreenshotFailureReason::CaptureError,
                    error: Some(format!("CreateCompatibleBitmap 失败: {}", e)),
                };
            }
        };

        // 选入内存 DC
        let old_obj = SelectObject(mem_dc, bitmap);

        // BitBlt 拷贝像素
        if BitBlt(
            mem_dc,
            0,
            0,
            width,
            height,
            hdc,
            0,
            0,
            SRCCOPY,
        )
        .is_err()
        {
            let _ = SelectObject(mem_dc, old_obj);
            let _ = DeleteObject(bitmap);
            let _ = DeleteDC(mem_dc);
            return ScreenshotResult::Failed {
                reason: ScreenshotFailureReason::CaptureError,
                error: Some("BitBlt 失败".to_string()),
            };
        }

        // 准备 BITMAPINFO 用于 GetDIBits
        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = width;
        bmi.bmiHeader.biHeight = -height; // 负值 = top-down
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32; // BGRA
        bmi.bmiHeader.biCompression = BI_RGB.0;

        let buf_size = (width_u * height_u * 4) as usize;
        let mut pixels = vec![0u8; buf_size];

        let got = GetDIBits(
            mem_dc,
            bitmap,
            0,
            height_u as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        // 清理 GDI 对象
        let _ = SelectObject(mem_dc, old_obj);
        let _ = DeleteObject(bitmap);
        let _ = DeleteDC(mem_dc);

        if got == 0 {
            return ScreenshotResult::Failed {
                reason: ScreenshotFailureReason::CaptureError,
                error: Some("GetDIBits 返回 0".to_string()),
            };
        }

        // BGRA → RGBA
        for chunk in pixels.chunks_exact_mut(4) {
            let b = chunk[0];
            let r = chunk[2];
            chunk[0] = r;
            chunk[2] = b;
            // alpha 保持不变
        }

        // 构造 ImageBuffer 并编码为 PNG
        let img: RgbaImage = match ImageBuffer::from_raw(width_u, height_u, pixels) {
            Some(img) => img,
            None => {
                return ScreenshotResult::Failed {
                    reason: ScreenshotFailureReason::EmptyImage,
                    error: Some("无法构造 ImageBuffer".to_string()),
                };
            }
        };

        let mut png_buf = Vec::with_capacity((width_u * height_u * 4) as usize);
        if image::DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut png_buf), image::ImageFormat::Png)
            .is_err()
        {
            return ScreenshotResult::Failed {
                reason: ScreenshotFailureReason::CaptureError,
                error: Some("PNG 编码失败".to_string()),
            };
        }

        ScreenshotResult::Ok {
            buffer: png_buf,
            width: width_u,
            height: height_u,
            source,
            display_bounds,
        }
    }
}

// ===================== 非 Windows 降级 =====================

#[cfg(not(target_os = "windows"))]
mod stub_capture {
    use super::{ScreenshotFailureReason, ScreenshotResult};

    pub fn capture_window(_hwnd: u64) -> ScreenshotResult {
        log::warn!("[Screenshot] 非 Windows 环境，capture_window 降级返回失败");
        ScreenshotResult::Failed {
            reason: ScreenshotFailureReason::CaptureError,
            error: Some("非 Windows 环境不支持截图".to_string()),
        }
    }

    pub fn capture_screen() -> ScreenshotResult {
        log::warn!("[Screenshot] 非 Windows 环境，capture_screen 降级返回失败");
        ScreenshotResult::Failed {
            reason: ScreenshotFailureReason::CaptureError,
            error: Some("非 Windows 环境不支持截图".to_string()),
        }
    }
}

// ===================== 公共 API =====================

/// 截取指定窗口区域。
///
/// 失败语义（V0.4 截图降级策略）：
///  - hwnd 为 0 或匹配不到目标窗口 → Failed { reason: WindowNotFound }
///  - 截图为空 → Failed { reason: EmptyImage }
///  - 异常 → Failed { reason: CaptureError, error }
///
/// 本方法绝不自动调用 capture_screen()，整屏降级由调用方显式决策。
pub fn capture_window(hwnd: u64) -> ScreenshotResult {
    // hwnd=0 检查在平台无关层，保证跨平台一致
    if hwnd == 0 {
        return ScreenshotResult::Failed {
            reason: ScreenshotFailureReason::WindowNotFound,
            error: None,
        };
    }
    #[cfg(target_os = "windows")]
    {
        win32_capture::capture_window(hwnd)
    }
    #[cfg(not(target_os = "windows"))]
    {
        stub_capture::capture_window(hwnd)
    }
}

/// 截取整屏。
/// 仅供显式整屏降级调用（CaptureDecision 在 allow_full_screenshot_fallback=true 时主动调用），
/// 不由 capture_active_window 自动触发。
///
/// 成功结果携带 display_bounds，用于多屏范围明确与日志审计。
pub fn capture_screen() -> ScreenshotResult {
    #[cfg(target_os = "windows")]
    {
        win32_capture::capture_screen()
    }
    #[cfg(not(target_os = "windows"))]
    {
        stub_capture::capture_screen()
    }
}

/// 截取指定前台窗口画面（通过 hwnd 匹配）。
/// 找不到目标窗口时返回 Failed { reason: WindowNotFound }，
/// **不**调用 capture_screen()——整屏降级需由调用方在用户显式开启后主动决策。
pub fn capture_active_window(hwnd: u64) -> ScreenshotResult {
    capture_window(hwnd)
}

// ===================== 临时/持久截图管理 =====================

/// 保存临时截图到系统临时目录。返回文件绝对路径。
/// OCR 完成后由调用方调用 delete_temp_screenshot 删除。
pub fn save_temp_screenshot(buffer: &[u8]) -> PathBuf {
    let temp_dir = std::env::temp_dir().join(TEMP_DIR_NAME);
    ensure_dir(&temp_dir);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let random: u32 = rand_u32();
    let file_name = format!("screenshot-{}-{:x}.png", timestamp, random);
    let file_path = temp_dir.join(file_name);
    if fs::write(&file_path, buffer).is_err() {
        log::warn!("[Screenshot] 保存临时截图失败: {:?}", file_path);
    }
    file_path
}

/// 删除临时截图文件。文件不存在时静默忽略。
pub fn delete_temp_screenshot(file_path: &Path) {
    if let Err(e) = fs::remove_file(file_path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::warn!("[Screenshot] 删除临时截图失败: {:?}: {}", file_path, e);
        }
    }
}

/// 按设置保存截图到 app_data/screenshots/YYYY-MM-DD/。
/// 返回保存路径；保存失败返回 None。
pub fn save_screenshot(buffer: &[u8], date: &str, segment_id: &str) -> Option<PathBuf> {
    let app_data = APP_DATA_DIR
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_else(|| {
            log::warn!("[Screenshot] APP_DATA_DIR 未初始化，使用 fallback");
            std::env::temp_dir()
        });
    let dir = app_data.join("screenshots").join(date);
    ensure_dir(&dir);
    let file_name = format!("{}.png", segment_id);
    let file_path = dir.join(file_name);
    match fs::write(&file_path, buffer) {
        Ok(_) => Some(file_path),
        Err(e) => {
            log::warn!("[Screenshot] save_screenshot 失败: {}", e);
            None
        }
    }
}

/// 清理过期截图。删除早于 max_days 天的 screenshots/YYYY-MM-DD/ 目录。
pub fn clean_expired_screenshots(max_days: u32) {
    if max_days == 0 {
        return;
    }
    let app_data = match APP_DATA_DIR.lock() {
        Ok(guard) => match guard.clone() {
            Some(p) => p,
            None => return,
        },
        Err(_) => return,
    };
    let root = app_data.join("screenshots");
    if !root.exists() {
        return;
    }
    let cutoff_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        - (max_days as u128 * 24 * 60 * 60 * 1000);

    let entries = match fs::read_dir(&root) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("[Screenshot] clean_expired_screenshots 读取目录失败: {}", e);
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // 从目录名解析日期 YYYY-MM-DD
        let dir_name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if let Some(dir_time_ms) = parse_date_to_millis(dir_name) {
            if dir_time_ms < cutoff_ms {
                if let Err(e) = fs::remove_dir_all(&path) {
                    log::warn!(
                        "[Screenshot] clean_expired_screenshots 删除目录失败 {:?}: {}",
                        path,
                        e
                    );
                }
            }
        }
    }
}

// ===================== dHash 感知哈希 =====================

/// 计算图像的 dHash（difference hash）。
///
/// 算法：
///  1. 使用 image crate 解码 PNG 并缩放到 9x8
///  2. 转为灰度
///  3. 逐行比较相邻像素亮度：左 > 右 记 1，否则记 0
///  4. 得到 64 bit 哈希字符串
pub fn calculate_image_hash(png_buffer: &[u8]) -> String {
    let img = match image::load_from_memory(png_buffer) {
        Ok(img) => img,
        Err(e) => {
            log::warn!("[Screenshot] calculate_image_hash 解码失败: {}", e);
            return String::new();
        }
    };
    // 缩放到 9x8 灰度
    let resized = img.resize_exact(DHASH_WIDTH, DHASH_HEIGHT, image::imageops::FilterType::Nearest);
    let gray = resized.to_luma8();

    let mut hash = String::with_capacity(64);
    for y in 0..DHASH_HEIGHT {
        for x in 0..DHASH_WIDTH - 1 {
            let left = gray.get_pixel(x, y).0[0];
            let right = gray.get_pixel(x + 1, y).0[0];
            hash.push(if left > right { '1' } else { '0' });
        }
    }
    hash
}

/// 计算两个 dHash 字符串的汉明距离。
/// 长度不一致或为空时返回最大距离（64）。
pub fn hamming_distance(hash1: &str, hash2: &str) -> usize {
    if hash1.is_empty() || hash2.is_empty() || hash1.len() != hash2.len() {
        return 64;
    }
    hash1
        .chars()
        .zip(hash2.chars())
        .filter(|(a, b)| a != b)
        .count()
}

/// 判断两个哈希是否相似。距离 <= threshold 视为相似。
pub fn is_similar(hash1: &str, hash2: &str, threshold: usize) -> bool {
    if hash1.is_empty() || hash2.is_empty() {
        return false;
    }
    hamming_distance(hash1, hash2) <= threshold
}

/// 判断两个哈希是否相似，使用默认阈值。
pub fn is_similar_default(hash1: &str, hash2: &str) -> bool {
    is_similar(hash1, hash2, DEFAULT_SIMILARITY_THRESHOLD)
}

// ===================== 内部工具 =====================

/// 确保目录存在
fn ensure_dir(dir: &Path) {
    if !dir.exists() {
        if let Err(e) = fs::create_dir_all(dir) {
            log::warn!("[Screenshot] 创建目录失败 {:?}: {}", dir, e);
        }
    }
}

/// 简单伪随机数（不依赖 rand crate）
fn rand_u32() -> u32 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .hash(&mut hasher);
    (hasher.finish() & 0xFFFFFFFF) as u32
}

/// 解析 YYYY-MM-DD 日期字符串为 Unix 毫秒时间戳
fn parse_date_to_millis(date: &str) -> Option<u128> {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let year: i32 = parts[0].parse().ok()?;
    let month: u32 = parts[1].parse().ok()?;
    let day: u32 = parts[2].parse().ok()?;
    // 简化计算：用 chrono 更准确，但避免额外依赖
    // 这里用近似天数 → 毫秒
    // 1970-01-01 为起点
    if year < 1970 {
        return None;
    }
    let days_since_epoch = days_from_civil(year, month, day)?;
    Some(days_since_epoch as u128 * 24 * 60 * 60 * 1000)
}

/// 日期转自 1970-01-01 的天数（Howard Hinnant 算法）
fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    if month == 0 || month > 12 || day == 0 || day > 31 {
        return None;
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32; // [0, 399]
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    Some(era as i64 * 146097 + doe as i64 - 719468)
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hamming_distance_empty() {
        assert_eq!(hamming_distance("", ""), 64);
        assert_eq!(hamming_distance("1010", ""), 64);
        assert_eq!(hamming_distance("", "1010"), 64);
    }

    #[test]
    fn test_hamming_distance_different_lengths() {
        assert_eq!(hamming_distance("1010", "10101"), 64);
    }

    #[test]
    fn test_hamming_distance_same() {
        assert_eq!(hamming_distance("10101010", "10101010"), 0);
    }

    #[test]
    fn test_hamming_distance_different() {
        assert_eq!(hamming_distance("10101010", "01010101"), 8);
    }

    #[test]
    fn test_is_similar_default() {
        // 64 位哈希，默认阈值 10
        let h1 = "1010101010101010101010101010101010101010101010101010101010101010";
        // 完全相同 → 相似
        assert!(is_similar_default(h1, h1));
        // 完全相反 → 64 位差异，不相似
        let h2 = "0101010101010101010101010101010101010101010101010101010101010101";
        assert!(!is_similar_default(h1, h2));
    }

    #[test]
    fn test_is_similar_empty() {
        assert!(!is_similar("", "", 10));
        assert!(!is_similar("1010", "", 10));
    }

    #[test]
    fn test_is_similar_threshold() {
        // 16 位哈希，2 位不同
        let h1 = "1010101010101010";
        let h2 = "1010101001101010";
        // 距离 = 2
        assert!(is_similar(h1, h2, 4));  // 2 <= 4 → 相似
        assert!(is_similar(h1, h2, 2));  // 2 <= 2 → 相似
        assert!(!is_similar(h1, h2, 1)); // 2 > 1 → 不相似
    }

    #[test]
    fn test_calculate_image_hash_invalid_png() {
        let hash = calculate_image_hash(b"not a png");
        assert!(hash.is_empty());
    }

    #[test]
    fn test_calculate_image_hash_valid_png() {
        // 创建一个 2x2 纯白 PNG
        let img = image::DynamicImage::ImageRgba8(image::ImageBuffer::from_pixel(
            2,
            2,
            image::Rgba([255, 255, 255, 255]),
        ));
        let mut buf = Vec::new();
        image::DynamicImage::ImageRgba8(img.into_rgba8())
            .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        let hash = calculate_image_hash(&buf);
        assert_eq!(hash.len(), 64);
        // 纯白图像所有相邻像素相同，哈希应全为 '0'
        assert!(hash.chars().all(|c| c == '0'));
    }

    #[test]
    fn test_capture_window_zero_hwnd() {
        let result = capture_window(0);
        match result {
            ScreenshotResult::Failed { reason, .. } => {
                assert_eq!(reason, ScreenshotFailureReason::WindowNotFound);
            }
            _ => panic!("期望 Failed 结果"),
        }
    }

    #[test]
    fn test_parse_date_to_millis() {
        // 1970-01-01 应为 0
        assert_eq!(parse_date_to_millis("1970-01-01"), Some(0));
        // 1970-01-02 应为 86400000 (1 day in ms)
        assert_eq!(parse_date_to_millis("1970-01-02"), Some(86400000));
        // 无效日期
        assert_eq!(parse_date_to_millis("invalid"), None);
        assert_eq!(parse_date_to_millis("2026-13-01"), None);
    }

    #[test]
    fn test_days_from_civil() {
        assert_eq!(days_from_civil(1970, 1, 1), Some(0));
        assert_eq!(days_from_civil(1970, 1, 2), Some(1));
        assert_eq!(days_from_civil(1971, 1, 1), Some(365));
        assert_eq!(days_from_civil(2020, 1, 1), Some(18262));
    }
}
