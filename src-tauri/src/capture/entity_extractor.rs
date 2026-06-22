//! EntityExtractor：实体提取器（对应 electron/capture/EntityExtractor.ts）
//!
//! 从 Episode 的 OCR 文本（聚合 segmentIds 对应 segments 的 ocr_text）提取实体：
//!  - 人名：中文姓名模式（2-4 字，姓氏常见字 + 名字）+ 英文 Firstname Lastname 模式
//!  - 项目名：任务单号前缀（如 ORD- → 订单）、窗口标题中的"XX项目"、"XX需求"
//!  - 文档：文件名模式（xxx.docx, xxx.pdf, xxx.md, xxx.xlsx）+ 窗口标题中的文档名
//!  - URL：http(s):// 链接
//!
//! 返回 EntityRef[]，去重。与 Episode 关联：更新 Episode.entities 字段。

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

use crate::models::{EntityRef, EntityRefType, Episode, WorkSegment};
use crate::repositories::episode_repository::EpisodeRepository;
use crate::repositories::segment_repository::SegmentRepository;

/// 常见中文姓氏（百家姓前 150）
fn common_surnames() -> &'static HashSet<&'static str> {
    static S: OnceLock<HashSet<&'static str>> = OnceLock::new();
    S.get_or_init(|| {
        let mut s = HashSet::new();
        for name in [
            "赵", "钱", "孙", "李", "周", "吴", "郑", "王", "冯", "陈",
            "褚", "卫", "蒋", "沈", "韩", "杨", "朱", "秦", "尤", "许",
            "何", "吕", "施", "张", "孔", "曹", "严", "华", "金", "魏",
            "陶", "姜", "戚", "谢", "邹", "喻", "柏", "水", "窦", "章",
            "云", "苏", "潘", "葛", "奚", "范", "彭", "郎", "鲁", "韦",
            "昌", "马", "苗", "凤", "花", "方", "俞", "任", "袁", "柳",
            "酆", "鲍", "史", "唐", "费", "廉", "岑", "薛", "雷", "贺",
            "倪", "汤", "滕", "殷", "罗", "毕", "郝", "邬", "安", "常",
            "乐", "于", "时", "傅", "皮", "卞", "齐", "康", "伍", "余",
            "元", "卜", "顾", "孟", "平", "黄", "和", "穆", "萧", "尹",
            "姚", "邵", "湛", "汪", "祁", "毛", "禹", "狄", "米", "贝",
            "明", "臧", "计", "伏", "成", "戴", "谈", "宋", "茅", "庞",
            "熊", "纪", "舒", "屈", "项", "祝", "董", "梁", "杜", "阮",
            "蓝", "闵", "席", "季", "麻", "强", "贾", "路", "娄", "危",
            "江", "童", "颜", "郭", "梅", "盛", "林", "刁", "钟", "徐",
        ] {
            s.insert(name);
        }
        s
    })
}

/// 非姓名的高频双字词
fn non_name_words() -> &'static HashSet<&'static str> {
    static S: OnceLock<HashSet<&'static str>> = OnceLock::new();
    S.get_or_init(|| {
        let mut s = HashSet::new();
        for w in [
            "我们", "你们", "他们", "她们", "它们", "这个", "那个", "什么", "怎么",
            "可以", "应该", "需要", "已经", "正在", "如果", "虽然", "但是", "因为",
            "所以", "不过", "然后", "其实", "一般", "通常", "总是", "从不", "偶尔",
            "现在", "今天", "明天", "昨天", "以后", "以前", "目前", "最近", "马上",
            "一下", "一些", "一切", "所有", "其他", "另外", "同时", "同一", "同样",
            "问题", "原因", "结果", "方法", "方式", "方向", "方面", "地方", "时候",
            "感觉", "觉得", "认为", "以为", "知道", "明白", "理解", "发现", "看到",
            "工作", "学习", "生活", "时间", "事情", "东西",
        ] {
            s.insert(w);
        }
        s
    })
}

/// 文件扩展名模式
fn file_extension_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)([\u4e00-\u9fff\w.-]+)\.(docx?|pdf|md|xlsx?|pptx?|txt|csv|json|html?|zip|rar|tar|gz)").unwrap()
    })
}

/// URL 正则
fn url_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r#"(?i)https?://[^\s<>"'，。、；：！？）】}]+"#).unwrap())
}

/// 任务单号正则
fn task_id_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"([A-Z]{2,})-(\d+)").unwrap())
}

/// 窗口标题中项目/需求模式
fn title_project_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"([\u4e00-\u9fff\w]{2,10})(项目|需求|功能|模块|系统|平台|工程)").unwrap())
}

/// 英文姓名模式
fn english_name_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\b([A-Z][a-z]{1,15})\s+([A-Z][a-z]{1,15})\b").unwrap())
}

/// 中文姓名正则（仅中文连续字符）
fn chinese_chars_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"([\u4e00-\u9fff]{2,4})").unwrap())
}

/// 强项目关键词
fn strong_project_keywords_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)(项目|工程|计划|方案|project)").unwrap())
}

/// 文档编辑器应用名
fn editor_app_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)(Word|Excel|WPS|Notion|Typora|PowerPoint|Pages|Keynote|Numbers|Obsidian)").unwrap())
}

/// 人名来源进程正则
fn person_source_process_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)(weixin|wechat|wxwork|dingtalk|feishu|lark|qq|slack|teams|telegram|discord)").unwrap())
}

/// 人名来源标题正则
fn person_source_title_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(微信|企业微信|钉钉|飞书|QQ|聊天|群聊|私聊|消息|对话|Slack|Teams|Telegram|Discord|IM)").unwrap())
}

/// 通用单字项目名
fn generic_project_words() -> &'static HashSet<&'static str> {
    static S: OnceLock<HashSet<&'static str>> = OnceLock::new();
    S.get_or_init(|| {
        let mut s = HashSet::new();
        for w in ["工作", "内容", "事情", "问题", "任务"] {
            s.insert(w);
        }
        s
    })
}

/// 常见顶级域名
fn common_tlds() -> &'static HashSet<&'static str> {
    static S: OnceLock<HashSet<&'static str>> = OnceLock::new();
    S.get_or_init(|| {
        let mut s = HashSet::new();
        for w in ["com", "org", "net", "cn", "io", "dev", "edu", "gov", "info", "biz"] {
            s.insert(w);
        }
        s
    })
}

/// 任务单号前缀 → 项目名映射
fn task_prefix_to_project(prefix: &str) -> Option<&'static str> {
    match prefix {
        "ORD" => Some("订单"),
        "PRD" => Some("需求"),
        "BUG" => Some("缺陷"),
        "ISSUE" => Some("Issue"),
        "PR" => Some("PR"),
        "MR" => Some("合并请求"),
        "TASK" => Some("任务"),
        "TODO" => Some("待办"),
        "JIRA" => Some("Jira"),
        "GIT" => Some("Git"),
        "API" => Some("API"),
        "DOC" => Some("文档"),
        "SPEC" => Some("规格"),
        "FEAT" => Some("功能"),
        "TEST" => Some("测试"),
        "DEV" => Some("开发"),
        "OPS" => Some("运维"),
        _ => None,
    }
}

/// 保留两位小数
fn round2(n: f64) -> f64 {
    let clamped = n.max(0.0).min(1.0);
    (clamped * 100.0).round() / 100.0
}

/// EntityExtractor：实体提取器。
pub struct EntityExtractor;

impl EntityExtractor {
    /// 创建 EntityExtractor 实例
    pub fn new() -> Self {
        Self
    }

    /// 从 Episode 提取实体。
    /// 聚合 segmentIds 对应 segments 的 ocr_text + windowTitle，提取人名/项目名/文档/URL。
    pub fn extract_from_episode(&self, episode: &Episode) -> Vec<EntityRef> {
        let segments = self.get_segments_for_episode(episode);
        let aggregated_text = self.aggregate_text(&segments);
        let window_titles: Vec<String> = segments.iter().map(|s| s.window_title.clone()).collect();
        let window_titles_joined = window_titles.join("\n");
        let source_hint = self.build_person_source_hint(&segments);

        self.extract_from_text(&aggregated_text, &window_titles_joined, &source_hint)
    }

    /// 从文本提取实体（OCR 文本 + 窗口标题）。
    /// 返回去重后的 EntityRef[]。
    pub fn extract_from_text(&self, ocr_text: &str, window_titles: &str, person_source_hint: &str) -> Vec<EntityRef> {
        let mut entities: Vec<EntityRef> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();

        let mut add_entity = |entity: EntityRef, entities: &mut Vec<EntityRef>, seen: &mut HashSet<String>| {
            let key = format!("{}:{}", entity.ref_type.as_str(), entity.name);
            if seen.insert(key) {
                entities.push(entity);
            }
        };

        // 1. 提取人名
        for person in Self::extract_persons(ocr_text, person_source_hint) {
            add_entity(person, &mut entities, &mut seen);
        }

        // 2. 提取项目名
        let full_text = format!("{}\n{}", ocr_text, window_titles);
        for project in Self::extract_projects(&full_text, window_titles) {
            add_entity(project, &mut entities, &mut seen);
        }

        // 3. 提取文档
        for doc in Self::extract_documents(&full_text) {
            add_entity(doc, &mut entities, &mut seen);
        }

        // 4. 提取 URL
        for url in Self::extract_urls(&full_text) {
            add_entity(url, &mut entities, &mut seen);
        }

        entities
    }

    /// 提取并保存指定日期所有 Episode 的实体。
    /// 更新每个 Episode 的 entities 字段。
    pub fn extract_and_save_for_date(&self, date: &str) -> anyhow::Result<()> {
        let episodes = EpisodeRepository::get_by_date(date)?;
        for episode in episodes {
            // 跳过每日总结 Episode
            if episode.topics.iter().any(|t| t == "__daily_summary__") {
                continue;
            }
            // 跳过用户编辑过的 Episode
            if episode.user_edited {
                continue;
            }

            let entities = self.extract_from_episode(&episode);
            let mut updated = episode.clone();
            updated.entities = entities;
            EpisodeRepository::update(&episode.id, updated)?;
        }
        Ok(())
    }

    // ===================== 内部提取方法 =====================

    /// 获取 Episode 关联的 Segments
    fn get_segments_for_episode(&self, episode: &Episode) -> Vec<WorkSegment> {
        let mut segments: Vec<WorkSegment> = Vec::new();
        for segment_id in &episode.segment_ids {
            if let Ok(Some(segment)) = SegmentRepository::get_by_id(segment_id) {
                if !segment.is_deleted {
                    segments.push(segment);
                }
            }
        }
        segments
    }

    /// 聚合 Segments 的 OCR 文本
    fn aggregate_text(&self, segments: &[WorkSegment]) -> String {
        segments
            .iter()
            .map(|s| s.ocr_text.clone())
            .filter(|t| t.len() > 0)
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 构建人名来源提示
    fn build_person_source_hint(&self, segments: &[WorkSegment]) -> String {
        segments
            .iter()
            .map(|s| {
                let mut parts = vec![s.app_name.clone(), s.process_name.clone(), s.window_title.clone()];
                if let Some(url) = &s.browser_url {
                    parts.push(url.clone());
                }
                parts.join(" ")
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 提取人名（中文姓名 + 英文姓名）
    fn extract_persons(text: &str, source_hint: &str) -> Vec<EntityRef> {
        if !Self::has_person_source_context(source_hint, text) {
            return vec![];
        }

        let mut persons: Vec<EntityRef> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();

        // 中文姓名提取
        for caps in chinese_chars_regex().captures_iter(text) {
            let name = caps.get(1).unwrap().as_str();
            if Self::is_valid_chinese_name(name) && seen.insert(name.to_string()) {
                persons.push(EntityRef {
                    ref_type: EntityRefType::Person,
                    name: name.to_string(),
                    value: None,
                    confidence: Self::compute_person_confidence(name),
                    user_confirmed: false,
                });
            }
        }

        // 英文姓名提取
        for caps in english_name_regex().captures_iter(text) {
            let full_name = format!("{} {}", &caps[1], &caps[2]);
            if seen.insert(full_name.clone()) {
                persons.push(EntityRef {
                    ref_type: EntityRefType::Person,
                    name: full_name,
                    value: None,
                    confidence: Self::compute_english_person_confidence(&caps[1], &caps[2]),
                    user_confirmed: false,
                });
            }
        }

        persons
    }

    fn has_person_source_context(source_hint: &str, text: &str) -> bool {
        let haystack = format!("{}\n{}", source_hint, text);
        person_source_process_regex().is_match(&haystack) || person_source_title_regex().is_match(&haystack)
    }

    /// 计算中文人名置信度
    fn compute_person_confidence(name: &str) -> f64 {
        let mut confidence = 0.5;
        let first_char = name.chars().next().map(|c| c.to_string());
        if let Some(first) = first_char {
            if common_surnames().contains(first.as_str()) {
                confidence += 0.2;
            }
        }
        let len = name.chars().count();
        if len >= 2 && len <= 3 {
            confidence += 0.2;
        }
        if len > 4 {
            confidence -= 0.3;
        }
        // 全中文检查
        let all_chinese = name.chars().all(|c| c.is_ascii() == false && ('\u{4e00}'..='\u{9fff}').contains(&c));
        if !all_chinese {
            confidence -= 0.2;
        }
        round2(confidence)
    }

    /// 计算英文人名置信度
    fn compute_english_person_confidence(first: &str, last: &str) -> f64 {
        let mut confidence = 0.55;
        let first_ok = first.len() >= 2 && first.chars().next().map(|c| c.is_uppercase()).unwrap_or(false)
            && first[1..].chars().all(|c| c.is_lowercase());
        let last_ok = last.len() >= 2 && last.chars().next().map(|c| c.is_uppercase()).unwrap_or(false)
            && last[1..].chars().all(|c| c.is_lowercase());
        if first_ok && last_ok {
            confidence += 0.15;
        }
        if (first.len() >= 2 && first.len() <= 15) && (last.len() >= 2 && last.len() <= 15) {
            confidence += 0.1;
        }
        round2(confidence)
    }

    /// 验证是否为有效中文姓名
    fn is_valid_chinese_name(name: &str) -> bool {
        let len = name.chars().count();
        if len < 2 || len > 4 {
            return false;
        }
        let first_char = name.chars().next().map(|c| c.to_string());
        let first = match first_char {
            Some(f) => f,
            None => return false,
        };
        if !common_surnames().contains(first.as_str()) {
            return false;
        }
        // 所有字符必须是中文
        if !name.chars().all(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)) {
            return false;
        }
        // 排除高频非姓名词
        if non_name_words().contains(name) {
            return false;
        }
        true
    }

    /// 提取项目名
    fn extract_projects(text: &str, window_titles: &str) -> Vec<EntityRef> {
        let mut projects: Vec<EntityRef> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();

        // 从任务单号前缀提取
        for caps in task_id_regex().captures_iter(text) {
            let prefix = caps.get(1).unwrap().as_str();
            let num = caps.get(2).unwrap().as_str();
            if let Some(project_name) = task_prefix_to_project(prefix) {
                if seen.insert(project_name.to_string()) {
                    projects.push(EntityRef {
                        ref_type: EntityRefType::Project,
                        name: project_name.to_string(),
                        value: Some(format!("{}-{}", prefix, num)),
                        confidence: Self::compute_project_confidence(project_name, false, true),
                        user_confirmed: false,
                    });
                }
            }
        }

        // 从窗口标题提取项目/需求名
        for caps in title_project_regex().captures_iter(window_titles) {
            let project_name = format!("{}{}", &caps[1], &caps[2]);
            if project_name.chars().count() >= 3 && seen.insert(project_name.clone()) {
                projects.push(EntityRef {
                    ref_type: EntityRefType::Project,
                    name: project_name.clone(),
                    value: None,
                    confidence: Self::compute_project_confidence(&project_name, true, true),
                    user_confirmed: false,
                });
            }
        }

        projects
    }

    /// 计算项目名置信度
    fn compute_project_confidence(name: &str, from_window_title: bool, matches_pattern: bool) -> f64 {
        let mut confidence = 0.4;
        if from_window_title && strong_project_keywords_regex().is_match(name) {
            confidence += 0.3;
        }
        if matches_pattern {
            confidence += 0.2;
        }
        if generic_project_words().contains(name) || name.chars().count() <= 1 {
            confidence -= 0.2;
        }
        round2(confidence)
    }

    /// 提取文档（文件名）
    fn extract_documents(text: &str) -> Vec<EntityRef> {
        let mut documents: Vec<EntityRef> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let has_editor_context = editor_app_regex().is_match(text);

        for caps in file_extension_regex().captures_iter(text) {
            let file_name = caps.get(0).unwrap().as_str().to_string();
            if seen.insert(file_name.clone()) {
                documents.push(EntityRef {
                    ref_type: EntityRefType::Document,
                    name: file_name.clone(),
                    value: None,
                    confidence: Self::compute_document_confidence(&file_name, has_editor_context),
                    user_confirmed: false,
                });
            }
        }

        documents
    }

    /// 计算文档置信度
    fn compute_document_confidence(file_name: &str, has_editor_context: bool) -> f64 {
        let mut confidence = 0.6;
        let ext_re = Regex::new(r"(?i)\.(docx?|pdf|md|xlsx?|pptx?|txt|csv|json|html?|zip|rar|tar|gz)$").unwrap();
        let has_extension = ext_re.is_match(file_name);
        if has_extension {
            confidence += 0.2;
        }
        if has_editor_context {
            confidence += 0.1;
        }
        if !has_extension && !has_editor_context {
            confidence -= 0.3;
        }
        round2(confidence)
    }

    /// 提取 URL
    fn extract_urls(text: &str) -> Vec<EntityRef> {
        let mut urls: Vec<EntityRef> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();

        for m in url_regex().find_iter(text) {
            let url = m.as_str().to_string();
            if seen.insert(url.clone()) {
                let confidence = Self::compute_url_confidence(&url);
                urls.push(EntityRef {
                    ref_type: EntityRefType::Url,
                    name: url.clone(),
                    value: Some(url),
                    confidence,
                    user_confirmed: false,
                });
            }
        }

        urls
    }

    /// 计算 URL 置信度
    fn compute_url_confidence(url: &str) -> f64 {
        let mut confidence = 0.7;
        let scheme_re = Regex::new(r"(?i)^https?://").unwrap();
        if scheme_re.is_match(url) {
            confidence += 0.2;
        }
        let host_re = Regex::new(r"(?i)^https?://([^/?#]+)").unwrap();
        if let Some(caps) = host_re.captures(url) {
            let host = caps.get(1).unwrap().as_str();
            if let Some(tld) = host.split('.').last() {
                if common_tlds().contains(tld.to_lowercase().as_str()) {
                    confidence += 0.1;
                }
            }
        }
        let path_re = Regex::new(r"^[A-Za-z]:[\\/]").unwrap();
        if path_re.is_match(url) || url.starts_with('/') {
            confidence -= 0.3;
        }
        round2(confidence)
    }
}

impl Default for EntityExtractor {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_chinese_person() {
        let text = "张三 说明了需求";
        let source_hint = "微信 聊天";
        let entities = EntityExtractor::new().extract_from_text(text, "", source_hint);
        let persons: Vec<_> = entities.iter().filter(|e| e.ref_type == EntityRefType::Person).collect();
        assert!(!persons.is_empty());
        assert!(persons.iter().any(|p| p.name == "张三"));
    }

    #[test]
    fn test_extract_english_person() {
        let text = "John Smith will join the meeting";
        let source_hint = "Slack chat";
        let entities = EntityExtractor::new().extract_from_text(text, "", source_hint);
        let persons: Vec<_> = entities.iter().filter(|e| e.ref_type == EntityRefType::Person).collect();
        assert!(persons.iter().any(|p| p.name == "John Smith"));
    }

    #[test]
    fn test_extract_person_requires_source_context() {
        let text = "张三说明天开会";
        // 无聊天上下文，不应提取人名
        let entities = EntityExtractor::new().extract_from_text(text, "", "");
        let persons: Vec<_> = entities.iter().filter(|e| e.ref_type == EntityRefType::Person).collect();
        assert!(persons.is_empty());
    }

    #[test]
    fn test_extract_project_from_task_id() {
        let text = "ORD-123 处理订单";
        let entities = EntityExtractor::new().extract_from_text(text, "", "");
        let projects: Vec<_> = entities.iter().filter(|e| e.ref_type == EntityRefType::Project).collect();
        assert!(projects.iter().any(|p| p.name == "订单"));
    }

    #[test]
    fn test_extract_project_from_title() {
        let window_titles = "WorkMemory项目";
        let entities = EntityExtractor::new().extract_from_text("", window_titles, "");
        let projects: Vec<_> = entities.iter().filter(|e| e.ref_type == EntityRefType::Project).collect();
        assert!(projects.iter().any(|p| p.name.contains("项目")));
    }

    #[test]
    fn test_extract_document() {
        let text = "查看 report.docx 和 data.xlsx";
        let entities = EntityExtractor::new().extract_from_text(text, "", "");
        let docs: Vec<_> = entities.iter().filter(|e| e.ref_type == EntityRefType::Document).collect();
        assert!(!docs.is_empty());
        assert!(docs.iter().any(|d| d.name.contains("report.docx")));
    }

    #[test]
    fn test_extract_url() {
        let text = "访问 https://github.com 查看代码";
        let entities = EntityExtractor::new().extract_from_text(text, "", "");
        let urls: Vec<_> = entities.iter().filter(|e| e.ref_type == EntityRefType::Url).collect();
        assert!(!urls.is_empty());
        assert!(urls.iter().any(|u| u.name.contains("github.com")));
    }

    #[test]
    fn test_is_valid_chinese_name() {
        assert!(EntityExtractor::is_valid_chinese_name("张三"));
        assert!(EntityExtractor::is_valid_chinese_name("李四"));
        assert!(!EntityExtractor::is_valid_chinese_name("我们"));
        assert!(!EntityExtractor::is_valid_chinese_name("张"));
        assert!(!EntityExtractor::is_valid_chinese_name("张三李四王"));
    }
}
