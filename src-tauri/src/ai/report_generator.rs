//! ReportGenerator：日报生成器（对应 electron/ai/ReportGenerator.ts）
//!
//! 流程：
//!  1. 加载当日 segments（从 SegmentRepository.getActiveByDate）
//!  2. 构建 timeline 文本（每个 segment 的时间、标题、OCR 摘要）
//!  3. 提取 projectTags（从 segment.tags 聚合）
//!  4. 选模板（enhanced/concise/okr/structured/standup）→ 渲染提示词
//!  5. 调 OpenAIClient.chat_completion（API Key 从 SettingsStore 读取）
//!  6. 脱敏处理（SensitiveMasker）
//!  7. 返回 markdown + aiInputSnapshot + usage
//!
//! 与 TypeScript 版本的差异：
//!  - 简化为基于 segment 的生成路径（不依赖 Episode/CleanEpisode 快照）
//!  - structured 模板走规则生成（不调用 AI JSON 模式）
//!  - 不实现交叉校验（crossValidate）与 distill_runs 失败原因查询

use anyhow::Result;
use uuid::Uuid;

use crate::ai::openai_client::{ChatCompletionRequest, Message, OpenAIClient, Usage};
use crate::ai::sensitive_masker::mask_sensitive;
use crate::ai::templates::{get_template, render_user_prompt, TemplateParams};
use crate::models::{Report, ReportStatus, ReportTemplate, ReportType, WorkSegment};
use crate::repositories::report_repository::ReportRepository;
use crate::repositories::segment_repository::SegmentRepository;
use crate::repositories::settings_store::SettingsStore;

/// 日报生成结果
#[derive(Debug, Clone)]
pub struct GenerateReportResult {
    /// 生成的 Markdown 文本（已脱敏）
    pub markdown: String,
    /// 发送给 AI 的输入快照（JSON 字符串，用于存档审计）
    pub ai_input_snapshot: String,
    /// 参与生成的 segment id 列表
    pub segment_ids: Vec<String>,
    /// token 用量
    pub usage: Usage,
    /// 警告文本（若为空字符串则无警告）
    pub warning: String,
    /// 已脱敏的敏感信息数量
    pub masked_count: u32,
}

/// 获取当前 ISO 时间戳
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 构建 timeline 文本：每个 segment 的时间、标题、OCR 摘要
fn build_timeline(segments: &[WorkSegment]) -> String {
    if segments.is_empty() {
        return "（无勾选片段）".to_string();
    }
    let mut lines: Vec<String> = Vec::new();
    for seg in segments {
        lines.push(format!(
            "### {} - {} | {}",
            seg.start_time, seg.end_time, seg.window_title
        ));
        // 应用与窗口标题摘要（去重）
        let label = if !seg.app_name.is_empty() {
            seg.app_name.clone()
        } else if !seg.process_name.is_empty() {
            seg.process_name.clone()
        } else {
            "未知应用".to_string()
        };
        lines.push(format!("- 涉及应用：{}", label));
        // OCR 摘要：取 ocr_summary 或 ocr_text 前 200 字
        let ocr_summary = if !seg.ocr_summary.is_empty() {
            seg.ocr_summary.clone()
        } else if !seg.ocr_text.is_empty() {
            seg.ocr_text.chars().take(200).collect()
        } else {
            String::new()
        };
        if !ocr_summary.is_empty() {
            lines.push(format!("- 内容摘要：{}", ocr_summary));
        }
        // 证据片段：取 ocr_text 前 2 条非空行，每行截断 ≤80 字
        let evidence_lines: Vec<String> = seg
            .ocr_text
            .split('\n')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .take(2)
            .map(|s| s.chars().take(80).collect())
            .collect();
        if !evidence_lines.is_empty() {
            lines.push(format!("- 证据片段：{}", evidence_lines.join(" | ")));
        }
        lines.push(String::new());
    }
    lines.join("\n")
}

/// 构建项目标签数组：从 segments.tags 聚合
fn build_project_tags(segments: &[WorkSegment]) -> Vec<String> {
    let mut tag_set = std::collections::HashSet::new();
    for seg in segments {
        for t in &seg.tags {
            if !t.is_empty() {
                tag_set.insert(t.clone());
            }
        }
    }
    tag_set.into_iter().collect()
}

/// 构建 aiInputSnapshot：JSON 序列化，用于存档审计
fn build_ai_input_snapshot(
    date: &str,
    template: &ReportTemplate,
    segments: &[WorkSegment],
    timeline: &str,
    project_tags: &[String],
    user_notes: &str,
) -> String {
    let template_def = get_template(template);
    let snapshot = serde_json::json!({
        "date": date,
        "templateId": template.as_str(),
        "templateName": template_def.name,
        "userNotes": user_notes,
        "projectTags": project_tags,
        "segmentCount": segments.len(),
        "segmentIds": segments.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
        "ocrSummaries": segments.iter().map(|s| {
            if !s.ocr_summary.is_empty() {
                s.ocr_summary.clone()
            } else {
                s.ocr_text.chars().take(200).collect::<String>()
            }
        }).filter(|s| !s.is_empty()).collect::<Vec<_>>(),
        "timelineText": timeline,
    });
    serde_json::to_string_pretty(&snapshot).unwrap_or_default()
}

/// 基于规则生成日报（AI 不可用时的降级路径）
fn build_rule_based_report(
    date: &str,
    segments: &[WorkSegment],
    project_tags: &[String],
    user_notes: &str,
) -> String {
    let mut lines: Vec<String> = vec![format!("# 工作日报 {}", date)];

    if !user_notes.is_empty() {
        lines.push(format!("## 用户备注\n\n{}", user_notes));
    }

    // 今日概览：取每个 segment 的 ocr_summary 或 window_title
    let summaries: Vec<String> = segments
        .iter()
        .map(|s| {
            if !s.ocr_summary.is_empty() {
                s.ocr_summary.clone()
            } else {
                s.window_title.clone()
            }
        })
        .filter(|s| !s.trim().is_empty())
        .take(12)
        .collect();
    if !summaries.is_empty() {
        lines.push(format!(
            "## 今日概览\n\n{}",
            summaries.iter().map(|s| format!("- {}", s)).collect::<Vec<_>>().join("\n")
        ));
    }

    if !project_tags.is_empty() {
        lines.push(format!(
            "## 相关主题\n\n{}",
            project_tags.iter().take(20).map(|t| format!("- {}", t)).collect::<Vec<_>>().join("\n")
        ));
    }

    // 时间线
    let timeline: String = segments
        .iter()
        .map(|s| {
            let mut details: Vec<String> = vec![format!(
                "- **{} - {}** {}",
                s.start_time, s.end_time, s.window_title
            )];
            if !s.ocr_summary.is_empty() {
                details.push(format!("  - 摘要：{}", s.ocr_summary));
            }
            details.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n");
    if !timeline.is_empty() {
        lines.push(format!("## 时间线\n\n{}", timeline));
    }

    lines.push("## 说明\n\n本日报由本地规则基于勾选片段生成，未使用截图内容。".to_string());
    lines.join("\n\n")
}

/// ReportGenerator：日报生成器
pub struct ReportGenerator;

impl ReportGenerator {
    pub fn new() -> Self {
        ReportGenerator
    }

    /// 生成日报并保存到数据库。
    ///
    /// # 参数
    /// - `date`：日期 YYYY-MM-DD
    /// - `template`：报告模板
    /// - `user_notes`：用户备注
    ///
    /// # 返回
    /// 生成结果（含 markdown、aiInputSnapshot、segmentIds、usage、warning、maskedCount）
    pub async fn generate_report(
        &self,
        date: &str,
        template: ReportTemplate,
        user_notes: &str,
    ) -> Result<GenerateReportResult> {
        // 1. 加载当日 segments
        let segments = SegmentRepository::get_active_by_date(date)?;
        if segments.is_empty() {
            return Err(anyhow::anyhow!("未找到可用的工作片段，请至少勾选一条内容。"));
        }

        // 2. 构建 timeline / projectTags
        let raw_timeline = build_timeline(&segments);
        let masked = mask_sensitive(&raw_timeline);
        let timeline = masked.text;
        let project_tags = build_project_tags(&segments);
        let segment_ids: Vec<String> = segments.iter().map(|s| s.id.clone()).collect();

        // 3. 构建 aiInputSnapshot
        let ai_input_snapshot = build_ai_input_snapshot(
            date,
            &template,
            &segments,
            &timeline,
            &project_tags,
            user_notes,
        );

        // 4. 检查 API 配置
        let api_key = SettingsStore::get_api_key();
        if api_key.is_empty() {
            // API Key 未配置，降级为规则生成
            let markdown = build_rule_based_report(date, &segments, &project_tags, user_notes);
            let masked_md = mask_sensitive(&markdown);
            return Ok(GenerateReportResult {
                markdown: masked_md.text,
                ai_input_snapshot,
                segment_ids,
                usage: Usage::default(),
                warning: "未配置 AI API Key，使用规则生成日报".to_string(),
                masked_count: masked.masked_count + masked_md.masked_count,
            });
        }

        // 5. 渲染模板提示词
        let template_def = get_template(&template);
        let template_params = TemplateParams {
            timeline: timeline.clone(),
            user_notes: user_notes.to_string(),
            project_tags: project_tags.join("、"),
            date: date.to_string(),
            ..Default::default()
        };
        let user_prompt = render_user_prompt(&template, &template_params);

        // 6. 调用 AI
        let model = SettingsStore::get().model_name;
        let req = ChatCompletionRequest::new(
            model,
            vec![
                Message::new("system", template_def.system_prompt),
                Message::new("user", user_prompt),
            ],
        );
        let client = OpenAIClient::new();

        let (content, usage, warning) = match client.chat_completion(req).await {
            Ok(resp) => (resp.content, resp.usage.unwrap_or_default(), String::new()),
            Err(e) => {
                // AI 调用失败，降级为规则生成
                let rule_markdown =
                    build_rule_based_report(date, &segments, &project_tags, user_notes);
                let warning = format!(
                    "AI 生成失败：{}，已使用勾选片段在本地生成客观日报草稿",
                    e
                );
                (rule_markdown, Usage::default(), warning)
            }
        };

        // 7. 脱敏处理
        let masked_md = mask_sensitive(&content);

        Ok(GenerateReportResult {
            markdown: masked_md.text,
            ai_input_snapshot,
            segment_ids,
            usage,
            warning,
            masked_count: masked.masked_count + masked_md.masked_count,
        })
    }

    /// 生成日报并保存到数据库。
    ///
    /// # 参数
    /// - `date`：日期 YYYY-MM-DD
    /// - `template`：报告模板
    /// - `user_notes`：用户备注
    ///
    /// # 返回
    /// 已保存的 Report 对象（status='draft'）
    pub async fn generate_and_save(
        &self,
        date: &str,
        template: ReportTemplate,
        user_notes: &str,
    ) -> Result<Report> {
        let result = self
            .generate_report(date, template.clone(), user_notes)
            .await?;
        let template_def = get_template(&template);

        let report = Report {
            id: Uuid::new_v4().to_string(),
            date: date.to_string(),
            template_id: template,
            template_name: template_def.name,
            segment_ids: result.segment_ids,
            ai_input_snapshot: result.ai_input_snapshot,
            markdown_content: result.markdown,
            status: ReportStatus::Draft,
            report_type: ReportType::Daily,
        };

        let saved = ReportRepository::insert(report)?;
        Ok(saved)
    }

    /// 测试 API 连接（发送一个极简 ping 请求）。
    pub async fn test_connection(&self) -> Result<bool> {
        let api_key = SettingsStore::get_api_key();
        if api_key.is_empty() {
            return Ok(false);
        }
        let client = OpenAIClient::new();
        client.test_connection().await
    }
}

impl Default for ReportGenerator {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CaptureSource, SourceQuality, SourceStatus};

    /// 构造测试用 WorkSegment
    fn make_segment(id: &str, title: &str, ocr: &str) -> WorkSegment {
        WorkSegment {
            id: id.to_string(),
            date: "2026-06-22".to_string(),
            start_time: "10:00:00".to_string(),
            end_time: "11:00:00".to_string(),
            duration_seconds: 3600,
            app_name: "VSCode".to_string(),
            process_name: "Code".to_string(),
            window_title: title.to_string(),
            ocr_text: ocr.to_string(),
            ocr_summary: String::new(),
            image_hash: String::new(),
            screenshot_path: String::new(),
            is_selected_for_report: true,
            is_private: false,
            is_important: false,
            is_deleted: false,
            source_status: SourceStatus::OcrDone,
            user_title: String::new(),
            user_summary: String::new(),
            user_note: String::new(),
            tags: vec!["WorkMemory".to_string()],
            ocr_blocks: vec![],
            ocr_confidence: 0.9,
            capture_source: CaptureSource::ActiveWindow,
            source_quality: SourceQuality::High,
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

    /// 测试 build_timeline
    #[test]
    fn test_build_timeline() {
        let segments = vec![
            make_segment("1", "main.rs", "fn main() { }"),
            make_segment("2", "test.rs", "assert_eq!(1, 1);"),
        ];
        let timeline = build_timeline(&segments);
        assert!(timeline.contains("main.rs"));
        assert!(timeline.contains("test.rs"));
        assert!(timeline.contains("VSCode"));
    }

    /// 测试 build_timeline 空数据
    #[test]
    fn test_build_timeline_empty() {
        let timeline = build_timeline(&[]);
        assert_eq!(timeline, "（无勾选片段）");
    }

    /// 测试 build_project_tags
    #[test]
    fn test_build_project_tags() {
        let segments = vec![
            make_segment("1", "title1", "ocr"),
            make_segment("2", "title2", "ocr"),
        ];
        let tags = build_project_tags(&segments);
        assert!(tags.contains(&"WorkMemory".to_string()));
    }

    /// 测试 build_rule_based_report
    #[test]
    fn test_build_rule_based_report() {
        let segments = vec![make_segment("1", "main.rs", "fn main() { }")];
        let project_tags = vec!["WorkMemory".to_string()];
        let report = build_rule_based_report("2026-06-22", &segments, &project_tags, "今日专注");
        assert!(report.contains("# 工作日报 2026-06-22"));
        assert!(report.contains("## 用户备注"));
        assert!(report.contains("今日专注"));
        assert!(report.contains("## 相关主题"));
        assert!(report.contains("WorkMemory"));
        assert!(report.contains("## 时间线"));
        assert!(report.contains("main.rs"));
    }

    /// 测试 build_ai_input_snapshot
    #[test]
    fn test_build_ai_input_snapshot() {
        let segments = vec![make_segment("1", "main.rs", "fn main() { }")];
        let snapshot = build_ai_input_snapshot(
            "2026-06-22",
            &ReportTemplate::Enhanced,
            &segments,
            "timeline",
            &["tag1".to_string()],
            "notes",
        );
        assert!(snapshot.contains("2026-06-22"));
        assert!(snapshot.contains("enhanced"));
        assert!(snapshot.contains("汇报优化版"));
    }

    /// 测试 ReportGenerator 创建
    #[test]
    fn test_report_generator_new() {
        let _gen = ReportGenerator::new();
    }
}
