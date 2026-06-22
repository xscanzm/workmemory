//! WorkMemory 领域模型（对应 src/types/index.ts）
//!
//! 覆盖 WorkSegment / Episode / CleanEpisode / WikiPage / Report / PrivacyRule
//! 及全部状态、模板、设置等枚举类型。所有结构体实现 `Serialize`/`Deserialize`
//! 供 IPC 层与数据库层共用。

use serde::{Deserialize, Serialize};

// ===================== 枚举类型 =====================

/// Segment 来源处理状态
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceStatus {
    Pending,
    OcrDone,
    OcrFailed,
    NoText,
    Private,
}

impl Default for SourceStatus {
    fn default() -> Self {
        SourceStatus::Pending
    }
}

impl SourceStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            SourceStatus::Pending => "pending",
            SourceStatus::OcrDone => "ocr_done",
            SourceStatus::OcrFailed => "ocr_failed",
            SourceStatus::NoText => "no_text",
            SourceStatus::Private => "private",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "ocr_done" => SourceStatus::OcrDone,
            "ocr_failed" => SourceStatus::OcrFailed,
            "no_text" => SourceStatus::NoText,
            "private" => SourceStatus::Private,
            _ => SourceStatus::Pending,
        }
    }
}

/// OCR / capture evidence source quality
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceQuality {
    High,
    Medium,
    Low,
    Failed,
    Private,
}

impl Default for SourceQuality {
    fn default() -> Self {
        SourceQuality::Low
    }
}

impl SourceQuality {
    pub fn as_str(&self) -> &'static str {
        match self {
            SourceQuality::High => "high",
            SourceQuality::Medium => "medium",
            SourceQuality::Low => "low",
            SourceQuality::Failed => "failed",
            SourceQuality::Private => "private",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "high" => SourceQuality::High,
            "medium" => SourceQuality::Medium,
            "failed" => SourceQuality::Failed,
            "private" => SourceQuality::Private,
            _ => SourceQuality::Low,
        }
    }
}

/// 截图来源类型
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureSource {
    ActiveWindow,
    FullScreenFallback,
    PrivacyPlaceholder,
    Unknown,
}

impl Default for CaptureSource {
    fn default() -> Self {
        CaptureSource::Unknown
    }
}

impl CaptureSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            CaptureSource::ActiveWindow => "active_window",
            CaptureSource::FullScreenFallback => "full_screen_fallback",
            CaptureSource::PrivacyPlaceholder => "privacy_placeholder",
            CaptureSource::Unknown => "unknown",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "active_window" => CaptureSource::ActiveWindow,
            "full_screen_fallback" => CaptureSource::FullScreenFallback,
            "privacy_placeholder" => CaptureSource::PrivacyPlaceholder,
            _ => CaptureSource::Unknown,
        }
    }
}

/// 全局记录状态
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordingState {
    Recording,
    Paused,
    Idle,
    Privacy,
}

/// 桌面伙伴形象
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MascotStyle {
    Note,
    Film,
    Copilot,
    Cursor,
    Paper,
}

impl Default for MascotStyle {
    fn default() -> Self {
        MascotStyle::Note
    }
}

impl MascotStyle {
    pub fn as_str(&self) -> &'static str {
        match self {
            MascotStyle::Note => "note",
            MascotStyle::Film => "film",
            MascotStyle::Copilot => "copilot",
            MascotStyle::Cursor => "cursor",
            MascotStyle::Paper => "paper",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "film" => MascotStyle::Film,
            "copilot" => MascotStyle::Copilot,
            "cursor" => MascotStyle::Cursor,
            "paper" => MascotStyle::Paper,
            _ => MascotStyle::Note,
        }
    }
}

/// 桌面伙伴状态
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MascotState {
    Recording,
    Paused,
    Privacy,
    OcrScanning,
    ReportReady,
}

/// 日报模板
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportTemplate {
    Enhanced,
    Concise,
    Okr,
    Structured,
    Standup,
}

impl Default for ReportTemplate {
    fn default() -> Self {
        ReportTemplate::Enhanced
    }
}

impl ReportTemplate {
    pub fn as_str(&self) -> &'static str {
        match self {
            ReportTemplate::Enhanced => "enhanced",
            ReportTemplate::Concise => "concise",
            ReportTemplate::Okr => "okr",
            ReportTemplate::Structured => "structured",
            ReportTemplate::Standup => "standup",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "concise" => ReportTemplate::Concise,
            "okr" => ReportTemplate::Okr,
            "structured" => ReportTemplate::Structured,
            "standup" => ReportTemplate::Standup,
            _ => ReportTemplate::Enhanced,
        }
    }
}

/// 本地 OCR 模型
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OcrModel {
    Tiny,
    Small,
}

impl Default for OcrModel {
    fn default() -> Self {
        OcrModel::Tiny
    }
}

impl OcrModel {
    pub fn as_str(&self) -> &'static str {
        match self {
            OcrModel::Tiny => "tiny",
            OcrModel::Small => "small",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "small" => OcrModel::Small,
            _ => OcrModel::Tiny,
        }
    }
}

/// 报告状态
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportStatus {
    Draft,
    Exported,
}

impl Default for ReportStatus {
    fn default() -> Self {
        ReportStatus::Draft
    }
}

impl ReportStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ReportStatus::Draft => "draft",
            ReportStatus::Exported => "exported",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "exported" => ReportStatus::Exported,
            _ => ReportStatus::Draft,
        }
    }
}

/// 报告类型：日报 / 周报 / 复盘
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportType {
    Daily,
    Weekly,
    Review,
}

impl Default for ReportType {
    fn default() -> Self {
        ReportType::Daily
    }
}

impl ReportType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ReportType::Daily => "daily",
            ReportType::Weekly => "weekly",
            ReportType::Review => "review",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "weekly" => ReportType::Weekly,
            "review" => ReportType::Review,
            _ => ReportType::Daily,
        }
    }
}

/// Wiki 审核状态
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WikiReviewStatus {
    NeedsReview,
    Reviewed,
}

impl Default for WikiReviewStatus {
    fn default() -> Self {
        WikiReviewStatus::NeedsReview
    }
}

impl WikiReviewStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            WikiReviewStatus::NeedsReview => "needs_review",
            WikiReviewStatus::Reviewed => "reviewed",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "reviewed" => WikiReviewStatus::Reviewed,
            _ => WikiReviewStatus::NeedsReview,
        }
    }
}

/// Wiki 页类型
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WikiType {
    Person,
    Project,
    Customer,
    Topic,
    Decision,
    Meeting,
    Issue,
}

impl Default for WikiType {
    fn default() -> Self {
        WikiType::Topic
    }
}

impl WikiType {
    pub fn as_str(&self) -> &'static str {
        match self {
            WikiType::Person => "person",
            WikiType::Project => "project",
            WikiType::Customer => "customer",
            WikiType::Topic => "topic",
            WikiType::Decision => "decision",
            WikiType::Meeting => "meeting",
            WikiType::Issue => "issue",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "person" => WikiType::Person,
            "project" => WikiType::Project,
            "customer" => WikiType::Customer,
            "decision" => WikiType::Decision,
            "meeting" => WikiType::Meeting,
            "issue" => WikiType::Issue,
            _ => WikiType::Topic,
        }
    }
}

/// 隐私规则类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyRuleType {
    AppName,
    ProcessName,
    WindowTitle,
    Url,
}

impl PrivacyRuleType {
    pub fn as_str(&self) -> &'static str {
        match self {
            PrivacyRuleType::AppName => "app_name",
            PrivacyRuleType::ProcessName => "process_name",
            PrivacyRuleType::WindowTitle => "window_title",
            PrivacyRuleType::Url => "url",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "process_name" => PrivacyRuleType::ProcessName,
            "window_title" => PrivacyRuleType::WindowTitle,
            "url" => PrivacyRuleType::Url,
            _ => PrivacyRuleType::AppName,
        }
    }
}

/// 隐私规则匹配模式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyMatchMode {
    Contains,
    Equals,
    Regex,
}

impl Default for PrivacyMatchMode {
    fn default() -> Self {
        PrivacyMatchMode::Contains
    }
}

impl PrivacyMatchMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            PrivacyMatchMode::Contains => "contains",
            PrivacyMatchMode::Equals => "equals",
            PrivacyMatchMode::Regex => "regex",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "equals" => PrivacyMatchMode::Equals,
            "regex" => PrivacyMatchMode::Regex,
            _ => PrivacyMatchMode::Contains,
        }
    }
}

/// 隐私过滤动作
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyAction {
    Skip,
    Placeholder,
    Allow,
}

/// 实体引用类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntityRefType {
    Person,
    Project,
    Document,
    Url,
}

impl EntityRefType {
    pub fn as_str(&self) -> &'static str {
        match self {
            EntityRefType::Person => "person",
            EntityRefType::Project => "project",
            EntityRefType::Document => "document",
            EntityRefType::Url => "url",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "project" => EntityRefType::Project,
            "document" => EntityRefType::Document,
            "url" => EntityRefType::Url,
            _ => EntityRefType::Person,
        }
    }
}

/// 用户活动类型
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityType {
    Coding,
    Writing,
    Reading,
    Browsing,
    Chatting,
    Designing,
    Meeting,
    Managing,
    Idle,
}

impl ActivityType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ActivityType::Coding => "coding",
            ActivityType::Writing => "writing",
            ActivityType::Reading => "reading",
            ActivityType::Browsing => "browsing",
            ActivityType::Chatting => "chatting",
            ActivityType::Designing => "designing",
            ActivityType::Meeting => "meeting",
            ActivityType::Managing => "managing",
            ActivityType::Idle => "idle",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "coding" => ActivityType::Coding,
            "writing" => ActivityType::Writing,
            "reading" => ActivityType::Reading,
            "browsing" => ActivityType::Browsing,
            "chatting" => ActivityType::Chatting,
            "designing" => ActivityType::Designing,
            "meeting" => ActivityType::Meeting,
            "managing" => ActivityType::Managing,
            _ => ActivityType::Idle,
        }
    }
}

/// 屏幕内容类型
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentType {
    Chat,
    Webpage,
    Document,
    Code,
    Video,
    Forum,
    Product,
    Other,
}

impl ContentType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ContentType::Chat => "chat",
            ContentType::Webpage => "webpage",
            ContentType::Document => "document",
            ContentType::Code => "code",
            ContentType::Video => "video",
            ContentType::Forum => "forum",
            ContentType::Product => "product",
            ContentType::Other => "other",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "chat" => ContentType::Chat,
            "webpage" => ContentType::Webpage,
            "document" => ContentType::Document,
            "code" => ContentType::Code,
            "video" => ContentType::Video,
            "forum" => ContentType::Forum,
            "product" => ContentType::Product,
            _ => ContentType::Other,
        }
    }
}

/// UI 布局类型
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayoutType {
    Form,
    List,
    Article,
    Editor,
    Chat,
    Dashboard,
    Other,
}

impl LayoutType {
    pub fn as_str(&self) -> &'static str {
        match self {
            LayoutType::Form => "form",
            LayoutType::List => "list",
            LayoutType::Article => "article",
            LayoutType::Editor => "editor",
            LayoutType::Chat => "chat",
            LayoutType::Dashboard => "dashboard",
            LayoutType::Other => "other",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "form" => LayoutType::Form,
            "list" => LayoutType::List,
            "article" => LayoutType::Article,
            "editor" => LayoutType::Editor,
            "chat" => LayoutType::Chat,
            "dashboard" => LayoutType::Dashboard,
            _ => LayoutType::Other,
        }
    }
}

/// 用户操作流类型
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionFlow {
    CopyPaste,
    SwitchContext,
    ScrollDeep,
    EditContinuous,
    BrowseLinear,
    Unknown,
}

impl ActionFlow {
    pub fn as_str(&self) -> &'static str {
        match self {
            ActionFlow::CopyPaste => "copy-paste",
            ActionFlow::SwitchContext => "switch-context",
            ActionFlow::ScrollDeep => "scroll-deep",
            ActionFlow::EditContinuous => "edit-continuous",
            ActionFlow::BrowseLinear => "browse-linear",
            ActionFlow::Unknown => "unknown",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "copy-paste" => ActionFlow::CopyPaste,
            "switch-context" => ActionFlow::SwitchContext,
            "scroll-deep" => ActionFlow::ScrollDeep,
            "edit-continuous" => ActionFlow::EditContinuous,
            "browse-linear" => ActionFlow::BrowseLinear,
            _ => ActionFlow::Unknown,
        }
    }
}

/// 记忆类型
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    Work,
    Research,
    Communication,
    Coding,
    Planning,
    Review,
    Admin,
    IdleUncertain,
}

impl Default for MemoryKind {
    fn default() -> Self {
        MemoryKind::IdleUncertain
    }
}

impl MemoryKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            MemoryKind::Work => "work",
            MemoryKind::Research => "research",
            MemoryKind::Communication => "communication",
            MemoryKind::Coding => "coding",
            MemoryKind::Planning => "planning",
            MemoryKind::Review => "review",
            MemoryKind::Admin => "admin",
            MemoryKind::IdleUncertain => "idle_uncertain",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "work" => MemoryKind::Work,
            "research" => MemoryKind::Research,
            "communication" => MemoryKind::Communication,
            "coding" => MemoryKind::Coding,
            "planning" => MemoryKind::Planning,
            "review" => MemoryKind::Review,
            "admin" => MemoryKind::Admin,
            _ => MemoryKind::IdleUncertain,
        }
    }
}

/// Wiki 状态
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WikiStatus {
    None,
    Candidate,
    AutoUpserted,
    NeedsReview,
    Rejected,
}

impl Default for WikiStatus {
    fn default() -> Self {
        WikiStatus::None
    }
}

impl WikiStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            WikiStatus::None => "none",
            WikiStatus::Candidate => "candidate",
            WikiStatus::AutoUpserted => "auto_upserted",
            WikiStatus::NeedsReview => "needs_review",
            WikiStatus::Rejected => "rejected",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "candidate" => WikiStatus::Candidate,
            "auto_upserted" => WikiStatus::AutoUpserted,
            "needs_review" => WikiStatus::NeedsReview,
            "rejected" => WikiStatus::Rejected,
            _ => WikiStatus::None,
        }
    }
}

// ===================== 结构体类型 =====================

/// 实体引用（从 Episode 提取的人/项目/文档/URL）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntityRef {
    #[serde(rename = "type")]
    pub ref_type: EntityRefType,
    pub name: String,
    pub value: Option<String>,
    /// 置信度 0-1
    pub confidence: f64,
    /// 用户已确认
    #[serde(default)]
    pub user_confirmed: bool,
}

/// OCR 文本块证据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrBlock {
    pub text: String,
    pub box_rect: OcrBox,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundsRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// 原始工作片段：一次窗口活动 + OCR 结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkSegment {
    pub id: String,
    /// YYYY-MM-DD
    pub date: String,
    /// ISO 时间戳或 HH:MM:SS
    pub start_time: String,
    pub end_time: String,
    /// 持续秒数
    pub duration_seconds: i64,
    pub app_name: String,
    pub process_name: String,
    pub window_title: String,
    pub ocr_text: String,
    pub ocr_summary: String,
    /// 局部图像哈希
    pub image_hash: String,
    /// 截图文件路径
    pub screenshot_path: String,
    pub is_selected_for_report: bool,
    pub is_private: bool,
    pub is_important: bool,
    pub is_deleted: bool,
    pub source_status: SourceStatus,
    pub user_title: String,
    pub user_summary: String,
    pub user_note: String,
    /// 项目/主题标签
    pub tags: Vec<String>,
    /// OCR block 元数据
    #[serde(default)]
    pub ocr_blocks: Vec<OcrBlock>,
    /// OCR 平均置信度 0-1
    #[serde(default)]
    pub ocr_confidence: f64,
    /// 截图来源
    #[serde(default)]
    pub capture_source: CaptureSource,
    /// 来源质量
    #[serde(default)]
    pub source_quality: SourceQuality,
    /// 活跃窗口范围
    pub active_window_bounds: Option<BoundsRect>,
    /// 整屏降级时的屏幕范围
    pub display_bounds: Option<BoundsRect>,
    /// OCR 原始文本（未清洗）
    pub ocr_raw_text: Option<String>,
    /// 噪声评分
    pub noise_score: Option<f64>,
    /// 用户活动类型
    pub activity_type: Option<ActivityType>,
    /// 屏幕内容类型
    pub content_type: Option<ContentType>,
    /// 内容结构化数据（JSON 对象）
    pub content_data: Option<serde_json::Value>,
    /// 浏览器 URL
    pub browser_url: Option<String>,
    /// UI 布局类型
    pub layout_type: Option<LayoutType>,
    /// 用户操作流类型
    pub action_flow: Option<ActionFlow>,
    /// 创建时间
    #[serde(default)]
    pub created_at: String,
    /// 更新时间
    #[serde(default)]
    pub updated_at: String,
}

impl Default for WorkSegment {
    fn default() -> Self {
        WorkSegment {
            id: String::new(),
            date: String::new(),
            start_time: String::new(),
            end_time: String::new(),
            duration_seconds: 0,
            app_name: String::new(),
            process_name: String::new(),
            window_title: String::new(),
            ocr_text: String::new(),
            ocr_summary: String::new(),
            image_hash: String::new(),
            screenshot_path: String::new(),
            is_selected_for_report: false,
            is_private: false,
            is_important: false,
            is_deleted: false,
            source_status: SourceStatus::Pending,
            user_title: String::new(),
            user_summary: String::new(),
            user_note: String::new(),
            tags: Vec::new(),
            ocr_blocks: Vec::new(),
            ocr_confidence: 0.0,
            capture_source: CaptureSource::Unknown,
            source_quality: SourceQuality::Low,
            active_window_bounds: None,
            display_bounds: None,
            ocr_raw_text: None,
            noise_score: None,
            activity_type: None,
            content_type: None,
            content_data: None,
            browser_url: None,
            layout_type: None,
            action_flow: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
}

/// Episode：语义合并后的工作事件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Episode {
    pub id: String,
    pub date: String,
    pub start_time: String,
    pub end_time: String,
    pub title: String,
    pub one_line_summary: String,
    pub segment_ids: Vec<String>,
    pub entities: Vec<EntityRef>,
    pub topics: Vec<String>,
    /// 用户手动编辑过一句话总结
    pub user_edited: bool,
    pub report_eligible: bool,
    pub wiki_eligible: bool,
    /// 聚类内多数 segment 的 activityType
    pub dominant_activity_type: Option<ActivityType>,
}

/// 证据引用
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceRef {
    pub segment_id: String,
    pub quote: String,
    pub reason: String,
}

/// CleanEpisode：工作记忆事件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanEpisode {
    pub id: String,
    pub date: String,
    pub hour_bucket: String,
    pub start_time: String,
    pub end_time: String,
    pub title: String,
    pub summary: String,
    pub memory_kind: MemoryKind,
    pub project: String,
    pub entities: Vec<EntityRef>,
    pub topics: Vec<String>,
    pub materials: Vec<String>,
    pub outputs: Vec<String>,
    pub todos: Vec<String>,
    pub blockers: Vec<String>,
    pub segment_ids: Vec<String>,
    pub evidence_refs: Vec<EvidenceRef>,
    pub source_quality: SourceQuality,
    pub confidence: f64,
    pub report_eligible: bool,
    pub wiki_eligible: bool,
    pub wiki_status: WikiStatus,
    pub created_at: String,
    pub updated_at: String,
    pub model_name: String,
    pub distill_version: String,
}

/// Wiki 知识页（双链沉淀）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WikiPage {
    pub id: String,
    pub wiki_type: WikiType,
    pub title: String,
    pub aliases: Vec<String>,
    /// Markdown 正文
    pub content: String,
    /// 来源 Episode/Segment id 列表
    pub sources: Vec<String>,
    /// 反向链接的 Wiki 页标题列表
    pub backlinks: Vec<String>,
    /// 置信度 0-1
    pub confidence: f64,
    pub review_status: WikiReviewStatus,
    pub created_at: String,
    pub updated_at: String,
}

/// 日报/周报
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Report {
    pub id: String,
    pub date: String,
    pub template_id: ReportTemplate,
    pub template_name: String,
    pub segment_ids: Vec<String>,
    /// 发送给 AI 的输入快照
    pub ai_input_snapshot: String,
    pub markdown_content: String,
    pub status: ReportStatus,
    pub report_type: ReportType,
}

/// 隐私规则
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrivacyRule {
    pub id: String,
    pub rule_type: PrivacyRuleType,
    pub pattern: String,
    pub match_mode: PrivacyMatchMode,
    pub enabled: bool,
}

/// 隐私规则匹配结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrivacyMatchResult {
    pub action: PrivacyAction,
    pub matched_rule: Option<PrivacyRule>,
}

/// 应用设置（UI 可见字段，不含明文 API Key）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub auto_start: bool,
    pub screenshot_retention_days: i32,
    pub ocr_model: OcrModel,
    /// API Key 掩码
    pub api_key_masked: String,
    pub api_base_url: String,
    pub model_name: String,
    pub mascot_style: MascotStyle,
    pub save_screenshots: bool,
    pub allow_full_screenshot_fallback: bool,
    pub ai_auto_distill_enabled: bool,
    pub ai_auto_distill_first_consent_at: String,
    pub ai_distill_schedule: String,
    pub ai_distill_last_run_at: String,
    pub ai_distill_send_screenshots: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            auto_start: false,
            screenshot_retention_days: 0,
            ocr_model: OcrModel::Tiny,
            api_key_masked: String::new(),
            api_base_url: "https://api.openai.com/v1".to_string(),
            model_name: "gpt-4o-mini".to_string(),
            mascot_style: MascotStyle::Note,
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

// ===================== MemCell / MemScene / CausalChain 等辅助类型 =====================

/// MemCell 元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemCellMetadata {
    #[serde(default)]
    pub segment_ids: Vec<String>,
    #[serde(default)]
    pub timestamp: String,
    #[serde(default)]
    pub confidence: f64,
}

impl Default for MemCellMetadata {
    fn default() -> Self {
        MemCellMetadata {
            segment_ids: Vec::new(),
            timestamp: String::new(),
            confidence: 0.0,
        }
    }
}

/// Foresight（前瞻性洞察）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Foresight {
    pub text: String,
    #[serde(default)]
    pub confidence: f64,
}

/// MemCell：结构化记忆单元
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemCell {
    pub id: String,
    pub clean_episode_id: String,
    pub episode: String,
    pub facts: Vec<String>,
    pub foresight: Vec<Foresight>,
    pub metadata: MemCellMetadata,
    pub created_at: String,
}

/// MemScene：主题场景
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemScene {
    pub id: String,
    pub title: String,
    pub centroid_embedding: Vec<f32>,
    pub member_cell_ids: Vec<String>,
    pub summary: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 因果链
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CausalChain {
    pub id: String,
    pub cause_cell_id: String,
    pub effect_cell_id: String,
    pub relation: String,
    pub confidence: f64,
    pub evidence: String,
    pub created_at: String,
}

/// 日级主题
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DayTheme {
    pub name: String,
    pub summary: String,
    #[serde(default)]
    pub cell_ids: Vec<String>,
}

/// 日级模式
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DayPattern {
    pub deep_work_hours: f64,
    pub fragmented_periods: Vec<TimeRange>,
    pub switch_count: i32,
    pub active_hours: f64,
    pub dominant_activity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeRange {
    pub start: String,
    pub end: String,
}

/// 日级理解结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DayDistillResult {
    pub date: String,
    pub summary: String,
    pub themes: Vec<DayTheme>,
    pub patterns: DayPattern,
    pub memcell_ids: Vec<String>,
}

/// 周级模式
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeeklyPattern {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub confidence: f64,
}

/// 周级趋势
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WeeklyPatternTrend {
    #[serde(default)]
    pub deep_work_hours_trend: Vec<f64>,
    #[serde(default)]
    pub switch_count_trend: Vec<i32>,
    #[serde(default)]
    pub dominant_activity_trend: Vec<String>,
}

/// 周级模式结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeeklyPatternResult {
    pub week_start: String,
    pub patterns: Vec<WeeklyPattern>,
    pub trend: WeeklyPatternTrend,
    pub created_at: String,
}

/// 反思报告
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReflectionReport {
    pub week_start: String,
    #[serde(default)]
    pub patterns: Vec<serde_json::Value>,
    #[serde(default)]
    pub suggestions: Vec<serde_json::Value>,
    #[serde(default)]
    pub trends: Vec<serde_json::Value>,
    pub created_at: String,
}

/// 技能卡
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub id: String,
    pub title: String,
    pub steps: Vec<String>,
    pub traps: Vec<String>,
    pub insights: Vec<String>,
    pub source_cell_ids: Vec<String>,
    pub confidence: f64,
    pub evolved_at: String,
}

/// 反馈事件类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackEventType {
    EpisodeRenamed,
    WikiRejected,
    ReportEdited,
}

impl FeedbackEventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            FeedbackEventType::EpisodeRenamed => "episode_renamed",
            FeedbackEventType::WikiRejected => "wiki_rejected",
            FeedbackEventType::ReportEdited => "report_edited",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "wiki_rejected" => FeedbackEventType::WikiRejected,
            "report_edited" => FeedbackEventType::ReportEdited,
            _ => FeedbackEventType::EpisodeRenamed,
        }
    }
}

/// 反馈事件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedbackEvent {
    pub id: String,
    pub event_type: FeedbackEventType,
    pub target_id: String,
    pub before: String,
    pub after: String,
    pub timestamp: String,
}

/// 用户画像类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileType {
    Stable,
    Transient,
}

impl ProfileType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProfileType::Stable => "stable",
            ProfileType::Transient => "transient",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "transient" => ProfileType::Transient,
            _ => ProfileType::Stable,
        }
    }
}

/// 用户画像条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfileEntry {
    pub key: String,
    pub value: String,
    pub profile_type: ProfileType,
    pub confidence: f64,
    pub valid_to: Option<String>,
    pub sources: Vec<String>,
    pub updated_at: String,
}
