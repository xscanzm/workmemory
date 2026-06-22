//! ContentClassifier：内容类型分类器（对应 electron/capture/ContentClassifier.ts）
//!
//! 识别屏幕内容类型（chat/webpage/document/code/video/forum/product/other）
//! 并提取类型特定结构化数据。
//!
//! 分类策略（应用名优先 → 窗口标题增强 → OCR 文本模式验证）：
//!  - 应用名优先：微信/飞书/Slack → chat 候选，Chrome/Edge → webpage 候选
//!  - 窗口标题增强：URL/标题特征、文件扩展名、平台名等
//!  - OCR 文本模式验证：对话气泡、价格模式、播放控件、帖子列表等
//!
//! 置信度计算：每个候选类型有 3 条规则（app / title / ocr），
//!   confidence = 匹配规则数 / 3；取所有候选中最高分；
//!   若最高分 ≥ 0.5 则赋该类型，否则返回 'other'。
//!   并列时优先 app 命中的类型（应用名优先原则）。

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Value};

use crate::models::{ContentType, OcrBlock};

/// 置信度阈值：≥ 此值才赋具体内容类型，否则 other
pub const CONFIDENCE_THRESHOLD: f64 = 0.5;

/// 每个候选类型的规则总数（app / title / ocr 各一条）
pub const RULES_PER_TYPE: usize = 3;

/// 分类输入：与 WorkSegment 的关键字段对齐
#[derive(Debug, Clone, Default)]
pub struct ContentSegmentInput {
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
pub struct ContentClassification {
    /// 内容类型
    pub content_type: ContentType,
    /// 结构化数据
    pub content_data: Value,
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

// ===================== 通用正则 =====================

fn url_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r#"(?i)https?://[^\s<>"'，。、；：！？）】}]+"#).unwrap())
}

fn browser_title_suffix_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i) - (google chrome|microsoft edge|mozilla firefox|firefox|safari|brave|opera|vivaldi|arc|chromium)\s*$").unwrap()
    })
}

fn tld_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)\.(com|org|net|cn|io|dev|edu|gov|info|biz|co)\b").unwrap())
}

fn browser_ui_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(搜索|search|登录|login|sign in|注册|首页|home|导航|navigation|收藏|bookmark|刷新|refresh|后退|back|前进|forward)").unwrap()
    })
}

fn code_file_ext_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)\.(ts|tsx|js|jsx|mjs|cjs|py|java|kt|scala|go|rs|c|cpp|cc|cxx|h|hpp|hxx|rb|php|swift|clj|ex|exs|erl|hs|ml|lua|pl|sh|bash|zsh|ps1|sql|vue|svelte|astro|html|htm|css|scss|sass|less|json|yaml|yml|toml|ini|xml|gradle|csproj|cs|fs|fsx)\b").unwrap()
    })
}

fn code_keyword_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"\b(function|class|import|export|const|let|var|def|return|public|private|protected|void|interface|extends|implements|async|await|namespace|struct|enum|package|require|module|func|fn|typedef|new|throw|try|catch|finally|elif|endif|endfunc|endclass)\b").unwrap()
    })
}

fn code_symbol_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"=>|#(include|define|pragma|import|ifndef|ifdef)|;\s*$").unwrap())
}

fn doc_file_ext_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)\.(docx?|md|markdown|txt|rtf|pages|odt|tex|rst|org|pdf|epub|mobi)\b").unwrap()
    })
}

fn long_paragraph_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"[。！？.!?].{15,}[。！？.!?]").unwrap())
}

fn chat_timestamp_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\b\d{1,2}:\d{2}\b").unwrap())
}

fn chat_name_colon_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"[\u4e00-\u9fff\w]{1,12}\s*[:：]\s*[\u4e00-\u9fff\w]").unwrap()
    })
}

fn chat_action_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(发送|回复|转发|表情|语音|视频通话|在线|离线|已读|未读|输入中|send|reply|forward|emoji)").unwrap()
    })
}

fn chat_emoji_placeholder_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\[[^\]\n]{1,8}\]").unwrap())
}

fn video_control_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(播放|暂停|play|pause|下一个|next|倍速|speed|画质|quality|全屏|fullscreen|弹幕|danmaku|字幕|subtitle|cc)").unwrap()
    })
}

fn video_progress_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"\b\d{1,2}:\d{2}(:\d{2})?\s*[/／]\s*\d{1,2}:\d{2}(:\d{2})?\b").unwrap()
    })
}

fn video_danmaku_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)(弹幕|danmaku|bili|哔哩|三连|投币|收藏|点赞)").unwrap())
}

fn forum_list_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(回复|reply|查看|view|浏览|主题|topic|帖子|post|板块|节点|node|楼主|板凳|沙发)").unwrap()
    })
}

fn forum_post_meta_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(@[\u4e00-\u9fff\w]+|\d+\s*(回复|reply|评论|comment|查看|view|浏览))").unwrap()
    })
}

fn product_price_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"[¥￥$]\s*\d{1,3}(,\d{3})*(\.\d+)?").unwrap())
}

fn product_ui_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(加入购物车|立即购买|加入心愿单|add to cart|buy now|add to wishlist|收藏|评价|评论|月销|已售|销量|库存|发货|包邮|正品)").unwrap()
    })
}

fn chat_key_message_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(需求|问题|会议|明天|今天|紧急|重要|todo|任务|项目|deadline|urgent|important|meeting|today|tomorrow|上线|发布|修复|bug)").unwrap()
    })
}

fn git_title_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)\bgit\b").unwrap())
}

fn git_op_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)\b(branch|commit|pull request|merge|rebase|stash|diff|conflict)\b").unwrap()
    })
}

fn chat_title_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(聊天|群|消息|会话|chat|channel|direct message|\bdm\b|群聊)").unwrap()
    })
}

fn chat_app_title_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)(微信|飞书|slack|discord|telegram|钉钉|qq)").unwrap())
}

fn video_title_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(视频|video|播放|player|movie|电影|剧集|番剧|直播|live|bilibili|youtube|netflix|优酷|爱奇艺|腾讯视频)").unwrap()
    })
}

fn forum_title_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(帖子|主题|thread|post|板块|节点|node|讨论区|社区|forum|reddit|v2ex|掘金|知乎|贴吧)").unwrap()
    })
}

fn product_title_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(商品|详情|product|item|shop|店铺|购物车|cart|淘宝|京东|亚马逊|拼多多|天猫)").unwrap()
    })
}

fn doc_title_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(文档|笔记|日记|草稿|大纲|memo|note|journal|draft|阅读模式|reader mode)").unwrap()
    })
}

// ===================== 应用名 → 平台映射 =====================

/// 聊天应用 → 平台名（长键优先匹配）
fn chat_app_platform() -> &'static [(&'static str, &'static str)] {
    static M: OnceLock<Vec<(&'static str, &'static str)>> = OnceLock::new();
    M.get_or_init(|| vec![
        ("企业微信", "wechat-work"),
        ("微信", "wechat"), ("wechat", "wechat"),
        ("飞书", "lark"), ("lark", "lark"),
        ("slack", "slack"), ("discord", "discord"), ("telegram", "telegram"),
        ("钉钉", "dingtalk"), ("dingtalk", "dingtalk"),
        ("qq", "qq"), ("tim", "qq"),
        ("skype", "skype"), ("whatsapp", "whatsapp"), ("signal", "signal"),
        ("imessage", "imessage"), ("messages", "imessage"), ("line", "line"),
    ])
}

/// 视频应用 → 平台名
fn video_app_platform() -> &'static [(&'static str, &'static str)] {
    static M: OnceLock<Vec<(&'static str, &'static str)>> = OnceLock::new();
    M.get_or_init(|| vec![
        ("哔哩哔哩", "bilibili"), ("bilibili", "bilibili"), ("哔哩", "bilibili"),
        ("youtube", "youtube"), ("netflix", "netflix"),
        ("腾讯视频", "tencent-video"), ("qq视频", "tencent-video"),
        ("优酷", "youku"), ("youku", "youku"),
        ("爱奇艺", "iqiyi"), ("iqiyi", "iqiyi"),
        ("potplayer", "potplayer"), ("quicktime", "quicktime"),
        ("mpc-hc", "mpc"), ("mpc-be", "mpc"), ("mpc", "mpc"),
        ("kmplayer", "kmplayer"), ("mplayer", "mplayer"),
        ("vlc", "vlc"), ("mpv", "mpv"),
        ("暴风影音", "baofeng"), ("迅雷看看", "xunlei"),
    ])
}

/// 商品应用 → 来源平台
fn product_app_source() -> &'static [(&'static str, &'static str)] {
    static M: OnceLock<Vec<(&'static str, &'static str)>> = OnceLock::new();
    M.get_or_init(|| vec![
        ("京东商城", "jd"), ("京东", "jd"), ("jd", "jd"),
        ("淘宝", "taobao"), ("taobao", "taobao"),
        ("亚马逊", "amazon"), ("amazon", "amazon"),
        ("拼多多", "pinduoduo"), ("pinduoduo", "pinduoduo"),
        ("天猫", "tmall"), ("tmall", "tmall"),
        ("苏宁", "suning"), ("suning", "suning"),
        ("唯品会", "vipshop"), ("vipshop", "vipshop"),
        ("当当", "dangdang"), ("dangdang", "dangdang"),
        ("闲鱼", "xianyu"),
    ])
}

/// 论坛应用 → 平台名
fn forum_app_platform() -> &'static [(&'static str, &'static str)] {
    static M: OnceLock<Vec<(&'static str, &'static str)>> = OnceLock::new();
    M.get_or_init(|| vec![
        ("reddit", "reddit"), ("v2ex", "v2ex"),
        ("掘金", "juejin"), ("juejin", "juejin"),
        ("知乎", "zhihu"), ("zhihu", "zhihu"),
        ("贴吧", "tieba"), ("tieba", "tieba"),
        ("hacker news", "hacker-news"), ("lobsters", "lobsters"),
        ("discourse", "discourse"), ("nodeseek", "nodeseek"),
    ])
}

/// 从 appName 推断平台名（长键优先匹配）
fn detect_platform(app_name: &str, mapping: &[(&str, &str)]) -> String {
    let lower = app_name.to_lowercase();
    for (key, value) in mapping {
        if lower.contains(&key.to_lowercase()) {
            return value.to_string();
        }
    }
    "unknown".to_string()
}

// ===================== OCR 验证函数 =====================

fn chat_ocr_match(text: &str, blocks: &[OcrBlock]) -> bool {
    let pattern_hit = chat_timestamp_regex().is_match(text)
        || chat_name_colon_regex().is_match(text)
        || chat_action_regex().is_match(text)
        || chat_emoji_placeholder_regex().is_match(text);
    if pattern_hit {
        return true;
    }
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

fn video_ocr_match(text: &str, _blocks: &[OcrBlock]) -> bool {
    video_control_regex().is_match(text)
        || video_progress_regex().is_match(text)
        || video_danmaku_regex().is_match(text)
}

fn forum_ocr_match(text: &str, _blocks: &[OcrBlock]) -> bool {
    forum_list_regex().is_match(text) || forum_post_meta_regex().is_match(text)
}

fn product_ocr_match(text: &str, _blocks: &[OcrBlock]) -> bool {
    product_price_regex().is_match(text) || product_ui_regex().is_match(text)
}

fn code_ocr_match(text: &str, _blocks: &[OcrBlock]) -> bool {
    code_keyword_regex().is_match(text)
        || code_symbol_regex().is_match(text)
        || Regex::new(r"\bfunction\s*\(").unwrap().is_match(text)
}

fn document_ocr_match(text: &str, _blocks: &[OcrBlock]) -> bool {
    long_paragraph_regex().is_match(text)
        || has_long_line(text)
        || Regex::new(r"(?i)\b(第\s*\d+\s*页|page\s+\d+)\b").unwrap().is_match(text)
}

fn webpage_ocr_match(text: &str, _blocks: &[OcrBlock]) -> bool {
    url_regex().is_match(text) || browser_ui_regex().is_match(text) || tld_regex().is_match(text)
}

// ===================== 规则集 =====================

struct ContentRuleSet {
    app_keywords: Vec<&'static str>,
    title_patterns: Vec<&'static Regex>,
    ocr_match: fn(text: &str, blocks: &[OcrBlock]) -> bool,
}

fn chat_rules() -> ContentRuleSet {
    ContentRuleSet {
        app_keywords: chat_app_platform().iter().map(|(k, _)| *k).collect(),
        title_patterns: vec![chat_title_regex(), chat_app_title_regex()],
        ocr_match: chat_ocr_match,
    }
}

fn video_rules() -> ContentRuleSet {
    ContentRuleSet {
        app_keywords: video_app_platform().iter().map(|(k, _)| *k).collect(),
        title_patterns: vec![video_title_regex()],
        ocr_match: video_ocr_match,
    }
}

fn forum_rules() -> ContentRuleSet {
    ContentRuleSet {
        app_keywords: forum_app_platform().iter().map(|(k, _)| *k).collect(),
        title_patterns: vec![forum_title_regex()],
        ocr_match: forum_ocr_match,
    }
}

fn product_rules() -> ContentRuleSet {
    ContentRuleSet {
        app_keywords: product_app_source().iter().map(|(k, _)| *k).collect(),
        title_patterns: vec![product_title_regex()],
        ocr_match: product_ocr_match,
    }
}

fn code_rules() -> ContentRuleSet {
    ContentRuleSet {
        app_keywords: vec![
            "visual studio code", "vscode", "code", "cursor", "sublime", "neovim",
            "nvim", "vim", "emacs", "atom", "eclipse", "intellij", "idea",
            "webstorm", "goland", "pycharm", "rubymine", "phpstorm", "android studio",
            "xcode", "visual studio", "netbeans", "fleet", "zed", "helix", "textmate",
            "code - oss", "vscodium",
        ],
        title_patterns: vec![code_file_ext_regex(), git_title_regex(), git_op_regex()],
        ocr_match: code_ocr_match,
    }
}

fn document_rules() -> ContentRuleSet {
    ContentRuleSet {
        app_keywords: vec![
            "word", "winword", "wps", "notion", "obsidian", "typora", "markdown",
            "pages", "google docs", "onedrive", "onenote", "evernote", "印象笔记",
            "有道云笔记", "语雀", "腾讯文档", "石墨文档", "bear", "ulysses",
            "scrivener", "ia writer", "marktext", "zettlr", "飞书文档",
            "acrobat", "foxit", "pdf", "calibre", "kindle", "preview", "预览",
            "阅读器", "books", "adobe reader", "sumatrapdf", "pdfexpert", "pdfpen",
            "zotero", "mendeley", "wps pdf", "福昕", "edge pdf",
        ],
        title_patterns: vec![doc_file_ext_regex(), doc_title_regex()],
        ocr_match: document_ocr_match,
    }
}

fn webpage_rules() -> ContentRuleSet {
    ContentRuleSet {
        app_keywords: vec![
            "chrome", "edge", "firefox", "safari", "brave", "opera", "vivaldi",
            "arc", "chromium", "duckduckgo", "maxthon", "360se", "360浏览器",
            "猎豹", "qq浏览器", "搜狗浏览器", "uc浏览器", "yandex", "tor browser",
        ],
        title_patterns: vec![url_regex(), browser_title_suffix_regex(), tld_regex()],
        ocr_match: webpage_ocr_match,
    }
}

/// 候选类型迭代顺序（并列时靠前者优先，更专用的工具类前置）
const TYPE_ORDER: &[ContentType] = &[
    ContentType::Chat,
    ContentType::Video,
    ContentType::Forum,
    ContentType::Product,
    ContentType::Code,
    ContentType::Document,
    ContentType::Webpage,
];

/// 获取指定内容类型的规则集
fn get_rule_set(t: &ContentType) -> Option<ContentRuleSet> {
    match t {
        ContentType::Chat => Some(chat_rules()),
        ContentType::Video => Some(video_rules()),
        ContentType::Forum => Some(forum_rules()),
        ContentType::Product => Some(product_rules()),
        ContentType::Code => Some(code_rules()),
        ContentType::Document => Some(document_rules()),
        ContentType::Webpage => Some(webpage_rules()),
        _ => None,
    }
}

// ===================== 结构化提取器 =====================

/// 提取聊天结构化数据
fn extract_chat_data(ocr_text: &str, blocks: &[OcrBlock], app_name: &str) -> Value {
    let text = if ocr_text.trim().len() > 0 {
        ocr_text.to_string()
    } else {
        blocks.iter().map(|b| b.text.as_str()).collect::<Vec<_>>().join("\n")
    };
    let lines: Vec<&str> = text.lines().map(|l| l.trim()).filter(|l| l.len() > 0).collect();

    // 提取参与者
    let name_colon_re = Regex::new(r"^([\u4e00-\u9fff\w]{1,12})\s*[:：]\s*").unwrap();
    let mut participants: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for line in &lines {
        if let Some(caps) = name_colon_re.captures(line) {
            let name = caps.get(1).unwrap().as_str().to_string();
            if seen.insert(name.clone()) {
                participants.push(name);
            }
        }
    }

    // 消息数：非空非纯时间戳行
    let ts_re = Regex::new(r"^\d{1,2}:\d{2}$").unwrap();
    let message_count = lines.iter().filter(|l| !ts_re.is_match(l)).count();

    // 关键消息
    let key_messages: Vec<String> = lines
        .iter()
        .filter(|l| chat_key_message_regex().is_match(l))
        .take(10)
        .map(|s| s.to_string())
        .collect();

    let platform = detect_platform(app_name, chat_app_platform());

    json!({
        "participants": participants,
        "messageCount": message_count,
        "keyMessages": key_messages,
        "platform": platform,
    })
}

/// 提取网页结构化数据
fn extract_webpage_data(window_title: &str, ocr_text: &str, blocks: &[OcrBlock]) -> Value {
    let text = if ocr_text.trim().len() > 0 {
        ocr_text.to_string()
    } else {
        blocks.iter().map(|b| b.text.as_str()).collect::<Vec<_>>().join("\n")
    };

    // 提取 URL
    let mut url = String::new();
    if let Some(m) = url_regex().find(window_title) {
        url = m.as_str().to_string();
    } else if let Some(m) = url_regex().find(&text) {
        url = m.as_str().to_string();
    }

    // 解析页面标题
    let mut page_title = window_title.to_string();
    page_title = browser_title_suffix_regex().replace(&page_title, "").to_string();
    let url_replace_re = Regex::new(r"(?i)https?://[^\s]+").unwrap();
    page_title = url_replace_re.replace_all(&page_title, "").to_string();
    let trailing_dash_re = Regex::new(r"\s*-\s*$").unwrap();
    page_title = trailing_dash_re.replace_all(&page_title, "").to_string();
    page_title = page_title.trim().to_string();

    // 提取 domain
    let mut domain = String::new();
    if !url.is_empty() {
        let host_re = Regex::new(r"(?i)^https?://([^/?#]+)").unwrap();
        if let Some(caps) = host_re.captures(&url) {
            domain = caps.get(1).unwrap().as_str().to_string();
        }
    } else if tld_regex().is_match(window_title) {
        let domain_re = Regex::new(r"(?i)([\w-]+\.(com|org|net|cn|io|dev|edu|gov|info|biz|co))").unwrap();
        if let Some(caps) = domain_re.captures(window_title) {
            domain = caps.get(1).unwrap().as_str().to_string();
        }
    }

    // 提取正文段落
    let key_paragraphs: Vec<String> = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| l.len() >= 30)
        .take(5)
        .map(|s| s.to_string())
        .collect();

    json!({
        "url": url,
        "pageTitle": page_title,
        "domain": domain,
        "keyParagraphs": key_paragraphs,
    })
}

/// 提取视频结构化数据
fn extract_video_data(window_title: &str, ocr_text: &str, blocks: &[OcrBlock], app_name: &str) -> Value {
    let text = if ocr_text.trim().len() > 0 {
        ocr_text.to_string()
    } else {
        blocks.iter().map(|b| b.text.as_str()).collect::<Vec<_>>().join("\n")
    };

    let platform = detect_platform(app_name, video_app_platform());

    // 标题：去除平台后缀
    let mut title = window_title.to_string();
    let suffix_re = Regex::new(r"(?i) - (bilibili|哔哩哔哩|youtube|netflix|优酷|爱奇艺|腾讯视频|vlc|potplayer|mpv)\s*$").unwrap();
    title = suffix_re.replace(&title, "").to_string();
    let underscore_re = Regex::new(r"(?i)_(bilibili|哔哩哔哩|youtube|netflix|优酷|爱奇艺|腾讯视频)\s*$").unwrap();
    title = underscore_re.replace(&title, "").to_string();
    let bracket_re = Regex::new(r"【[^】]*】\s*$").unwrap();
    title = bracket_re.replace(&title, "").to_string();
    title = title.trim().to_string();

    // 时长
    let mut duration = String::new();
    let progress_re = Regex::new(r"\b\d{1,2}:\d{2}(:\d{2})?\s*[/／]\s*(\d{1,2}:\d{2}(:\d{2})?)\b").unwrap();
    if let Some(caps) = progress_re.captures(&text) {
        duration = caps.get(2).unwrap().as_str().to_string();
    } else {
        let label_re = Regex::new(r"(?i)(?:时长|duration|total)[：:]\s*(\d{1,2}:\d{2}(:\d{2})?)").unwrap();
        if let Some(caps) = label_re.captures(&text) {
            duration = caps.get(1).unwrap().as_str().to_string();
        }
    }

    // 字幕
    let ts_only_re = Regex::new(r"^\d{1,2}:\d{2}(:\d{2})?$").unwrap();
    let subtitles: Vec<String> = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| {
            if l.len() < 2 || l.len() > 50 {
                return false;
            }
            if video_control_regex().is_match(l) {
                return false;
            }
            if ts_only_re.is_match(l) {
                return false;
            }
            if video_progress_regex().is_match(l) {
                return false;
            }
            true
        })
        .take(10)
        .map(|s| s.to_string())
        .collect();

    json!({
        "platform": platform,
        "title": title,
        "duration": duration,
        "subtitles": subtitles,
    })
}

/// 提取论坛结构化数据
fn extract_forum_data(window_title: &str, ocr_text: &str, blocks: &[OcrBlock]) -> Value {
    let text = if ocr_text.trim().len() > 0 {
        ocr_text.to_string()
    } else {
        blocks.iter().map(|b| b.text.as_str()).collect::<Vec<_>>().join("\n")
    };

    let suffix_re = Regex::new(r"(?i) - (reddit|v2ex|掘金|知乎|贴吧|hacker news|lobsters|discourse)\s*$").unwrap();
    let mut thread_title = suffix_re.replace(window_title, "").to_string();
    let pipe_re = Regex::new(r"(?i)\s*[|｜]\s*(reddit|v2ex|掘金|知乎|贴吧).*$").unwrap();
    thread_title = pipe_re.replace(&thread_title, "").to_string();
    thread_title = thread_title.trim().to_string();

    // 作者
    let at_re = Regex::new(r"@([\u4e00-\u9fff\w]{2,15})").unwrap();
    let label_re = Regex::new(r"(?i)(?:作者|by|来自)[：:]\s*([\u4e00-\u9fff\w]{2,15})").unwrap();
    let mut authors: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for caps in at_re.captures_iter(&text) {
        let name = caps.get(1).unwrap().as_str().to_string();
        if seen.insert(name.clone()) {
            authors.push(name);
        }
    }
    for caps in label_re.captures_iter(&text) {
        let name = caps.get(1).unwrap().as_str().to_string();
        if seen.insert(name.clone()) {
            authors.push(name);
        }
    }

    // 帖子数
    let post_meta_lines = text.lines().filter(|l| forum_post_meta_regex().is_match(l)).count();
    let posts = post_meta_lines.max(authors.len()).max(1);

    json!({
        "threadTitle": thread_title,
        "posts": posts,
        "authors": authors,
    })
}

/// 提取商品结构化数据
fn extract_product_data(window_title: &str, ocr_text: &str, blocks: &[OcrBlock], app_name: &str) -> Value {
    let text = if ocr_text.trim().len() > 0 {
        ocr_text.to_string()
    } else {
        blocks.iter().map(|b| b.text.as_str()).collect::<Vec<_>>().join("\n")
    };

    let suffix_re = Regex::new(r"(?i) - (淘宝|京东|天猫|拼多多|亚马逊|amazon|taobao|jd|tmall|pinduoduo)\s*$").unwrap();
    let mut name = suffix_re.replace(window_title, "").to_string();
    let pipe_re = Regex::new(r"(?i)\s*[|｜]\s*(淘宝|京东|天猫|拼多多|亚马逊).*$").unwrap();
    name = pipe_re.replace(&name, "").to_string();
    name = name.trim().to_string();

    let mut price = String::new();
    if let Some(m) = product_price_regex().find(&text) {
        price = m.as_str().replace(|c: char| c.is_whitespace(), "");
    }

    let source = detect_platform(app_name, product_app_source());

    json!({
        "name": name,
        "price": price,
        "source": source,
    })
}

/// 提取文档结构化数据
fn extract_document_data(window_title: &str, ocr_text: &str) -> Value {
    let paragraphs: Vec<String> = ocr_text
        .lines()
        .map(|l| l.trim())
        .filter(|l| l.len() >= 20)
        .take(10)
        .map(|s| s.to_string())
        .collect();
    json!({
        "title": window_title,
        "paragraphs": paragraphs,
    })
}

/// 提取代码结构化数据
fn extract_code_data(window_title: &str, ocr_text: &str) -> Value {
    let ext_re = Regex::new(r"(?i)([\w\u4e00-\u9fff.-]+\.(ts|tsx|js|jsx|mjs|cjs|py|java|kt|scala|go|rs|c|cpp|cc|cxx|h|hpp|hxx|rb|php|swift|vue|svelte|astro|html|htm|css|scss|sass|less|json|yaml|yml|toml|xml|sh|bash|zsh|ps1|sql|md|markdown))").unwrap();
    let file_name = if let Some(caps) = ext_re.captures(window_title) {
        caps.get(1).unwrap().as_str().to_string()
    } else {
        window_title.to_string()
    };

    let mut language = "unknown".to_string();
    if let Some(ext) = ext_re.captures(window_title).and_then(|c| c.get(2)) {
        let ext_lower = ext.as_str().to_lowercase();
        language = match ext_lower.as_str() {
            "ts" | "tsx" => "typescript",
            "js" | "jsx" | "mjs" | "cjs" => "javascript",
            "py" => "python",
            "java" => "java",
            "kt" => "kotlin",
            "scala" => "scala",
            "go" => "go",
            "rs" => "rust",
            "c" => "c",
            "cpp" | "cc" | "cxx" => "cpp",
            "h" => "c",
            "hpp" | "hxx" => "cpp",
            "rb" => "ruby",
            "php" => "php",
            "swift" => "swift",
            "vue" => "vue",
            "svelte" => "svelte",
            "astro" => "astro",
            "html" | "htm" => "html",
            "css" => "css",
            "scss" => "scss",
            "sass" => "sass",
            "less" => "less",
            "json" => "json",
            "yaml" | "yml" => "yaml",
            "toml" => "toml",
            "xml" => "xml",
            "sh" | "bash" | "zsh" => "shell",
            "ps1" => "powershell",
            "sql" => "sql",
            "md" | "markdown" => "markdown",
            _ => "unknown",
        }.to_string();
    } else if Regex::new(r"\bdef\s+\w+\s*\(").unwrap().is_match(ocr_text) {
        language = "python".to_string();
    } else if Regex::new(r"\bfunc\s+\w+").unwrap().is_match(ocr_text) {
        language = "go".to_string();
    } else if Regex::new(r"\bfn\s+\w+").unwrap().is_match(ocr_text) {
        language = "rust".to_string();
    } else if Regex::new(r"\bpublic\s+(class|static)\b").unwrap().is_match(ocr_text) {
        language = "java".to_string();
    }

    json!({
        "fileName": file_name,
        "language": language,
    })
}

/// 根据类型调用对应提取器
fn extract_data_for_type(
    t: &ContentType,
    app_name: &str,
    window_title: &str,
    ocr_text: &str,
    blocks: &[OcrBlock],
) -> Value {
    match t {
        ContentType::Chat => extract_chat_data(ocr_text, blocks, app_name),
        ContentType::Webpage => extract_webpage_data(window_title, ocr_text, blocks),
        ContentType::Video => extract_video_data(window_title, ocr_text, blocks, app_name),
        ContentType::Forum => extract_forum_data(window_title, ocr_text, blocks),
        ContentType::Product => extract_product_data(window_title, ocr_text, blocks, app_name),
        ContentType::Document => extract_document_data(window_title, ocr_text),
        ContentType::Code => extract_code_data(window_title, ocr_text),
        _ => json!({}),
    }
}

// ===================== 主分类器 =====================

/// ContentClassifier：内容类型分类器。
pub struct ContentClassifier;

impl ContentClassifier {
    /// 推断单个 segment 的内容类型并提取结构化数据。
    ///
    /// 置信度不足时 contentType=other。
    pub fn classify_content(segment: &ContentSegmentInput) -> ContentClassification {
        let app_name = segment.app_name.to_lowercase();
        let window_title = &segment.window_title;
        let ocr_text = &segment.ocr_text;
        let blocks = &segment.ocr_blocks;

        let effective_ocr_text = if ocr_text.trim().len() > 0 {
            ocr_text.clone()
        } else {
            blocks.iter().map(|b| b.text.as_str()).collect::<Vec<_>>().join("\n")
        };

        let mut best_type: Option<ContentType> = None;
        let mut best_score: f64 = 0.0;
        let mut best_app_matched = false;

        for t in TYPE_ORDER {
            let rules = match get_rule_set(t) {
                Some(r) => r,
                None => continue,
            };
            let app_matched = rules.app_keywords.iter().any(|k| app_name.contains(&k.to_lowercase()));
            let title_matched = rules.title_patterns.iter().any(|p| p.is_match(window_title));
            let ocr_matched = (rules.ocr_match)(&effective_ocr_text, blocks);
            let matched = (app_matched as usize) + (title_matched as usize) + (ocr_matched as usize);
            let score = matched as f64 / RULES_PER_TYPE as f64;

            if score > best_score || (score == best_score && app_matched && !best_app_matched) {
                best_type = Some(t.clone());
                best_score = score;
                best_app_matched = app_matched;
            }
        }

        let confidence = round2(best_score);
        if let Some(t) = best_type {
            if confidence >= CONFIDENCE_THRESHOLD {
                let content_data = extract_data_for_type(
                    &t,
                    &segment.app_name,
                    window_title,
                    &effective_ocr_text,
                    blocks,
                );
                return ContentClassification {
                    content_type: t,
                    content_data,
                    confidence,
                };
            }
        }
        ContentClassification {
            content_type: ContentType::Other,
            content_data: json!({}),
            confidence,
        }
    }
}

impl Default for ContentClassifier {
    fn default() -> Self {
        Self
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_chat_by_app() {
        let segment = ContentSegmentInput {
            app_name: "微信".to_string(),
            window_title: "工作群".to_string(),
            ocr_text: "张三: 明天开会\n10:30".to_string(),
            ocr_blocks: vec![],
        };
        let result = ContentClassifier::classify_content(&segment);
        assert_eq!(result.content_type, ContentType::Chat);
        assert!(result.confidence >= CONFIDENCE_THRESHOLD);
        // 验证结构化数据
        assert!(result.content_data.get("platform").is_some());
    }

    #[test]
    fn test_classify_code_by_app() {
        let segment = ContentSegmentInput {
            app_name: "Visual Studio Code".to_string(),
            window_title: "main.rs".to_string(),
            ocr_text: "fn main() { let x = 1; }".to_string(),
            ocr_blocks: vec![],
        };
        let result = ContentClassifier::classify_content(&segment);
        assert_eq!(result.content_type, ContentType::Code);
        assert!(result.content_data.get("language").is_some());
    }

    #[test]
    fn test_classify_webpage_by_app() {
        let segment = ContentSegmentInput {
            app_name: "Chrome".to_string(),
            window_title: "GitHub - https://github.com".to_string(),
            ocr_text: "https://github.com search".to_string(),
            ocr_blocks: vec![],
        };
        let result = ContentClassifier::classify_content(&segment);
        assert_eq!(result.content_type, ContentType::Webpage);
        assert!(result.content_data.get("url").is_some());
    }

    #[test]
    fn test_classify_other_when_low_confidence() {
        let segment = ContentSegmentInput {
            app_name: "unknownapp".to_string(),
            window_title: "unknown".to_string(),
            ocr_text: "hello".to_string(),
            ocr_blocks: vec![],
        };
        let result = ContentClassifier::classify_content(&segment);
        assert_eq!(result.content_type, ContentType::Other);
        assert!(result.confidence < CONFIDENCE_THRESHOLD);
    }

    #[test]
    fn test_classify_video_by_app() {
        let segment = ContentSegmentInput {
            app_name: "bilibili".to_string(),
            window_title: "Rust 教程 - bilibili".to_string(),
            ocr_text: "播放 暂停 弹幕 0:39 / 5:23".to_string(),
            ocr_blocks: vec![],
        };
        let result = ContentClassifier::classify_content(&segment);
        assert_eq!(result.content_type, ContentType::Video);
        assert!(result.content_data.get("duration").is_some());
    }

    #[test]
    fn test_classify_product_by_price() {
        let segment = ContentSegmentInput {
            app_name: "淘宝".to_string(),
            window_title: "商品详情 - 淘宝".to_string(),
            ocr_text: "加入购物车 ¥99.9 包邮".to_string(),
            ocr_blocks: vec![],
        };
        let result = ContentClassifier::classify_content(&segment);
        assert_eq!(result.content_type, ContentType::Product);
        assert!(result.content_data.get("price").is_some());
    }
}
