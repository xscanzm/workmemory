//! IPC 请求/响应类型定义（对应 electron/ipc/schemas.ts）
//!
//! 为每个 IPC 命令定义严格的入参/出参类型，使用 serde 序列化。
//! 设计原则：
//!  - 无参命令不需要 Request 类型
//!  - 有参命令用结构体封装入参，preload 端将多参数打包为单对象
//!  - id 是非空 String，date 是 YYYY-MM-DD 格式字符串
//!  - 枚举值复用 crate::models 中的定义

use serde::{Deserialize, Serialize};

use crate::models::{
    AppSettings, CleanEpisode, Episode, MascotState, MascotStyle, OcrModel, Report, WikiPage,
    WorkSegment,
};

// ===================== Segment 通道类型 =====================

/// segment:getByDate 入参
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetSegmentsRequest {
    /// YYYY-MM-DD 日期字符串
    pub date: String,
}

/// segment:getByDate 返回
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetSegmentsResponse {
    pub segments: Vec<WorkSegment>,
}

// ===================== Episode 通道类型 =====================

/// episode:getByDate 入参
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetEpisodesRequest {
    /// YYYY-MM-DD 日期字符串
    pub date: String,
}

/// episode:getByDate 返回
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetEpisodesResponse {
    pub episodes: Vec<Episode>,
}

/// episode:create 入参（手动创建 Episode）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateEpisodeRequest {
    pub episode: Episode,
}

/// episode:create 返回
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateEpisodeResponse {
    pub episode: Episode,
}

// ===================== Search 通道类型 =====================

/// 搜索过滤条件
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SearchFilters {
    /// 返回结果数量上限
    pub limit: Option<u32>,
    /// 日期过滤（YYYY-MM-DD）
    pub date: Option<String>,
}

/// search 入参
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchRequest {
    /// 非空查询字符串
    pub query: String,
    /// 可选过滤条件
    pub filters: Option<SearchFilters>,
}

/// search 返回（FTS5 全文搜索综合结果）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SearchResponse {
    /// 匹配的 CleanEpisode ID + snippet 列表
    pub clean_episodes: Vec<SearchHit>,
    /// 匹配的 Segment ID + snippet 列表
    pub segments: Vec<SearchHit>,
    /// 匹配的 Episode ID + snippet 列表
    pub episodes: Vec<SearchHit>,
    /// 匹配的 Wiki ID + title + snippet 列表
    pub wikis: Vec<WikiSearchHit>,
}

/// 单条搜索命中
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    /// 命中记录 ID
    pub id: String,
    /// 命中片段
    pub snippet: String,
    /// 命中字段名
    pub matched_field: String,
}

/// Wiki 搜索命中
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WikiSearchHit {
    pub id: String,
    pub title: String,
    pub snippet: String,
}

// ===================== Report 通道类型 =====================

/// report:generate 入参
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateReportRequest {
    /// YYYY-MM-DD 日期字符串
    pub date: String,
    /// 报告模板 ID（enhanced / concise / okr / structured）
    pub template: String,
}

/// report:generate 返回
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateReportResponse {
    pub report: Report,
}

// ===================== Settings 通道类型 =====================

/// settings:get 返回
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetSettingsResponse {
    pub settings: AppSettings,
}

/// settings:update 入参
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateSettingsRequest {
    /// 合并补丁（完整 AppSettings，空字段表示不更新）
    pub patch: AppSettings,
}

// ===================== OCR 通道类型 =====================

/// ocr:getStatus 返回
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrStatusResponse {
    /// 后端类型：'windows_ocr' | 'unconfigured'
    pub backend: String,
    /// 当前模型
    pub model: OcrModel,
    /// 引擎是否已加载
    pub loaded: bool,
    /// 队列大小
    pub queue_size: usize,
    /// 是否运行中
    pub running: bool,
    /// 是否已配置
    pub configured: bool,
}

// ===================== Capture 通道类型 =====================

/// capture:getState 返回
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureStateResponse {
    /// 当前记录状态：recording / paused / idle / privacy
    pub state: String,
}

// ===================== Mascot 通道类型 =====================

/// mascot:getState 返回
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MascotStateResponse {
    /// 当前状态
    pub state: MascotState,
    /// 当前形象
    pub style: MascotStyle,
}

// ===================== Wiki 通道类型 =====================

/// wiki:getById / wiki:create 返回封装
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WikiPageResponse {
    pub page: WikiPage,
}

// ===================== Insights 通道类型 =====================

/// insights:getStatus 返回
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsightsStatusResponse {
    /// 是否运行中
    pub running: bool,
    /// 最近一次审计日期（YYYY-MM-DD），None 表示尚未审计
    pub last_audit: Option<String>,
}

// ===================== CleanEpisode 通道类型 =====================

/// cleanEpisode:getByDate 返回
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetCleanEpisodesResponse {
    pub episodes: Vec<CleanEpisode>,
}
