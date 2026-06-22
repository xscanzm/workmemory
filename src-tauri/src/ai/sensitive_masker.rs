//! SensitiveMasker：敏感信息脱敏器（对应 electron/ai/SensitiveMasker.ts）
//!
//! 对文本中的手机号 / 邮箱 / 身份证号 / 银行卡号 / API Key 自动掩码，避免明文上传到 AI。
//! 用于 ReportGenerator 构建 AI 输入前对 OCR 摘要文本脱敏，以及前端确认面板显示脱敏统计。
//!
//! 掩码规则：
//!  - 邮箱：user@example.com → u***@example.com
//!  - 身份证号（18 位，末位可为 X/x）：110101199001011234 → 110101********1234
//!  - 手机号（11 位，1[3-9] 开头）：13812345678 → 138****5678
//!  - 银行卡号（16-19 位连续数字）：6222020200011111 → 6222****1111
//!  - API Key（sk-xxx）：sk-abcdef123456 → sk-****3456
//!
//! 匹配顺序：邮箱 > 身份证 > 手机号 > 银行卡 > API Key
//! （避免 18 位身份证被银行卡规则误匹配）。

use regex::Regex;
use std::sync::OnceLock;

/// 脱敏结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaskedText {
    /// 脱敏后的文本
    pub text: String,
    /// 被脱敏的敏感项数量
    pub masked_count: u32,
}

/// 邮箱正则：user.name+tag@example.com
static EMAIL_RE: OnceLock<Regex> = OnceLock::new();
/// 身份证号正则：18 位，末位可为 X/x（前后不能是数字）
static ID_CARD_RE: OnceLock<Regex> = OnceLock::new();
/// 手机号正则：1[3-9] 开头共 11 位（前后不能是数字）
static PHONE_RE: OnceLock<Regex> = OnceLock::new();
/// 银行卡号正则：16-19 位连续数字（前后不能是数字）
static BANK_CARD_RE: OnceLock<Regex> = OnceLock::new();
/// API Key 正则：sk- 开头后跟至少 20 位字母数字
static API_KEY_RE: OnceLock<Regex> = OnceLock::new();

fn email_re() -> &'static Regex {
    EMAIL_RE.get_or_init(|| {
        // 邮箱：local@domain，local 允许字母/数字/._+-
        Regex::new(r"[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+").unwrap()
    })
}

fn id_card_re() -> &'static Regex {
    ID_CARD_RE.get_or_init(|| {
        // 身份证号：18 位，末位可为 X/x。使用 (?<!\d) / (?!\d) 避免匹配更长数字串的子串。
        // Rust regex 不支持 lookbehind，改用边界匹配：前后为非数字或字符串首尾
        Regex::new(r"(^|[^\d])(\d{17}[\dXx])([^\d]|$)").unwrap()
    })
}

fn phone_re() -> &'static Regex {
    PHONE_RE.get_or_init(|| {
        // 手机号：1[3-9] 开头共 11 位
        Regex::new(r"(^|[^\d])(1[3-9]\d{9})([^\d]|$)").unwrap()
    })
}

fn bank_card_re() -> &'static Regex {
    BANK_CARD_RE.get_or_init(|| {
        // 银行卡号：16-19 位连续数字
        Regex::new(r"(^|[^\d])(\d{16,19})([^\d]|$)").unwrap()
    })
}

fn api_key_re() -> &'static Regex {
    API_KEY_RE.get_or_init(|| {
        // API Key：sk- 开头后跟至少 20 位字母数字（OpenAI 风格）
        Regex::new(r"sk-[A-Za-z0-9]{20,}").unwrap()
    })
}

/// 邮箱掩码：user@example.com → u***@example.com
fn mask_email(m: &str) -> String {
    let at_idx = match m.find('@') {
        Some(idx) if idx > 0 => idx,
        _ => return m.to_string(),
    };
    let local = &m[..at_idx];
    let domain = &m[at_idx..];
    let masked_local = if local.len() <= 1 {
        "*".to_string()
    } else {
        format!("{}***", &local[..1])
    };
    format!("{}{}", masked_local, domain)
}

/// 身份证号掩码：110101199001011234 → 110101********1234
fn mask_id_card(m: &str) -> String {
    if m.len() < 10 {
        return m.to_string();
    }
    format!("{}********{}", &m[..6], &m[m.len() - 4..])
}

/// 手机号掩码：13812345678 → 138****5678
fn mask_phone(m: &str) -> String {
    if m.len() < 7 {
        return m.to_string();
    }
    format!("{}****{}", &m[..3], &m[m.len() - 4..])
}

/// 银行卡号掩码：6222020200011111 → 6222****1111
fn mask_bank_card(m: &str) -> String {
    if m.len() < 8 {
        return m.to_string();
    }
    format!("{}****{}", &m[..4], &m[m.len() - 4..])
}

/// API Key 掩码：sk-abcdef123456 → sk-****3456
fn mask_api_key(m: &str) -> String {
    if m.len() < 7 {
        return m.to_string();
    }
    format!("{}****{}", &m[..3], &m[m.len() - 4..])
}

/// 对文本进行敏感信息脱敏。
///
/// 依次应用邮箱 / 身份证 / 手机号 / 银行卡 / API Key 掩码规则，累计脱敏次数。
///
/// # 参数
/// - `text`：原始文本
///
/// # 返回
/// 脱敏结果（含掩码后文本与脱敏次数）
pub fn mask_sensitive(text: &str) -> MaskedText {
    if text.is_empty() {
        return MaskedText {
            text: String::new(),
            masked_count: 0,
        };
    }

    let mut result = text.to_string();
    let mut masked_count: u32 = 0;

    // 1. 邮箱（无边界问题，直接替换）
    result = email_re().replace_all(&result, |caps: &regex::Captures| {
        masked_count += 1;
        mask_email(&caps[0])
    }).to_string();

    // 2. 身份证号（带边界捕获组，需保留前后字符）
    result = id_card_re().replace_all(&result, |caps: &regex::Captures| {
        masked_count += 1;
        let prefix = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let id = &caps[2];
        let suffix = caps.get(3).map(|m| m.as_str()).unwrap_or("");
        format!("{}{}{}", prefix, mask_id_card(id), suffix)
    }).to_string();

    // 3. 手机号（带边界捕获组）
    result = phone_re().replace_all(&result, |caps: &regex::Captures| {
        masked_count += 1;
        let prefix = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let phone = &caps[2];
        let suffix = caps.get(3).map(|m| m.as_str()).unwrap_or("");
        format!("{}{}{}", prefix, mask_phone(phone), suffix)
    }).to_string();

    // 4. 银行卡号（带边界捕获组）
    result = bank_card_re().replace_all(&result, |caps: &regex::Captures| {
        masked_count += 1;
        let prefix = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let card = &caps[2];
        let suffix = caps.get(3).map(|m| m.as_str()).unwrap_or("");
        format!("{}{}{}", prefix, mask_bank_card(card), suffix)
    }).to_string();

    // 5. API Key（无边界问题）
    result = api_key_re().replace_all(&result, |caps: &regex::Captures| {
        masked_count += 1;
        mask_api_key(&caps[0])
    }).to_string();

    MaskedText {
        text: result,
        masked_count,
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试空文本
    #[test]
    fn test_mask_sensitive_empty() {
        let result = mask_sensitive("");
        assert_eq!(result.text, "");
        assert_eq!(result.masked_count, 0);
    }

    /// 测试无敏感信息
    #[test]
    fn test_mask_sensitive_no_sensitive() {
        let result = mask_sensitive("今天写了很多代码，完成了 API 加密功能。");
        assert_eq!(result.text, "今天写了很多代码，完成了 API 加密功能。");
        assert_eq!(result.masked_count, 0);
    }

    /// 测试邮箱脱敏
    #[test]
    fn test_mask_sensitive_email() {
        let result = mask_sensitive("联系我：user.name@example.com");
        assert!(result.text.contains("u***@example.com"));
        assert!(!result.text.contains("user.name@example.com"));
        assert_eq!(result.masked_count, 1);
    }

    /// 测试手机号脱敏
    #[test]
    fn test_mask_sensitive_phone() {
        let result = mask_sensitive("电话：13812345678");
        assert!(result.text.contains("138****5678"));
        assert!(!result.text.contains("13812345678"));
        assert_eq!(result.masked_count, 1);
    }

    /// 测试身份证号脱敏
    #[test]
    fn test_mask_sensitive_id_card() {
        let result = mask_sensitive("身份证：110101199001011234");
        assert!(result.text.contains("110101********1234"));
        assert!(!result.text.contains("110101199001011234"));
        assert_eq!(result.masked_count, 1);
    }

    /// 测试银行卡号脱敏
    #[test]
    fn test_mask_sensitive_bank_card() {
        let result = mask_sensitive("卡号：6222020200011111");
        assert!(result.text.contains("6222****1111"));
        assert!(!result.text.contains("6222020200011111"));
        assert_eq!(result.masked_count, 1);
    }

    /// 测试 API Key 脱敏
    #[test]
    fn test_mask_sensitive_api_key() {
        let result = mask_sensitive("key: sk-abcdefghijklmnopqrstuvwxyz123456");
        assert!(result.text.contains("sk-****3456"));
        assert!(!result.text.contains("sk-abcdefghijklmnopqrstuvwxyz123456"));
        assert_eq!(result.masked_count, 1);
    }

    /// 测试多种敏感信息混合
    #[test]
    fn test_mask_sensitive_mixed() {
        let text = "邮箱 user@example.com 电话 13812345678 身份证 110101199001011234";
        let result = mask_sensitive(text);
        assert!(result.text.contains("u***@example.com"));
        assert!(result.text.contains("138****5678"));
        assert!(result.text.contains("110101********1234"));
        assert_eq!(result.masked_count, 3);
    }
}
