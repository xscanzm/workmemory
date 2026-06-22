//! HighValueSignalDetector：高价值信号识别器（对应 electron/wiki/HighValueSignalDetector.ts）
//!
//! 分析 CleanEpisode，识别值得沉淀为 Wiki 页的高价值信号。
//!
//! 信号类型：
//!  - decision：决策类信号（含决策关键词）
//!  - insight：洞察类信号（含洞察关键词）
//!  - risk：风险类信号（含风险/阻塞关键词）
//!  - milestone：里程碑类信号（含完成/发布关键词）

use regex::Regex;

use crate::models::CleanEpisode;

/// 高价值信号类型
pub const SIGNAL_TYPE_DECISION: &str = "decision";
pub const SIGNAL_TYPE_INSIGHT: &str = "insight";
pub const SIGNAL_TYPE_RISK: &str = "risk";
pub const SIGNAL_TYPE_MILESTONE: &str = "milestone";

/// 高价值信号
#[derive(Debug, Clone, PartialEq)]
pub struct HighValueSignal {
    /// 信号类型（decision/insight/risk/milestone）
    pub signal_type: String,
    /// 信号内容
    pub content: String,
    /// 置信度 0-1
    pub confidence: f64,
}

/// 决策关键词
const DECISION_KEYWORDS: &[&str] = &[
    "决定", "决策", "敲定", "拍板", "选定", "采纳", "采用", "选择", "敲定", "确定",
    "decide", "decision", "choose", "adopt", "select",
];

/// 洞察关键词
const INSIGHT_KEYWORDS: &[&str] = &[
    "发现", "意识到", "领悟", "启发", "洞察", "本质", "规律", "关键", "核心",
    "insight", "realize", "discover", "pattern",
];

/// 风险关键词
const RISK_KEYWORDS: &[&str] = &[
    "风险", "阻塞", "卡住", "问题", "隐患", "警告", "危险", "失败", "错误",
    "blocker", "risk", "stuck", "issue", "warning", "error",
];

/// 里程碑关键词
const MILESTONE_KEYWORDS: &[&str] = &[
    "完成", "上线", "发布", "交付", "里程碑", "达成", "验收", "结项", "收官",
    "done", "complete", "release", "deliver", "milestone",
];

/// HighValueSignalDetector：高价值信号识别器。
pub struct HighValueSignalDetector;

impl HighValueSignalDetector {
    /// 创建实例
    pub fn new() -> Self {
        HighValueSignalDetector
    }

    /// 从 CleanEpisode 文本中检测高价值信号。
    ///
    /// 检测策略：
    ///  1. 聚合 episode 的 title + summary + outputs + todos + blockers + topics
    ///  2. 对每类信号关键词进行匹配
    ///  3. 命中的句子生成 HighValueSignal，置信度基于命中关键词数与 episode.confidence
    pub fn detect_signals(&self, episode: &CleanEpisode) -> Vec<HighValueSignal> {
        let full_text = self.aggregate_text(episode);
        if full_text.is_empty() {
            return Vec::new();
        }

        let sentences = self.split_sentences(&full_text);
        let mut signals: Vec<HighValueSignal> = Vec::new();

        for sentence in &sentences {
            let trimmed = sentence.trim();
            if trimmed.is_empty() {
                continue;
            }
            // 决策信号
            if let Some(signal) = self.match_signal(
                trimmed,
                SIGNAL_TYPE_DECISION,
                DECISION_KEYWORDS,
                episode.confidence,
            ) {
                signals.push(signal);
                continue;
            }
            // 洞察信号
            if let Some(signal) = self.match_signal(
                trimmed,
                SIGNAL_TYPE_INSIGHT,
                INSIGHT_KEYWORDS,
                episode.confidence,
            ) {
                signals.push(signal);
                continue;
            }
            // 风险信号
            if let Some(signal) = self.match_signal(
                trimmed,
                SIGNAL_TYPE_RISK,
                RISK_KEYWORDS,
                episode.confidence,
            ) {
                signals.push(signal);
                continue;
            }
            // 里程碑信号
            if let Some(signal) = self.match_signal(
                trimmed,
                SIGNAL_TYPE_MILESTONE,
                MILESTONE_KEYWORDS,
                episode.confidence,
            ) {
                signals.push(signal);
            }
        }

        // 兜底：若无信号但 episode 有 blockers，生成风险信号
        if signals.is_empty() && !episode.blockers.is_empty() {
            let content = episode.blockers.join("；");
            signals.push(HighValueSignal {
                signal_type: SIGNAL_TYPE_RISK.to_string(),
                content,
                confidence: (0.5 + episode.confidence * 0.3).min(0.95),
            });
        }

        // 兜底：若无信号但 episode 有 outputs，生成里程碑信号
        if signals.is_empty() && !episode.outputs.is_empty() {
            let content = episode.outputs.join("；");
            signals.push(HighValueSignal {
                signal_type: SIGNAL_TYPE_MILESTONE.to_string(),
                content,
                confidence: (0.5 + episode.confidence * 0.3).min(0.95),
            });
        }

        signals
    }

    /// 匹配单句的信号关键词
    fn match_signal(
        &self,
        sentence: &str,
        signal_type: &str,
        keywords: &[&str],
        base_confidence: f64,
    ) -> Option<HighValueSignal> {
        let lower = sentence.to_lowercase();
        let mut hit_count = 0usize;
        for kw in keywords {
            if lower.contains(&kw.to_lowercase()) {
                hit_count += 1;
            }
        }
        if hit_count == 0 {
            return None;
        }
        // 置信度：基础 0.5 + 命中数 * 0.1 + episode.confidence * 0.2，上限 0.95
        let confidence = (0.5 + hit_count as f64 * 0.1 + base_confidence * 0.2).min(0.95);
        Some(HighValueSignal {
            signal_type: signal_type.to_string(),
            content: sentence.to_string(),
            confidence: (confidence * 100.0).round() / 100.0,
        })
    }

    /// 聚合 episode 的可读文本
    fn aggregate_text(&self, episode: &CleanEpisode) -> String {
        let mut parts: Vec<String> = Vec::new();
        if !episode.title.is_empty() {
            parts.push(episode.title.clone());
        }
        if !episode.summary.is_empty() {
            parts.push(episode.summary.clone());
        }
        for o in &episode.outputs {
            parts.push(o.clone());
        }
        for t in &episode.todos {
            parts.push(t.clone());
        }
        for b in &episode.blockers {
            parts.push(b.clone());
        }
        for t in &episode.topics {
            parts.push(t.clone());
        }
        parts.join("\n")
    }

    /// 分割句子（中英文标点）
    fn split_sentences(&self, text: &str) -> Vec<String> {
        if text.is_empty() {
            return Vec::new();
        }
        let re = match Regex::new(r"[。！？!?\n；;]+") {
            Ok(r) => r,
            Err(_) => return vec![text.to_string()],
        };
        re.split(text)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }
}

impl Default for HighValueSignalDetector {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        CleanEpisode, EntityRef, EntityRefType, MemoryKind, SourceQuality, WikiStatus,
    };

    fn make_episode(summary: &str) -> CleanEpisode {
        CleanEpisode {
            id: "ep-1".to_string(),
            date: "2026-06-22".to_string(),
            hour_bucket: "10".to_string(),
            start_time: "10:00:00".to_string(),
            end_time: "11:00:00".to_string(),
            title: "Tauri 配置梳理".to_string(),
            summary: summary.to_string(),
            memory_kind: MemoryKind::Work,
            project: "Tauri 配置".to_string(),
            entities: vec![EntityRef {
                ref_type: EntityRefType::Project,
                name: "Tauri 配置".to_string(),
                value: None,
                confidence: 0.9,
                user_confirmed: false,
            }],
            topics: vec![],
            materials: vec![],
            outputs: vec![],
            todos: vec![],
            blockers: vec![],
            segment_ids: vec![],
            evidence_refs: vec![],
            source_quality: SourceQuality::High,
            confidence: 0.8,
            report_eligible: true,
            wiki_eligible: true,
            wiki_status: WikiStatus::None,
            created_at: String::new(),
            updated_at: String::new(),
            model_name: String::new(),
            distill_version: String::new(),
        }
    }

    #[test]
    fn test_detect_decision_signal() {
        let detector = HighValueSignalDetector::new();
        let episode = make_episode("我们决定采用 Tauri 作为前端框架。");
        let signals = detector.detect_signals(&episode);
        assert!(signals.iter().any(|s| s.signal_type == "decision"), "signals={:?}", signals);
    }

    #[test]
    fn test_detect_risk_signal_from_blockers() {
        let detector = HighValueSignalDetector::new();
        let mut episode = make_episode("正常工作。");
        episode.blockers.push("数据库连接失败".to_string());
        let signals = detector.detect_signals(&episode);
        // 应至少有一个风险信号（来自 blockers 兜底或关键词命中）
        assert!(signals.iter().any(|s| s.signal_type == "risk"), "signals={:?}", signals);
    }

    #[test]
    fn test_detect_milestone_signal() {
        let detector = HighValueSignalDetector::new();
        let episode = make_episode("Tauri 配置已完成，今日上线。");
        let signals = detector.detect_signals(&episode);
        assert!(signals.iter().any(|s| s.signal_type == "milestone"), "signals={:?}", signals);
    }

    #[test]
    fn test_detect_insight_signal() {
        let detector = HighValueSignalDetector::new();
        let episode = make_episode("发现 Tauri 的核心规律是 IPC 优先。");
        let signals = detector.detect_signals(&episode);
        assert!(signals.iter().any(|s| s.signal_type == "insight"), "signals={:?}", signals);
    }

    #[test]
    fn test_no_signals_for_empty_episode() {
        let detector = HighValueSignalDetector::new();
        let mut episode = make_episode("");
        episode.title = String::new();
        let signals = detector.detect_signals(&episode);
        assert!(signals.is_empty(), "signals={:?}", signals);
    }

    #[test]
    fn test_confidence_within_bounds() {
        let detector = HighValueSignalDetector::new();
        let episode = make_episode("决定采用 Tauri。");
        let signals = detector.detect_signals(&episode);
        for s in &signals {
            assert!(s.confidence >= 0.0 && s.confidence <= 0.95, "confidence={}", s.confidence);
        }
    }
}
