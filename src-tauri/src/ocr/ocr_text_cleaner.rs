//! OCR 文本去噪器
//!
//! 对 OCR 原始文本执行去噪处理，去除 UI 通用噪声（菜单栏、状态栏、按钮、地址栏 URL），
//! 合并碎片短行，去重重复行，输出清洗后文本与噪声评分。
//!
//! 对应规格 T3.4：从 TypeScript 版本 (electron/ocr/OcrTextCleaner.ts) 移植。
//!
//! 职责：
//!  - clean(raw_text)：去噪 + 行合并 + 去重 + 空行折叠
//!  - noise_score = 噪声行数 / 总非空行数（0-1），空文本返回 1
//!
//! 噪声判定：一行文本若完全由噪声词组成，或匹配 URL/时间/电池等噪声模式，则视为噪声行。
//! 英文噪声词匹配大小写不敏感。

use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashSet;

/// 清洗结果
#[derive(Debug, Clone, PartialEq)]
pub struct CleanResult {
    /// 清洗后的文本（已 trim，连续空行折叠至最多 1 行）
    pub cleaned_text: String,
    /// 噪声评分 0-1，空文本返回 1
    pub noise_score: f64,
}

// ===================== 噪声词表 =====================

/// 中文菜单栏噪声词
pub const CHINESE_MENU_WORDS: &[&str] = &[
    "文件", "编辑", "视图", "收藏", "工具", "帮助", "设置", "窗口",
];

/// 英文菜单栏噪声词（匹配时大小写不敏感）
pub const ENGLISH_MENU_WORDS: &[&str] = &[
    "File", "Edit", "View", "Favorites", "Tools", "Help", "Settings", "Window",
];

/// 中文按钮噪声词
pub const CHINESE_BUTTON_WORDS: &[&str] = &[
    "确定", "取消", "保存", "关闭", "刷新", "返回", "搜索", "登录", "注册",
];

/// 英文按钮噪声词（匹配时大小写不敏感）
pub const ENGLISH_BUTTON_WORDS: &[&str] = &[
    "OK", "Cancel", "Save", "Close", "Refresh", "Back", "Search", "Login", "Register",
];

/// 状态栏网络指示噪声词（匹配时大小写不敏感）
pub const NETWORK_INDICATOR_WORDS: &[&str] = &[
    "WiFi", "Wi-Fi", "Bluetooth", "蓝牙", "Ethernet", "以太网", "5G", "4G", "LTE",
];

/// 全部噪声词集合（英文转小写，用于大小写不敏感匹配）。
/// 中文词原样存入；英文词转小写后存入。
pub static NOISE_WORDS_LOWER: Lazy<HashSet<String>> = Lazy::new(|| {
    let mut set = HashSet::new();
    // 中文菜单词原样存入
    for w in CHINESE_MENU_WORDS {
        set.insert((*w).to_string());
    }
    // 中文按钮词原样存入
    for w in CHINESE_BUTTON_WORDS {
        set.insert((*w).to_string());
    }
    // 网络指示词原样存入（含中文与英文）
    for w in NETWORK_INDICATOR_WORDS {
        set.insert((*w).to_string());
    }
    // 英文菜单词转小写存入
    for w in ENGLISH_MENU_WORDS {
        set.insert(w.to_lowercase());
    }
    // 英文按钮词转小写存入
    for w in ENGLISH_BUTTON_WORDS {
        set.insert(w.to_lowercase());
    }
    set
});

// ===================== 噪声模式 =====================

/// URL 噪声模式：http/https 开头的完整 URL 行
static URL_PATTERN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^https?://\S+$").expect("URL_PATTERN 正则编译失败"));

/// 时间格式噪声模式：HH:MM 或 HH:MM:SS，可选 上午/下午/AM/PM 前缀
static TIME_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(?:(?:上午|下午|AM|PM)\s*)?\d{1,2}:\d{2}(?::\d{2})?$")
        .expect("TIME_PATTERN 正则编译失败")
});

/// 日期格式噪声模式：YYYY-MM-DD 或 YYYY/MM/DD
static DATE_PATTERN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\d{4}[-/]\d{1,2}[-/]\d{1,2}$").expect("DATE_PATTERN 正则编译失败"));

/// 日期时间格式噪声模式：YYYY-MM-DD HH:MM[:SS]
static DATETIME_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?$")
        .expect("DATETIME_PATTERN 正则编译失败")
});

/// 电池百分比噪声模式：如 100%、50%
static BATTERY_PATTERN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\d+%$").expect("BATTERY_PATTERN 正则编译失败"));

/// 短行阈值：≤15 字视为短行，参与合并
const SHORT_LINE_MAX_LENGTH: usize = 15;

/// 句末标点（句号/问号/感叹号，中英文）
static TERMINAL_PUNCTUATION: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[。？！.?!]").expect("TERMINAL_PUNCTUATION 正则编译失败"));

// ===================== 行级判定函数 =====================

/// 判断一行文本是否为噪声行。
///
/// 判定规则（满足任一即为噪声行）：
///  1. 匹配 URL 模式（http/https 开头）
///  2. 匹配时间 / 日期 / 日期时间模式
///  3. 匹配电池百分比模式
///  4. 按空白拆分后所有 token 均为噪声词（英文大小写不敏感）
///
/// 空行（trim 后为空）不是噪声行。
pub fn is_noise_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }

    if URL_PATTERN.is_match(trimmed) {
        return true;
    }
    if TIME_PATTERN.is_match(trimmed)
        || DATE_PATTERN.is_match(trimmed)
        || DATETIME_PATTERN.is_match(trimmed)
    {
        return true;
    }
    if BATTERY_PATTERN.is_match(trimmed) {
        return true;
    }

    let tokens: Vec<&str> = trimmed.split_whitespace().collect();
    if tokens.is_empty() {
        return false;
    }
    for token in tokens {
        let lower = token.to_lowercase();
        if !NOISE_WORDS_LOWER.contains(&lower) {
            return false;
        }
    }
    true
}

/// 判断一行文本是否为短行（参与合并）。
/// 短行定义：trim 后非空、长度 ≤15、不含句末标点（。？！.?!）。
pub fn is_short_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.chars().count() > SHORT_LINE_MAX_LENGTH {
        return false;
    }
    if TERMINAL_PUNCTUATION.is_match(trimmed) {
        return false;
    }
    true
}

/// 合并连续短行：同一组连续短行合并为一行（空格连接），
/// 空行作为段落分隔保留，非短行独立成段。
pub fn merge_short_lines(lines: &[String]) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    let mut current_group: Vec<String> = Vec::new();

    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            // 空行：先刷新当前短行组，再推入空行作为段落分隔
            if !current_group.is_empty() {
                result.push(current_group.join(" "));
                current_group.clear();
            }
            result.push(String::new());
        } else if is_short_line(trimmed) {
            // 短行：加入当前组
            current_group.push(trimmed.to_string());
        } else {
            // 非短行：先刷新当前短行组，再推入该行
            if !current_group.is_empty() {
                result.push(current_group.join(" "));
                current_group.clear();
            }
            result.push(trimmed.to_string());
        }
    }
    // 刷新末尾短行组
    if !current_group.is_empty() {
        result.push(current_group.join(" "));
    }

    result
}

/// 行级去重：完全相同的非空行只保留首次出现，空行不参与去重。
pub fn deduplicate_lines(lines: &[String]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut result: Vec<String> = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            result.push(String::new());
            continue;
        }
        if seen.contains(line) {
            continue;
        }
        seen.insert(line.clone());
        result.push(line.clone());
    }
    result
}

/// 折叠连续空行：最多保留 1 个连续空行。
pub fn collapse_empty_lines(lines: &[String]) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    let mut prev_empty = false;
    for line in lines {
        let is_empty = line.trim().is_empty();
        if is_empty {
            if prev_empty {
                // 连续空行：跳过
                continue;
            }
            prev_empty = true;
            result.push(String::new());
        } else {
            prev_empty = false;
            result.push(line.clone());
        }
    }
    result
}

// ===================== OcrTextCleaner =====================

/// OcrTextCleaner：OCR 文本去噪器。
///
/// 使用方式：
///  - `OcrTextCleaner::new().clean(raw_text)`
///  - `get_ocr_text_cleaner().clean(raw_text)`（单例）
pub struct OcrTextCleaner;

impl OcrTextCleaner {
    /// 创建新的 OcrTextCleaner 实例
    pub fn new() -> Self {
        OcrTextCleaner
    }

    /// 清洗 OCR 原始文本。
    ///
    /// 处理流程：
    ///  1. 空文本 / 纯空白文本 → { cleaned_text: "", noise_score: 1 }
    ///  2. 规范化换行（\r\n / \r → \n）并拆分
    ///  3. 统计噪声行与总非空行数，计算 noise_score
    ///  4. 移除噪声行（保留空行结构作为段落分隔）
    ///  5. 合并连续短行（≤15 字且无句末标点）为一行
    ///  6. 行级去重（完全相同的行只保留首次出现）
    ///  7. 折叠连续空行（最多 1 行）
    ///  8. trim 最终文本
    pub fn clean(&self, raw_text: &str) -> CleanResult {
        // 1. 空文本 / 纯空白文本
        if raw_text.trim().is_empty() {
            return CleanResult {
                cleaned_text: String::new(),
                noise_score: 1.0,
            };
        }

        // 2. 规范化换行并拆分
        let normalized = raw_text.replace("\r\n", "\n").replace('\r', "\n");

        // 3. 统计噪声行 + 移除噪声行（一次遍历）
        let mut noise_lines: u32 = 0;
        let mut total_non_empty_lines: u32 = 0;
        let mut non_noise_lines: Vec<String> = Vec::new();

        for line in normalized.split('\n') {
            if line.trim().is_empty() {
                // 空行保留作为段落分隔
                non_noise_lines.push(String::new());
                continue;
            }
            total_non_empty_lines += 1;
            if is_noise_line(line) {
                noise_lines += 1;
            } else {
                non_noise_lines.push(line.to_string());
            }
        }

        // 全部为空行 → noise_score = 1
        let noise_score = if total_non_empty_lines == 0 {
            1.0
        } else {
            noise_lines as f64 / total_non_empty_lines as f64
        };

        // 4. 合并连续短行
        let merged = merge_short_lines(&non_noise_lines);

        // 5. 去重
        let deduped = deduplicate_lines(&merged);

        // 6. 折叠空行
        let collapsed = collapse_empty_lines(&deduped);

        // 7. trim 最终文本（去除首尾空行）
        let cleaned_text = collapsed.join("\n").trim().to_string();

        CleanResult {
            cleaned_text,
            noise_score,
        }
    }
}

impl Default for OcrTextCleaner {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单例 =====================

static CLEANER_INSTANCE: Lazy<OcrTextCleaner> = Lazy::new(OcrTextCleaner::new);

/// 获取 OcrTextCleaner 单例
pub fn get_ocr_text_cleaner() -> &'static OcrTextCleaner {
    &CLEANER_INSTANCE
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_input() {
        let cleaner = OcrTextCleaner::new();
        // 空字符串
        let result = cleaner.clean("");
        assert_eq!(result.cleaned_text, "");
        assert_eq!(result.noise_score, 1.0);

        // 纯空白
        let result2 = cleaner.clean("   \n  \n  ");
        assert_eq!(result2.cleaned_text, "");
        assert_eq!(result2.noise_score, 1.0);
    }

    #[test]
    fn test_url_noise() {
        let cleaner = OcrTextCleaner::new();
        let result = cleaner.clean("https://example.com\nHello world");
        assert_eq!(result.cleaned_text, "Hello world");
        assert!((result.noise_score - 0.5).abs() < 1e-9);
    }

    #[test]
    fn test_time_noise() {
        let cleaner = OcrTextCleaner::new();
        // 24 小时制时间
        let result = cleaner.clean("14:30\nMeeting at noon");
        assert_eq!(result.cleaned_text, "Meeting at noon");
        assert!((result.noise_score - 0.5).abs() < 1e-9);

        // 带 AM/PM 前缀
        assert!(is_noise_line("AM 09:30"));
        assert!(is_noise_line("下午 3:00"));
    }

    #[test]
    fn test_short_line_merge() {
        let cleaner = OcrTextCleaner::new();
        // 两个短行合并，长行独立
        let result = cleaner.clean("Hello\nWorld\nThis is a longer line that stays");
        assert_eq!(
            result.cleaned_text,
            "Hello World\nThis is a longer line that stays"
        );
    }

    #[test]
    fn test_dedup() {
        let cleaner = OcrTextCleaner::new();
        let result = cleaner.clean("Duplicate line here\nDuplicate line here\nUnique line");
        assert_eq!(result.cleaned_text, "Duplicate line here\nUnique line");
    }

    #[test]
    fn test_chinese_menu_words() {
        let cleaner = OcrTextCleaner::new();
        let result = cleaner.clean("文件\n编辑\n视图\n这是正文内容");
        assert_eq!(result.cleaned_text, "这是正文内容");
        assert!((result.noise_score - 0.75).abs() < 1e-9);
    }

    #[test]
    fn test_battery_and_date_noise() {
        // 电池百分比
        assert!(is_noise_line("100%"));
        assert!(is_noise_line("50%"));
        assert!(!is_noise_line("100"));

        // 日期
        assert!(is_noise_line("2024-01-15"));
        assert!(is_noise_line("2024/1/5"));

        // 日期时间
        assert!(is_noise_line("2024-12-31 23:59"));
        assert!(is_noise_line("2024/1/5 08:00:00"));
    }

    #[test]
    fn test_english_button_words_case_insensitive() {
        // 英文按钮词大小写不敏感
        assert!(is_noise_line("OK"));
        assert!(is_noise_line("ok"));
        assert!(is_noise_line("Cancel"));
        assert!(is_noise_line("CANCEL"));
        // 混合多个噪声词
        assert!(is_noise_line("OK Cancel"));
        assert!(!is_noise_line("OK something"));
    }
}
