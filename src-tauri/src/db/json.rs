/** JSON 工具：安全解析/序列化 JSON 数组与字段（对应 electron/db/json.ts） */

use serde::de::DeserializeOwned;
use serde::Serialize;

/// 安全解析 JSON 数组，失败返回空 Vec
pub fn parse_json_array<T: DeserializeOwned>(value: &str) -> Vec<T> {
    if value.is_empty() {
        return Vec::new();
    }
    serde_json::from_str(value).unwrap_or_default()
}

/// 安全序列化为 JSON 数组字符串，失败返回 "[]"
pub fn stringify_json_array<T: Serialize>(value: &[T]) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "[]".to_string())
}

/// 安全解析任意 JSON 字段，失败返回 fallback
pub fn parse_json_field<T: DeserializeOwned>(value: &str, fallback: T) -> T {
    if value.is_empty() {
        return fallback;
    }
    serde_json::from_str(value).unwrap_or(fallback)
}
