//! SettingsStore：应用设置持久化（对应 electron/db/SettingsStore.ts）
//!
//! 使用 userData/settings.json 文件存储，合并默认设置。
//! API Key 加密存储：使用简单 XOR + base64（Tauri 环境降级方案，
//! Windows 生产环境可后续升级为 DPAPI）。

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use crate::models::{AppSettings, MascotStyle, OcrModel};

/// 持久化到 settings.json 的内部结构。
/// 与 AppSettings 的区别：用 api_key_encrypted 替代 api_key_masked（派生字段，不落盘）。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedSettings {
    auto_start: bool,
    screenshot_retention_days: i32,
    ocr_model: String,
    api_key_encrypted: String,
    api_base_url: String,
    model_name: String,
    mascot_style: String,
    save_screenshots: bool,
    allow_full_screenshot_fallback: bool,
    ai_auto_distill_enabled: bool,
    ai_auto_distill_first_consent_at: String,
    ai_distill_schedule: String,
    ai_distill_last_run_at: String,
    ai_distill_send_screenshots: bool,
}

impl Default for PersistedSettings {
    fn default() -> Self {
        PersistedSettings {
            auto_start: false,
            screenshot_retention_days: 0,
            ocr_model: "tiny".to_string(),
            api_key_encrypted: String::new(),
            api_base_url: "https://api.openai.com/v1".to_string(),
            model_name: "gpt-4o-mini".to_string(),
            mascot_style: "note".to_string(),
            save_screenshots: false,
            allow_full_screenshot_fallback: true,
            ai_auto_distill_enabled: false,
            ai_auto_distill_first_consent_at: String::new(),
            ai_distill_schedule: "hourly".to_string(),
            ai_distill_last_run_at: String::new(),
            ai_distill_send_screenshots: false,
        }
    }
}

/// 全局设置缓存（线程安全）
static SETTINGS_CACHE: Lazy<Mutex<Option<PersistedSettings>>> = Lazy::new(|| Mutex::new(None));

/// 全局 app_data_dir 路径（由 init_settings_store 设置）
pub static APP_DATA_DIR: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

/// 初始化 SettingsStore，设置 app_data_dir 路径。
/// 应在 Tauri setup 钩子中调用。
pub fn init_settings_store(app_data_dir: PathBuf) {
    let mut dir = APP_DATA_DIR.lock().unwrap();
    *dir = Some(app_data_dir);
}

fn get_settings_file_path() -> PathBuf {
    let dir = APP_DATA_DIR.lock().unwrap();
    match dir.as_ref() {
        Some(p) => p.join("settings.json"),
        None => PathBuf::from("settings.json"),
    }
}

// ===================== API Key 加密 / 解密 =====================

/// 机器级 XOR 降级密钥
fn get_xor_fallback_key() -> String {
    let hostname = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown".to_string());
    let username = whoami::username();
    format!("WorkMemory::{}::{}", hostname, username)
}

/// XOR 加密
fn xor_cipher(input: &[u8], key: &str) -> Vec<u8> {
    let key_bytes = key.as_bytes();
    let mut result = Vec::with_capacity(input.len());
    for (i, &b) in input.iter().enumerate() {
        result.push(b ^ key_bytes[i % key_bytes.len()]);
    }
    result
}

/// 加密 API Key 为 base64 字符串
fn encrypt_api_key(plain_key: &str) -> String {
    if plain_key.is_empty() {
        return String::new();
    }
    let xor_buf = xor_cipher(plain_key.as_bytes(), &get_xor_fallback_key());
    format!("xor:{}", base64_encode(&xor_buf))
}

/// 解密 API Key
fn decrypt_api_key(encrypted_blob: &str) -> String {
    if encrypted_blob.is_empty() {
        return String::new();
    }
    if let Some(payload) = encrypted_blob.strip_prefix("xor:") {
        if let Ok(buf) = base64_decode(payload) {
            return String::from_utf8_lossy(&xor_cipher(&buf, &get_xor_fallback_key())).to_string();
        }
        return String::new();
    }
    // 非 xor: 前缀的密文无法解密（可能是未来 DPAPI 格式）
    String::new()
}

/// 将明文 API Key 转为掩码
fn mask_api_key(plain_key: &str) -> String {
    if plain_key.is_empty() {
        return String::new();
    }
    if plain_key.len() <= 7 {
        return "****".to_string();
    }
    let prefix = &plain_key[0..3];
    let suffix = &plain_key[plain_key.len() - 4..];
    format!("{}****{}", prefix, suffix)
}

/// 简单 base64 编码（使用标准库 + 自实现，避免额外依赖）
fn base64_encode(input: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[((n >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((n >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[((n >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(n & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

/// 简单 base64 解码
fn base64_decode(input: &str) -> Result<Vec<u8>, ()> {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let input: Vec<u8> = input.bytes().filter(|&b| b != b'\n' && b != b'\r').collect();
    let mut result = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for &b in &input {
        if b == b'=' {
            break;
        }
        let val = CHARS.iter().position(|&c| c == b).ok_or(())? as u32;
        buffer = (buffer << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            result.push((buffer >> bits) as u8 & 0xFF);
        }
    }
    Ok(result)
}

// ===================== 磁盘读写 =====================

fn read_settings() -> PersistedSettings {
    let file_path = get_settings_file_path();
    if !file_path.exists() {
        return PersistedSettings::default();
    }
    match fs::read_to_string(&file_path) {
        Ok(raw) => {
            let parsed: serde_json::Value = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(_) => return PersistedSettings::default(),
            };
            let mut result = PersistedSettings::default();
            if let Some(obj) = parsed.as_object() {
                if let Some(v) = obj.get("auto_start").and_then(|v| v.as_bool()) {
                    result.auto_start = v;
                }
                if let Some(v) = obj.get("screenshot_retention_days").and_then(|v| v.as_i64()) {
                    result.screenshot_retention_days = v as i32;
                }
                if let Some(v) = obj.get("ocr_model").and_then(|v| v.as_str()) {
                    result.ocr_model = v.to_string();
                }
                if let Some(v) = obj.get("api_key_encrypted").and_then(|v| v.as_str()) {
                    result.api_key_encrypted = v.to_string();
                }
                if let Some(v) = obj.get("api_base_url").and_then(|v| v.as_str()) {
                    result.api_base_url = v.to_string();
                }
                if let Some(v) = obj.get("model_name").and_then(|v| v.as_str()) {
                    result.model_name = v.to_string();
                }
                if let Some(v) = obj.get("mascot_style").and_then(|v| v.as_str()) {
                    result.mascot_style = v.to_string();
                }
                if let Some(v) = obj.get("save_screenshots").and_then(|v| v.as_bool()) {
                    result.save_screenshots = v;
                }
                if let Some(v) = obj.get("allow_full_screenshot_fallback").and_then(|v| v.as_bool()) {
                    result.allow_full_screenshot_fallback = v;
                }
                if let Some(v) = obj.get("ai_auto_distill_enabled").and_then(|v| v.as_bool()) {
                    result.ai_auto_distill_enabled = v;
                }
                if let Some(v) = obj.get("ai_auto_distill_first_consent_at").and_then(|v| v.as_str()) {
                    result.ai_auto_distill_first_consent_at = v.to_string();
                }
                if let Some(v) = obj.get("ai_distill_schedule").and_then(|v| v.as_str()) {
                    result.ai_distill_schedule = v.to_string();
                }
                if let Some(v) = obj.get("ai_distill_last_run_at").and_then(|v| v.as_str()) {
                    result.ai_distill_last_run_at = v.to_string();
                }
                if let Some(v) = obj.get("ai_distill_send_screenshots").and_then(|v| v.as_bool()) {
                    result.ai_distill_send_screenshots = v;
                }
                // 兼容旧版明文 apiKey
                if let Some(v) = obj.get("apiKey").and_then(|v| v.as_str()) {
                    if !v.is_empty() && result.api_key_encrypted.is_empty() {
                        result.api_key_encrypted = encrypt_api_key(v);
                    }
                }
            }
            result
        }
        Err(_) => PersistedSettings::default(),
    }
}

fn write_settings(settings: &PersistedSettings) {
    let file_path = get_settings_file_path();
    if let Some(parent) = file_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(settings) {
        let _ = fs::write(&file_path, json);
    }
}

/// 将持久化设置转为 UI 可见的 AppSettings
fn to_app_settings(persisted: &PersistedSettings) -> AppSettings {
    let plain_key = decrypt_api_key(&persisted.api_key_encrypted);
    AppSettings {
        auto_start: persisted.auto_start,
        screenshot_retention_days: persisted.screenshot_retention_days,
        ocr_model: OcrModel::from_str(&persisted.ocr_model),
        api_key_masked: mask_api_key(&plain_key),
        api_base_url: persisted.api_base_url.clone(),
        model_name: persisted.model_name.clone(),
        mascot_style: MascotStyle::from_str(&persisted.mascot_style),
        save_screenshots: persisted.save_screenshots,
        allow_full_screenshot_fallback: persisted.allow_full_screenshot_fallback,
        ai_auto_distill_enabled: persisted.ai_auto_distill_enabled,
        ai_auto_distill_first_consent_at: persisted.ai_auto_distill_first_consent_at.clone(),
        ai_distill_schedule: persisted.ai_distill_schedule.clone(),
        ai_distill_last_run_at: persisted.ai_distill_last_run_at.clone(),
        ai_distill_send_screenshots: persisted.ai_distill_send_screenshots,
    }
}

pub struct SettingsStore;

impl SettingsStore {
    /// 获取完整设置（带缓存）
    pub fn get() -> AppSettings {
        let mut cache = SETTINGS_CACHE.lock().unwrap();
        if cache.is_none() {
            *cache = Some(read_settings());
        }
        to_app_settings(cache.as_ref().unwrap())
    }

    /// 获取持久化设置（内部使用，含 api_key_encrypted）
    fn get_persisted() -> PersistedSettings {
        let mut cache = SETTINGS_CACHE.lock().unwrap();
        if cache.is_none() {
            *cache = Some(read_settings());
        }
        cache.as_ref().unwrap().clone()
    }

    /// 更新设置（合并 patch），写入磁盘
    pub fn set(patch: AppSettings) -> AppSettings {
        let mut current = Self::get_persisted();
        // 合并 patch（api_key_masked 是派生字段，忽略）
        current.auto_start = patch.auto_start;
        current.screenshot_retention_days = patch.screenshot_retention_days;
        current.ocr_model = patch.ocr_model.as_str().to_string();
        current.api_base_url = patch.api_base_url;
        current.model_name = patch.model_name;
        current.mascot_style = patch.mascot_style.as_str().to_string();
        current.save_screenshots = patch.save_screenshots;
        current.allow_full_screenshot_fallback = patch.allow_full_screenshot_fallback;
        current.ai_auto_distill_enabled = patch.ai_auto_distill_enabled;
        current.ai_auto_distill_first_consent_at = patch.ai_auto_distill_first_consent_at;
        current.ai_distill_schedule = patch.ai_distill_schedule;
        current.ai_distill_last_run_at = patch.ai_distill_last_run_at;
        current.ai_distill_send_screenshots = patch.ai_distill_send_screenshots;

        write_settings(&current);
        let result = to_app_settings(&current);
        let mut cache = SETTINGS_CACHE.lock().unwrap();
        *cache = Some(current);
        result
    }

    /// 重置为默认设置
    pub fn reset() -> AppSettings {
        let default = PersistedSettings::default();
        write_settings(&default);
        let result = to_app_settings(&default);
        let mut cache = SETTINGS_CACHE.lock().unwrap();
        *cache = Some(default);
        result
    }

    /// 运行时解密返回明文 API Key
    pub fn get_api_key() -> String {
        let persisted = Self::get_persisted();
        decrypt_api_key(&persisted.api_key_encrypted)
    }

    /// 加密并保存 API Key
    pub fn set_api_key(key: &str) {
        let mut current = Self::get_persisted();
        current.api_key_encrypted = encrypt_api_key(key);
        write_settings(&current);
        let mut cache = SETTINGS_CACHE.lock().unwrap();
        *cache = Some(current);
    }

    /// 清空 API Key
    pub fn clear_api_key() {
        let mut current = Self::get_persisted();
        current.api_key_encrypted = String::new();
        write_settings(&current);
        let mut cache = SETTINGS_CACHE.lock().unwrap();
        *cache = Some(current);
    }

    /// 仅获取 Mascot 样式
    pub fn get_mascot_style() -> MascotStyle {
        MascotStyle::from_str(&Self::get_persisted().mascot_style)
    }

    /// 仅获取 OCR 模型
    pub fn get_ocr_model() -> OcrModel {
        OcrModel::from_str(&Self::get_persisted().ocr_model)
    }
}
