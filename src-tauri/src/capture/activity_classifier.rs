//! ActivityClassifier：活动类型识别器（对应 electron/capture/ActivityClassifier.ts）
//!
//! 基于 appName / windowTitle / ocrText 推断用户当前的活动类型。
//!
//! 分类策略（应用名优先 → 窗口标题增强 → OCR 文本模式验证）：
//!  - 应用名优先：VS Code→coding 候选，微信/飞书/Slack→chatting 候选，Chrome/Edge→browsing 候选
//!  - 窗口标题增强：文件扩展名、文档名、URL、会议/群聊关键词等
//!  - OCR 文本模式验证：代码关键词、对话气泡（短行+时间戳）、段落结构（长段落）等
//!
//! 置信度计算：每个候选类型有 3 条规则（app / title / ocr），
//!   confidence = 匹配规则数 / 3；取所有候选中最高分；
//!   若最高分 ≥ 0.6 则赋该类型，否则返回 'idle'。
//!   并列时优先 app 命中的类型（应用名优先原则）。

use regex::Regex;

use crate::models::{ActivityType, OcrBlock};

/// 置信度阈值：≥ 此值才赋具体活动类型，否则 idle
pub const CONFIDENCE_THRESHOLD: f64 = 0.6;

/// 每个候选类型的规则总数（app / title / ocr 各一条）
pub const RULES_PER_TYPE: usize = 3;

/// 分类输入：与 WorkSegment 的关键字段对齐
#[derive(Debug, Clone, Default)]
pub struct ActivitySegmentInput {
    /// 应用名
    pub app_name: String,
    /// 窗口标题
    pub window_title: String,
    /// OCR 文本
    pub ocr_text: String,
    /// OCR 文本块
    pub ocr_blocks: Vec<OcrBlock>,
}

/// 分类输出
#[derive(Debug, Clone)]
pub struct ActivityClassification {
    /// 活动类型
    pub activity_type: ActivityType,
    /// 置信度 0-1
    pub confidence: f64,
}

/// 保留两位小数
fn round2(n: f64) -> f64 {
    let clamped = n.max(0.0).min(1.0);
    (clamped * 100.0).round() / 100.0
}

/// 判断文本中是否存在长行（≥ 40 字符）
fn has_long_line(text: &str) -> bool {
    text.lines().any(|l| l.trim().len() >= 40)
}

/// 候选活动类型规则集
struct ActivityRuleSet {
    /// 应用名小写包含匹配关键词
    app_keywords: &'static [&'static str],
    /// 窗口标题正则匹配（静态引用，无需 clone）
    title_patterns: Vec<&'static Regex>,
    /// OCR 文本模式验证函数
    ocr_match: fn(text: &str, blocks: &[OcrBlock]) -> bool,
}

// ===================== 通用正则 =====================

use std::sync::OnceLock;

/// 代码文件扩展名
fn code_file_ext_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)\.(ts|tsx|js|jsx|mjs|cjs|py|java|kt|scala|go|rs|c|cpp|cc|cxx|h|hpp|hxx|rb|php|swift|clj|ex|exs|erl|hs|ml|lua|pl|sh|bash|zsh|ps1|sql|vue|svelte|astro|html|htm|css|scss|sass|less|json|yaml|yml|toml|ini|xml|gradle|csproj|cs|fs|fsx)\b").unwrap()
    })
}

/// 代码关键词
fn code_keyword_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"\b(function|class|import|export|const|let|var|def|return|public|private|protected|void|interface|extends|implements|async|await|namespace|struct|enum|package|require|module|func|fn|typedef|new|throw|try|catch|finally|elif|endif|endfunc|endclass)\b").unwrap()
    })
}

/// 代码符号特征
fn code_symbol_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"=>|#(include|define|pragma|import|ifndef|ifdef)|;\s*$").unwrap())
}

/// 文档扩展名
fn doc_file_ext_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)\.(docx?|md|markdown|txt|rtf|pages|odt|tex|rst|org)\b").unwrap()
    })
}

/// 长段落特征
fn long_paragraph_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"[。！？.!?].{15,}[。！？.!?]").unwrap())
}

/// 阅读材料扩展名
fn reading_file_ext_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)\.(pdf|epub|mobi|azw3?|djvu?|cbz|cbr)\b").unwrap())
}

/// 页码特征
fn page_number_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(\b\d+\s*[/／]\s*\d+\b)|(第\s*\d+\s*页)").unwrap())
}

/// URL 特征
fn url_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)https?://").unwrap())
}

/// 浏览器标题后缀
fn browser_title_suffix_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i) - (google chrome|microsoft edge|mozilla firefox|firefox|safari|brave|opera|vivaldi|arc|chromium)\s*$").unwrap()
    })
}

/// 顶级域名片段
fn tld_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)\.(com|org|net|cn|io|dev|edu|gov|info|biz|co)\b").unwrap())
}

/// 浏览器常见 UI 词
fn browser_ui_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(搜索|search|登录|login|sign in|注册|首页|home|导航|navigation|收藏|bookmark|刷新|refresh|后退|back|前进|forward)").unwrap()
    })
}

/// 聊天时间戳
fn chat_timestamp_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\b\d{1,2}:\d{2}\b").unwrap())
}

/// 聊天"姓名:消息"特征
fn chat_name_colon_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"[\u4e00-\u9fff\w]{1,12}\s*[:：]\s*[\u4e00-\u9fff\w]").unwrap()
    })
}

/// 聊天动作词
fn chat_action_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(发送|回复|转发|表情|语音|视频通话|在线|离线|已读|未读|输入中|send|reply|forward|emoji)").unwrap()
    })
}

/// 聊天表情占位
fn chat_emoji_placeholder_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\[[^\]\n]{1,8}\]").unwrap())
}

/// 设计工具 UI 词
fn design_ui_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(工具|图层|layer|canvas|画布|画板|artboard|对齐|align|描边|stroke|填充|fill|矢量|vector|组件|component|蒙版|mask)").unwrap()
    })
}

/// 设计尺寸/单位
fn design_unit_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)\b\d+(\.\d+)?\s*(px|mm|cm|pt|vw|vh|em|rem)\b").unwrap())
}

/// 颜色值
fn color_value_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(#[0-9a-fA-F]{6}\b)|(\b(rgb|hsl)\s*\()").unwrap())
}

/// 设计文件扩展名
fn design_file_ext_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)\.(fig|sketch|psd|ai|xd|indd|ase|afdesign|clip)\b").unwrap())
}

/// 会议控制词
fn meeting_control_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(静音|取消静音|mute|unmute|共享屏幕|share screen|参会者|participants|摄像头|camera|麦克风|microphone|mic|举手|hand raise|离开会议|leave|结束会议|end meeting|邀请|invite)").unwrap()
    })
}

/// 会议计时器
fn meeting_timer_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\b\d{1,2}:\d{2}:\d{2}\b").unwrap())
}

/// 文件管理动作词
fn file_action_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(文件夹|目录|新建文件夹|复制|粘贴|删除|重命名|属性|files|folder|new folder|copy|paste|delete|rename|properties|移动|剪切)").unwrap()
    })
}

/// 文件大小
fn file_size_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)\b\d+(\.\d+)?\s*(KB|MB|GB|TB|字节|byte)\b").unwrap())
}

/// Windows 路径
fn windows_path_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\b[A-Za-z]:[\\/]").unwrap())
}

/// Unix 路径
fn unix_path_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"/(home|Users|usr|etc|var|opt|tmp)\b").unwrap())
}

/// git 标题模式
fn git_title_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)\bgit\b").unwrap())
}

/// git 操作词
fn git_op_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)\b(branch|commit|pull request|merge|rebase|stash|diff|conflict)\b").unwrap()
    })
}

/// 设计标题模式
fn design_title_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(untitled|artboard|layer|canvas|画板|图层|画布|设计)").unwrap()
    })
}

/// 会议标题模式
fn meeting_title_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)(会议|meeting|conference|通话|call|webinar|研讨会)").unwrap())
}

/// 会议应用标题模式
fn meeting_app_title_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(zoom|teams|webex|腾讯会议|钉钉会议|飞书会议|google meet)").unwrap()
    })
}

/// 聊天标题模式
fn chat_title_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(聊天|群|消息|会话|chat|channel|direct message|\bdm\b|群聊)").unwrap()
    })
}

/// 聊天应用标题模式
fn chat_app_title_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)(微信|飞书|slack|discord|telegram|钉钉|qq)").unwrap())
}

/// 文档标题模式
fn doc_title_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(文档|笔记|日记|草稿|大纲|memo|note|journal|draft)").unwrap()
    })
}

/// 阅读标题模式
fn reading_title_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)(阅读模式|reader mode|pdf)").unwrap())
}

/// 文件管理标题模式
fn file_mgr_title_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(文件夹|目录|files|folder|settings|设置|控制面板|任务管理器|system preferences|终端|terminal|资源管理器)").unwrap()
    })
}

// ===================== OCR 验证函数 =====================

fn coding_ocr_match(text: &str, _blocks: &[OcrBlock]) -> bool {
    code_keyword_regex().is_match(text)
        || code_symbol_regex().is_match(text)
        || Regex::new(r"\bfunction\s*\(").unwrap().is_match(text)
}

fn designing_ocr_match(text: &str, _blocks: &[OcrBlock]) -> bool {
    design_ui_regex().is_match(text)
        || design_unit_regex().is_match(text)
        || color_value_regex().is_match(text)
}

fn meeting_ocr_match(text: &str, _blocks: &[OcrBlock]) -> bool {
    meeting_control_regex().is_match(text) || meeting_timer_regex().is_match(text)
}

fn chatting_ocr_match(text: &str, blocks: &[OcrBlock]) -> bool {
    let pattern_hit = chat_timestamp_regex().is_match(text)
        || chat_name_colon_regex().is_match(text)
        || chat_action_regex().is_match(text)
        || chat_emoji_placeholder_regex().is_match(text);
    if pattern_hit {
        return true;
    }
    // 对话气泡结构：多个短文本块
    if blocks.len() >= 4 {
        let short_count = blocks.iter().filter(|b| b.text.trim().len() < 15).count();
        let short_ratio = short_count as f64 / blocks.len() as f64;
        return short_ratio >= 0.5;
    }
    let lines: Vec<&str> = text.lines().filter(|l| l.trim().len() > 0).collect();
    if lines.len() >= 4 {
        let short_count = lines.iter().filter(|l| l.trim().len() < 15).count();
        let short_ratio = short_count as f64 / lines.len() as f64;
        return short_ratio >= 0.6;
    }
    false
}

fn writing_ocr_match(text: &str, _blocks: &[OcrBlock]) -> bool {
    long_paragraph_regex().is_match(text) || has_long_line(text)
}

fn reading_ocr_match(text: &str, _blocks: &[OcrBlock]) -> bool {
    page_number_regex().is_match(text)
        || (long_paragraph_regex().is_match(text) && has_long_line(text))
}

fn browsing_ocr_match(text: &str, _blocks: &[OcrBlock]) -> bool {
    url_regex().is_match(text) || browser_ui_regex().is_match(text) || tld_regex().is_match(text)
}

fn managing_ocr_match(text: &str, _blocks: &[OcrBlock]) -> bool {
    file_action_regex().is_match(text)
        || file_size_regex().is_match(text)
        || windows_path_regex().is_match(text)
        || unix_path_regex().is_match(text)
}

// ===================== 规则集 =====================

/// coding 规则集
fn coding_rules() -> ActivityRuleSet {
    ActivityRuleSet {
        app_keywords: &[
            "visual studio code", "vscode", "code", "cursor", "sublime", "neovim",
            "nvim", "vim", "emacs", "atom", "eclipse", "intellij", "idea",
            "webstorm", "goland", "pycharm", "rubymine", "phpstorm", "android studio",
            "xcode", "visual studio", "netbeans", "fleet", "zed", "helix", "textmate",
            "code - oss", "vscodium",
        ],
        title_patterns: vec![code_file_ext_regex(), git_title_regex(), git_op_regex()],
        ocr_match: coding_ocr_match,
    }
}

/// designing 规则集
fn designing_rules() -> ActivityRuleSet {
    ActivityRuleSet {
        app_keywords: &[
            "figma", "sketch", "photoshop", "illustrator", "blender", "adobe xd",
            "affinity", "coreldraw", "indesign", "after effects", "premiere",
            "canva", "framer", "principle", "procreate", "gimp", "inkscape",
            "cinema 4d", "c4d", "lightroom", "davinci",
        ],
        title_patterns: vec![design_title_regex(), design_file_ext_regex()],
        ocr_match: designing_ocr_match,
    }
}

/// meeting 规则集
fn meeting_rules() -> ActivityRuleSet {
    ActivityRuleSet {
        app_keywords: &[
            "zoom", "腾讯会议", "tencent meeting", "google meet", "meet",
            "webex", "gotomeeting", "钉钉会议", "飞书会议", "lark meeting",
            "teams", "微软会议", "voov", "skype for business",
        ],
        title_patterns: vec![meeting_title_regex(), meeting_app_title_regex()],
        ocr_match: meeting_ocr_match,
    }
}

/// chatting 规则集
fn chatting_rules() -> ActivityRuleSet {
    ActivityRuleSet {
        app_keywords: &[
            "微信", "wechat", "飞书", "lark", "slack", "discord", "telegram",
            "qq", "钉钉", "dingtalk", "skype", "whatsapp", "signal", "imessage",
            "messages", "line", "企业微信", "tim",
        ],
        title_patterns: vec![chat_title_regex(), chat_app_title_regex()],
        ocr_match: chatting_ocr_match,
    }
}

/// writing 规则集
fn writing_rules() -> ActivityRuleSet {
    ActivityRuleSet {
        app_keywords: &[
            "word", "winword", "wps", "notion", "obsidian", "typora", "markdown",
            "pages", "google docs", "onedrive", "onenote", "evernote", "印象笔记",
            "有道云笔记", "语雀", "腾讯文档", "石墨文档", "bear", "ulysses",
            "scrivener", "ia writer", "marktext", "zettlr", "飞书文档",
        ],
        title_patterns: vec![doc_file_ext_regex(), doc_title_regex()],
        ocr_match: writing_ocr_match,
    }
}

/// reading 规则集
fn reading_rules() -> ActivityRuleSet {
    ActivityRuleSet {
        app_keywords: &[
            "acrobat", "foxit", "pdf", "calibre", "kindle", "preview", "预览",
            "阅读器", "books", "adobe reader", "sumatrapdf", "pdfexpert", "pdfpen",
            "zotero", "mendeley", "wps pdf", "福昕", "edge pdf",
        ],
        title_patterns: vec![reading_file_ext_regex(), reading_title_regex()],
        ocr_match: reading_ocr_match,
    }
}

/// browsing 规则集
fn browsing_rules() -> ActivityRuleSet {
    ActivityRuleSet {
        app_keywords: &[
            "chrome", "edge", "firefox", "safari", "brave", "opera", "vivaldi",
            "arc", "chromium", "duckduckgo", "maxthon", "360se", "360浏览器",
            "猎豹", "qq浏览器", "搜狗浏览器", "uc浏览器", "yandex", "tor browser",
        ],
        title_patterns: vec![url_regex(), browser_title_suffix_regex(), tld_regex()],
        ocr_match: browsing_ocr_match,
    }
}

/// managing 规则集
fn managing_rules() -> ActivityRuleSet {
    ActivityRuleSet {
        app_keywords: &[
            "explorer", "文件资源管理器", "finder", "访达", "settings", "设置",
            "控制面板", "control panel", "task manager", "任务管理器",
            "system preferences", "系统偏好", "terminal", "终端", "powershell",
            "cmd", "registry", "注册表", "活动监视器", "activity monitor",
            "nautilus", "thunar", "dolphin", "系统设置",
        ],
        title_patterns: vec![file_mgr_title_regex()],
        ocr_match: managing_ocr_match,
    }
}

/// 候选类型迭代顺序（并列时靠前者优先，已将更专用的工具类前置）
const TYPE_ORDER: &[ActivityType] = &[
    ActivityType::Coding,
    ActivityType::Designing,
    ActivityType::Meeting,
    ActivityType::Chatting,
    ActivityType::Writing,
    ActivityType::Reading,
    ActivityType::Browsing,
    ActivityType::Managing,
];

/// 获取指定活动类型的规则集
fn get_rule_set(t: &ActivityType) -> Option<ActivityRuleSet> {
    match t {
        ActivityType::Coding => Some(coding_rules()),
        ActivityType::Designing => Some(designing_rules()),
        ActivityType::Meeting => Some(meeting_rules()),
        ActivityType::Chatting => Some(chatting_rules()),
        ActivityType::Writing => Some(writing_rules()),
        ActivityType::Reading => Some(reading_rules()),
        ActivityType::Browsing => Some(browsing_rules()),
        ActivityType::Managing => Some(managing_rules()),
        _ => None,
    }
}

/// ActivityClassifier：活动类型识别器。
pub struct ActivityClassifier;

impl ActivityClassifier {
    /// 推断单个 segment 的活动类型。
    ///
    /// 置信度不足时 activityType=idle。
    pub fn classify_activity(segment: &ActivitySegmentInput) -> ActivityClassification {
        let app_name = segment.app_name.to_lowercase();
        let window_title = &segment.window_title;
        let ocr_text = &segment.ocr_text;
        let blocks = &segment.ocr_blocks;

        // ocrText 为空时从 blocks 聚合
        let effective_ocr_text = if ocr_text.trim().len() > 0 {
            ocr_text.clone()
        } else {
            blocks.iter().map(|b| b.text.as_str()).collect::<Vec<_>>().join("\n")
        };

        let mut best_type = ActivityType::Idle;
        let mut best_score: f64 = 0.0;
        let mut best_app_matched = false;

        for t in TYPE_ORDER {
            let rules = match get_rule_set(t) {
                Some(r) => r,
                None => continue,
            };
            let app_matched = rules.app_keywords.iter().any(|k| app_name.contains(k));
            let title_matched = rules.title_patterns.iter().any(|p| p.is_match(window_title));
            let ocr_matched = (rules.ocr_match)(&effective_ocr_text, blocks);
            let matched = (app_matched as usize) + (title_matched as usize) + (ocr_matched as usize);
            let score = matched as f64 / RULES_PER_TYPE as f64;

            // 取最高分；并列时 app 命中者优先；再并列则迭代顺序靠前者优先
            if score > best_score || (score == best_score && app_matched && !best_app_matched) {
                best_type = t.clone();
                best_score = score;
                best_app_matched = app_matched;
            }
        }

        let confidence = round2(best_score);
        if confidence >= CONFIDENCE_THRESHOLD {
            ActivityClassification {
                activity_type: best_type,
                confidence,
            }
        } else {
            ActivityClassification {
                activity_type: ActivityType::Idle,
                confidence,
            }
        }
    }
}

impl Default for ActivityClassifier {
    fn default() -> Self {
        Self
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_coding_by_app() {
        let segment = ActivitySegmentInput {
            app_name: "Visual Studio Code".to_string(),
            window_title: "main.rs - myproject".to_string(),
            ocr_text: "fn main() { let x = 1; }".to_string(),
            ocr_blocks: vec![],
        };
        let result = ActivityClassifier::classify_activity(&segment);
        assert_eq!(result.activity_type, ActivityType::Coding);
        assert!(result.confidence >= CONFIDENCE_THRESHOLD);
    }

    #[test]
    fn test_classify_chatting_by_app() {
        let segment = ActivitySegmentInput {
            app_name: "微信".to_string(),
            window_title: "工作群".to_string(),
            ocr_text: "张三: 明天开会\n10:30".to_string(),
            ocr_blocks: vec![],
        };
        let result = ActivityClassifier::classify_activity(&segment);
        assert_eq!(result.activity_type, ActivityType::Chatting);
    }

    #[test]
    fn test_classify_browsing_by_app() {
        let segment = ActivitySegmentInput {
            app_name: "Chrome".to_string(),
            window_title: "GitHub - https://github.com".to_string(),
            ocr_text: "搜索 login".to_string(),
            ocr_blocks: vec![],
        };
        let result = ActivityClassifier::classify_activity(&segment);
        assert_eq!(result.activity_type, ActivityType::Browsing);
    }

    #[test]
    fn test_classify_idle_when_low_confidence() {
        let segment = ActivitySegmentInput {
            app_name: "unknownapp".to_string(),
            window_title: "unknown".to_string(),
            ocr_text: "hello".to_string(),
            ocr_blocks: vec![],
        };
        let result = ActivityClassifier::classify_activity(&segment);
        assert_eq!(result.activity_type, ActivityType::Idle);
        assert!(result.confidence < CONFIDENCE_THRESHOLD);
    }

    #[test]
    fn test_classify_meeting_by_app() {
        let segment = ActivitySegmentInput {
            app_name: "Zoom".to_string(),
            window_title: "团队周会".to_string(),
            ocr_text: "静音 共享屏幕 参会者".to_string(),
            ocr_blocks: vec![],
        };
        let result = ActivityClassifier::classify_activity(&segment);
        assert_eq!(result.activity_type, ActivityType::Meeting);
    }

    #[test]
    fn test_classify_writing_by_app() {
        let segment = ActivitySegmentInput {
            app_name: "Word".to_string(),
            window_title: "report.docx".to_string(),
            ocr_text: "这是一段很长的文本内容用于测试写作识别功能是否能够正确识别出长段落特征。".to_string(),
            ocr_blocks: vec![],
        };
        let result = ActivityClassifier::classify_activity(&segment);
        assert_eq!(result.activity_type, ActivityType::Writing);
    }

    #[test]
    fn test_classify_designing_by_app() {
        let segment = ActivitySegmentInput {
            app_name: "Figma".to_string(),
            window_title: "设计稿".to_string(),
            ocr_text: "layer canvas #FF0000 12px".to_string(),
            ocr_blocks: vec![],
        };
        let result = ActivityClassifier::classify_activity(&segment);
        assert_eq!(result.activity_type, ActivityType::Designing);
    }
}
