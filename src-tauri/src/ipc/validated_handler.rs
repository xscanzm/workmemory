//! IPC 入参校验工具（对应 electron/ipc/validatedHandler.ts）
//!
//! 提供泛型校验函数，将 serde_json::Value 反序列化为目标类型，
//! 校验失败时返回中文错误信息。
//!
//! 与 TypeScript 版本的差异：
//!  - TypeScript 版用 Zod schema 校验，Rust 版用 serde 反序列化 + 自定义校验
//!  - Tauri 命令参数由框架自动反序列化，本模块供手动校验场景使用
//!  - 统一返回 Result<T, String>，错误信息为中文

use serde::de::DeserializeOwned;
use serde_json::{json, Value};

/// 将 serde_json::Value 反序列化为目标类型 T。
///
/// 校验失败时返回中文错误信息，包含字段路径与原因。
///
/// # 参数
/// - `req`：请求 payload（JSON Value）
///
/// # 返回
/// - `Ok(T)`：反序列化成功
/// - `Err(String)`：反序列化失败，包含中文错误描述
///
/// # 示例
/// ```
/// use serde::{Deserialize, Serialize};
/// use serde_json::json;
/// use workmemory_lib::ipc::validated_handler::validate_request;
///
/// #[derive(Debug, Deserialize, Serialize)]
/// struct MyReq { id: String }
///
/// let payload = json!({ "id": "seg-1" });
/// let result: Result<MyReq, String> = validate_request(&payload);
/// assert!(result.is_ok());
/// assert_eq!(result.unwrap().id, "seg-1");
/// ```
pub fn validate_request<T: DeserializeOwned>(req: &Value) -> Result<T, String> {
    serde_json::from_value::<T>(req.clone()).map_err(|e| {
        // 将 serde 错误转为中文描述
        format!("参数校验失败: {}", e)
    })
}

/// 校验必填字符串字段非空。
///
/// # 参数
/// - `value`：字段值
/// - `field_name`：字段名（用于错误信息）
///
/// # 返回
/// - `Ok(())`：字段非空
/// - `Err(String)`：字段为空
pub fn validate_non_empty(value: &str, field_name: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{} 不能为空", field_name))
    } else {
        Ok(())
    }
}

/// 校验日期格式为 YYYY-MM-DD。
///
/// # 参数
/// - `date`：日期字符串
///
/// # 返回
/// - `Ok(())`：格式正确
/// - `Err(String)`：格式错误
pub fn validate_date_format(date: &str) -> Result<(), String> {
    if date.len() != 10 {
        return Err(format!("日期格式必须为 YYYY-MM-DD，得到: {}", date));
    }
    let bytes = date.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return Err(format!("日期格式必须为 YYYY-MM-DD，得到: {}", date));
    }
    for (i, &b) in bytes.iter().enumerate() {
        if i == 4 || i == 7 {
            continue;
        }
        if !b.is_ascii_digit() {
            return Err(format!("日期格式必须为 YYYY-MM-DD，得到: {}", date));
        }
    }
    Ok(())
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Deserialize, Serialize)]
    struct TestRequest {
        id: String,
        date: String,
    }

    #[test]
    fn test_validate_request_success() {
        // 合法 payload 应反序列化成功
        let payload = json!({ "id": "seg-1", "date": "2026-06-22" });
        let result: Result<TestRequest, String> = validate_request(&payload);
        assert!(result.is_ok());
        let req = result.unwrap();
        assert_eq!(req.id, "seg-1");
        assert_eq!(req.date, "2026-06-22");
    }

    #[test]
    fn test_validate_request_missing_field() {
        // 缺少必填字段应返回中文错误
        let payload = json!({ "id": "seg-1" });
        let result: Result<TestRequest, String> = validate_request(&payload);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("参数校验失败"));
        assert!(err.contains("date"));
    }

    #[test]
    fn test_validate_request_type_mismatch() {
        // 类型不匹配应返回错误
        let payload = json!({ "id": 123, "date": "2026-06-22" });
        let result: Result<TestRequest, String> = validate_request(&payload);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("参数校验失败"));
    }

    #[test]
    fn test_validate_non_empty_ok() {
        assert!(validate_non_empty("hello", "名称").is_ok());
        assert!(validate_non_empty("  x  ", "名称").is_ok());
    }

    #[test]
    fn test_validate_non_empty_fail() {
        assert!(validate_non_empty("", "名称").is_err());
        assert!(validate_non_empty("   ", "名称").is_err());
    }

    #[test]
    fn test_validate_date_format_ok() {
        assert!(validate_date_format("2026-06-22").is_ok());
        assert!(validate_date_format("2025-01-01").is_ok());
    }

    #[test]
    fn test_validate_date_format_fail() {
        // 长度不对
        assert!(validate_date_format("2026-6-22").is_err());
        // 分隔符不对
        assert!(validate_date_format("2026/06/22").is_err());
        // 含非数字
        assert!(validate_date_format("2026-ab-cd").is_err());
        // 空字符串
        assert!(validate_date_format("").is_err());
    }
}
