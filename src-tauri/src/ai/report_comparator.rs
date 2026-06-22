//! ReportComparator：报告历史对比器（F8.11）
//!
//! 功能：
//!  - compare(report_id_a, report_id_b)：对比两份报告
//!  - 提取每份报告的项目列表与总专注时长
//!  - 计算新增/移除项目、各项目时长变化百分比
//!  - 生成高亮摘要（highlights）
//!
//! 用于"对比模式"查看报告演进趋势。

use serde::{Deserialize, Serialize};

use crate::models::Report;
use crate::repositories::report_repository::ReportRepository;
use crate::repositories::segment_repository::SegmentRepository;

/// 报告摘要
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSummary {
    /// 报告 ID
    pub id: String,
    /// 报告日期 YYYY-MM-DD
    pub date: String,
    /// 涉及项目列表（去重）
    pub projects: Vec<String>,
    /// 总专注时长（毫秒）
    pub total_focus_ms: u64,
}

/// 单个项目时长变化
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTimeChange {
    /// 项目名
    pub project: String,
    /// 报告 A 中的时长（毫秒）
    pub time_a_ms: u64,
    /// 报告 B 中的时长（毫秒）
    pub time_b_ms: u64,
    /// 变化百分比（-100 ~ +∞，B 相对 A）
    pub change_pct: f64,
}

/// 报告对比结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportComparison {
    /// 报告 A 摘要
    pub report_a: ReportSummary,
    /// 报告 B 摘要
    pub report_b: ReportSummary,
    /// 新增项目（B 有 A 无）
    pub added_projects: Vec<String>,
    /// 移除项目（A 有 B 无）
    pub removed_projects: Vec<String>,
    /// 各项目时长变化
    pub time_changes: Vec<ProjectTimeChange>,
    /// 高亮摘要
    pub highlights: Vec<String>,
}

/// ReportComparator：报告历史对比器
pub struct ReportComparator;

impl ReportComparator {
    /// 创建实例
    pub fn new() -> Self {
        ReportComparator
    }

    /// 对比两份报告。
    ///
    /// 流程：
    ///  1. 加载两份报告
    ///  2. 按 segment_ids 加载关联 segments
    ///  3. 聚合 projects（segment.tags）与 total_focus_ms
    ///  4. 计算新增/移除项目、时长变化
    ///  5. 生成高亮摘要
    pub fn compare(&self, report_id_a: &str, report_id_b: &str) -> anyhow::Result<ReportComparison> {
        let report_a = ReportRepository::get_by_id(report_id_a)?
            .ok_or_else(|| anyhow::anyhow!("报告 A 不存在: {}", report_id_a))?;
        let report_b = ReportRepository::get_by_id(report_id_b)?
            .ok_or_else(|| anyhow::anyhow!("报告 B 不存在: {}", report_id_b))?;

        let summary_a = self.build_summary(&report_a)?;
        let summary_b = self.build_summary(&report_b)?;

        // 新增/移除项目
        let set_a: std::collections::HashSet<String> =
            summary_a.projects.iter().cloned().collect();
        let set_b: std::collections::HashSet<String> =
            summary_b.projects.iter().cloned().collect();
        let added_projects: Vec<String> = set_b.difference(&set_a).cloned().collect();
        let removed_projects: Vec<String> = set_a.difference(&set_b).cloned().collect();

        // 各项目时长变化
        let time_a_map = self.compute_project_time_ms(&report_a)?;
        let time_b_map = self.compute_project_time_ms(&report_b)?;
        let all_projects: std::collections::HashSet<String> =
            time_a_map.keys().chain(time_b_map.keys()).cloned().collect();
        let mut time_changes: Vec<ProjectTimeChange> = Vec::new();
        for project in &all_projects {
            let t_a = *time_a_map.get(project).unwrap_or(&0);
            let t_b = *time_b_map.get(project).unwrap_or(&0);
            let change_pct = compute_change_pct(t_a, t_b);
            time_changes.push(ProjectTimeChange {
                project: project.clone(),
                time_a_ms: t_a,
                time_b_ms: t_b,
                change_pct,
            });
        }
        // 按变化幅度降序
        time_changes.sort_by(|a, b| {
            b.change_pct.abs()
                .partial_cmp(&a.change_pct.abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        // 生成高亮摘要
        let highlights = self.generate_highlights(
            &summary_a,
            &summary_b,
            &added_projects,
            &removed_projects,
            &time_changes,
        );

        Ok(ReportComparison {
            report_a: summary_a,
            report_b: summary_b,
            added_projects,
            removed_projects,
            time_changes,
            highlights,
        })
    }

    /// 构建报告摘要
    fn build_summary(&self, report: &Report) -> anyhow::Result<ReportSummary> {
        let project_time_map = self.compute_project_time_ms(report)?;
        let projects: Vec<String> = {
            let mut v: Vec<String> = project_time_map.keys().cloned().collect();
            v.sort();
            v
        };
        let total_focus_ms: u64 = project_time_map.values().sum();
        Ok(ReportSummary {
            id: report.id.clone(),
            date: report.date.clone(),
            projects,
            total_focus_ms,
        })
    }

    /// 计算报告内各项目的专注时长（毫秒）
    ///
    /// 通过 segment_ids 加载 segments，按 tags 聚合 duration_seconds。
    fn compute_project_time_ms(&self, report: &Report) -> anyhow::Result<std::collections::HashMap<String, u64>> {
        if report.segment_ids.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let segments = SegmentRepository::get_by_ids(&report.segment_ids)?;
        let mut map: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        for seg in segments {
            let dur_ms = (seg.duration_seconds.max(0) as u64) * 1000;
            if dur_ms == 0 {
                continue;
            }
            for tag in &seg.tags {
                if tag.is_empty() {
                    continue;
                }
                *map.entry(tag.clone()).or_insert(0) += dur_ms;
            }
            // 若无 tags，归入 "未分类"
            if seg.tags.is_empty() {
                *map.entry("未分类".to_string()).or_insert(0) += dur_ms;
            }
        }
        Ok(map)
    }

    /// 生成高亮摘要
    fn generate_highlights(
        &self,
        summary_a: &ReportSummary,
        summary_b: &ReportSummary,
        added_projects: &[String],
        removed_projects: &[String],
        time_changes: &[ProjectTimeChange],
    ) -> Vec<String> {
        let mut highlights: Vec<String> = Vec::new();

        // 总专注时长变化
        let focus_change_pct = compute_change_pct(summary_a.total_focus_ms, summary_b.total_focus_ms);
        if focus_change_pct.abs() > 0.01 {
            let direction = if focus_change_pct > 0.0 { "增长" } else { "下降" };
            highlights.push(format!(
                "总专注时长{} {:.0}%（{} → {} ms）",
                direction,
                focus_change_pct.abs(),
                summary_a.total_focus_ms,
                summary_b.total_focus_ms
            ));
        }

        // 新增项目
        if !added_projects.is_empty() {
            highlights.push(format!("新增项目：{}", added_projects.join("、")));
        }
        // 移除项目
        if !removed_projects.is_empty() {
            highlights.push(format!("移除项目：{}", removed_projects.join("、")));
        }

        // Top 3 时长变化最大的项目
        let top_changes: Vec<&ProjectTimeChange> = time_changes
            .iter()
            .filter(|c| c.change_pct.abs() > 0.05) // 变化 > 5%
            .take(3)
            .collect();
        for c in top_changes {
            let direction = if c.change_pct > 0.0 { "增长" } else { "下降" };
            highlights.push(format!(
                "「{}」时长{} {:.0}%",
                c.project, direction, c.change_pct.abs()
            ));
        }

        highlights
    }
}

impl Default for ReportComparator {
    fn default() -> Self {
        Self::new()
    }
}

/// 计算变化百分比（B 相对 A）。
/// - A=0, B>0 → +100%
/// - A=0, B=0 → 0%
/// - A>0 → (B-A)/A * 100
fn compute_change_pct(a_ms: u64, b_ms: u64) -> f64 {
    if a_ms == 0 {
        return if b_ms == 0 { 0.0 } else { 100.0 };
    }
    let diff = b_ms as f64 - a_ms as f64;
    (diff / a_ms as f64) * 100.0
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_change_pct_both_zero() {
        assert_eq!(compute_change_pct(0, 0), 0.0);
    }

    #[test]
    fn test_compute_change_pct_a_zero_b_positive() {
        assert_eq!(compute_change_pct(0, 100), 100.0);
    }

    #[test]
    fn test_compute_change_pct_normal_increase() {
        // 100 → 150，增长 50%
        let pct = compute_change_pct(100, 150);
        assert!((pct - 50.0).abs() < 1e-9);
    }

    #[test]
    fn test_compute_change_pct_normal_decrease() {
        // 200 → 100，下降 50%
        let pct = compute_change_pct(200, 100);
        assert!((pct - (-50.0)).abs() < 1e-9);
    }

    #[test]
    fn test_generate_highlights_empty() {
        let comparator = ReportComparator::new();
        let summary_a = ReportSummary {
            id: "a".to_string(),
            date: "2026-06-20".to_string(),
            projects: vec![],
            total_focus_ms: 0,
        };
        let summary_b = summary_a.clone();
        let highlights = comparator.generate_highlights(
            &summary_a,
            &summary_b,
            &[],
            &[],
            &[],
        );
        // 无变化时应无高亮
        assert!(highlights.is_empty());
    }

    #[test]
    fn test_generate_highlights_with_changes() {
        let comparator = ReportComparator::new();
        let summary_a = ReportSummary {
            id: "a".to_string(),
            date: "2026-06-20".to_string(),
            projects: vec!["P1".to_string()],
            total_focus_ms: 1000,
        };
        let summary_b = ReportSummary {
            id: "b".to_string(),
            date: "2026-06-21".to_string(),
            projects: vec!["P1".to_string(), "P2".to_string()],
            total_focus_ms: 1500,
        };
        let time_changes = vec![ProjectTimeChange {
            project: "P1".to_string(),
            time_a_ms: 1000,
            time_b_ms: 1500,
            change_pct: 50.0,
        }];
        let highlights = comparator.generate_highlights(
            &summary_a,
            &summary_b,
            &["P2".to_string()],
            &[],
            &time_changes,
        );
        // 应包含总专注时长增长、新增项目、P1 时长增长
        assert!(highlights.iter().any(|h| h.contains("总专注时长")));
        assert!(highlights.iter().any(|h| h.contains("新增项目")));
        assert!(highlights.iter().any(|h| h.contains("P1")));
    }

    #[test]
    fn test_report_summary_serialization() {
        let summary = ReportSummary {
            id: "r1".to_string(),
            date: "2026-06-22".to_string(),
            projects: vec!["A".to_string(), "B".to_string()],
            total_focus_ms: 3600000,
        };
        let json = serde_json::to_string(&summary).expect("序列化失败");
        assert!(json.contains("\"id\":\"r1\""));
        assert!(json.contains("\"totalFocusMs\":3600000"));
    }

    #[test]
    fn test_project_time_change_serialization() {
        let change = ProjectTimeChange {
            project: "P1".to_string(),
            time_a_ms: 1000,
            time_b_ms: 2000,
            change_pct: 100.0,
        };
        let json = serde_json::to_string(&change).expect("序列化失败");
        assert!(json.contains("\"project\":\"P1\""));
        assert!(json.contains("\"changePct\":100.0"));
    }
}
