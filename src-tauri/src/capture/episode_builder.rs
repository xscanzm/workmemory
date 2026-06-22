//! EpisodeBuilder：Episode 语义合并引擎（对应 electron/capture/EpisodeBuilder.ts）
//!
//! 将连续的 Segment 片段合成人类可理解的 Episode 工作事件。
//!
//! 合并算法：
//!  1. 时间连续性：相邻 Segment 时间差 <5 分钟
//!  2. 语义相似度：OCR 关键词一致（Jaccard >0.3）或窗口标题含相同任务单号
//!  3. 应用频繁切换融合：10 分钟内 ≥3 个不同应用但关键词指向同一主题 → 融合
//!
//! 合并产出 Episode：title、one_line_summary、segmentIds、entities、topics、startTime、endTime
//!
//! 持久化：删除该日期旧 Episodes（非 user_edited）→ 插入新 Episodes；
//!        保留 user_edited 的 Episode 不动。

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;
use uuid::Uuid;

use crate::events::bus::{AppEvent, EventBus};
use crate::models::{ActivityType, Episode, WorkSegment};
use crate::repositories::episode_repository::EpisodeRepository;
use crate::repositories::segment_repository::SegmentRepository;

/// 时间连续性阈值（秒）：相邻 Segment 时间差 <5 分钟
pub const TIME_CONTINUITY_THRESHOLD_SEC: i64 = 5 * 60;
/// 应用频繁切换融合窗口（秒）：10 分钟
pub const APP_SWITCH_FUSION_WINDOW_SEC: i64 = 10 * 60;
/// 应用频繁切换融合阈值：≥3 个不同应用
pub const APP_SWITCH_FUSION_MIN_APPS: usize = 3;
/// 主题聚类 Jaccard 相似度阈值
pub const TOPIC_SIMILARITY_THRESHOLD: f64 = 0.3;
/// 关键词提取 top N
pub const KEYWORDS_TOP_N: usize = 10;
/// 每日总结标记 topic
pub const DAILY_SUMMARY_TOPIC: &str = "__daily_summary__";

/// 中文停用词
fn chinese_stopwords() -> &'static HashSet<&'static str> {
    static S: OnceLock<HashSet<&'static str>> = OnceLock::new();
    S.get_or_init(|| {
        let mut s = HashSet::new();
        for w in [
            "的", "了", "是", "在", "和", "与", "或", "等", "也", "都", "就", "还", "又",
            "把", "被", "让", "给", "向", "从", "到", "对", "为", "按", "由", "于", "以",
            "及", "但", "而", "且", "则", "若", "如", "虽", "然", "因", "所", "之", "其",
            "此", "这", "那", "哪", "些", "个", "们", "你", "我", "他", "她", "它", "一",
            "不", "没", "有", "无", "非", "未", "已", "正", "将", "会", "能", "可", "应",
            "需", "要", "想", "来", "去", "过", "着",
        ] {
            s.insert(w);
        }
        s
    })
}

/// 英文停用词
fn english_stopwords() -> &'static HashSet<&'static str> {
    static S: OnceLock<HashSet<&'static str>> = OnceLock::new();
    S.get_or_init(|| {
        let mut s = HashSet::new();
        for w in [
            "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
            "with", "by", "from", "as", "is", "are", "was", "were", "be", "been", "being",
            "have", "has", "had", "do", "does", "did", "will", "would", "could", "should",
            "may", "might", "can", "this", "that", "these", "those", "i", "you", "he",
            "she", "it", "we", "they", "my", "your", "his", "her", "its", "our", "their",
            "not", "no", "yes", "if", "then", "else", "when", "where", "why", "how",
            "all", "any", "both", "each", "few", "more", "most", "other", "some", "such",
            "only", "own", "same", "so", "than", "too", "very", "just", "now",
        ] {
            s.insert(w);
        }
        s
    })
}

/// UI 噪声词集合
fn ui_noise_words() -> &'static HashSet<String> {
    static S: OnceLock<HashSet<String>> = OnceLock::new();
    S.get_or_init(|| {
        let mut s = HashSet::new();
        // 中文菜单/按钮词
        for w in [
            "文件", "编辑", "视图", "插入", "格式", "工具", "帮助", "窗口",
            "确定", "取消", "保存", "打开", "关闭", "新建", "删除", "复制", "粘贴",
            "剪切", "全选", "查找", "替换", "撤销", "重做", "刷新", "返回",
            "首页", "上一页", "下一页", "末页", "登录", "注册", "退出",
            "设置", "选项", "偏好", "关于", "打印", "导出", "导入",
        ] {
            s.insert(w.to_string());
        }
        // 英文菜单/按钮词（小写）
        for w in [
            "file", "edit", "view", "insert", "format", "tools", "help", "window",
            "ok", "cancel", "save", "open", "close", "new", "delete", "copy", "paste",
            "cut", "select", "find", "replace", "undo", "redo", "refresh", "back",
            "home", "next", "previous", "end", "login", "sign in", "sign up", "logout",
            "settings", "options", "preferences", "about", "print", "export", "import",
        ] {
            s.insert(w.to_lowercase());
        }
        s
    })
}

/// 动作词映射（用于 one_line_summary 生成）
fn action_verbs() -> &'static [(Regex, &'static str)] {
    static V: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    V.get_or_init(|| vec![
        (Regex::new(r"(?i)(编写|写|实现|开发|编码|编程|coding|implement)").unwrap(), "编写代码"),
        (Regex::new(r"(?i)(确认|核对|验证|检查|审查|review|check|verify)").unwrap(), "确认"),
        (Regex::new(r"(?i)(沟通|讨论|交流|回复|聊天|会议|chat|discuss|meeting)").unwrap(), "沟通"),
        (Regex::new(r"(?i)(阅读|查看|浏览|看|read|view|browse)").unwrap(), "查看"),
        (Regex::new(r"(?i)(修改|更新|调整|优化|重构|fix|update|modify|refactor)").unwrap(), "修改"),
        (Regex::new(r"(?i)(测试|调试|test|debug)").unwrap(), "测试"),
        (Regex::new(r"(?i)(部署|发布|上线|deploy|release|publish)").unwrap(), "部署"),
        (Regex::new(r"(?i)(设计|规划|架构|design|plan|architect)").unwrap(), "设计"),
        (Regex::new(r"(?i)(搜索|查询|检索|search|query|find)").unwrap(), "搜索"),
        (Regex::new(r"(?i)(创建|新建|添加|create|add|new)").unwrap(), "创建"),
        (Regex::new(r"(?i)(删除|移除|remove|delete)").unwrap(), "删除"),
        (Regex::new(r"(?i)(配置|设置|config|setting)").unwrap(), "配置"),
    ])
}

/// 任务单号前缀 → 项目名映射
fn task_prefix_to_project(prefix: &str) -> String {
    match prefix {
        "ORD" => "订单".to_string(),
        "PRD" => "需求".to_string(),
        "BUG" => "缺陷".to_string(),
        "ISSUE" => "Issue".to_string(),
        "PR" => "PR".to_string(),
        "MR" => "合并请求".to_string(),
        "TASK" => "任务".to_string(),
        "TODO" => "待办".to_string(),
        "JIRA" => "Jira".to_string(),
        "GIT" => "Git".to_string(),
        "API" => "API".to_string(),
        "DOC" => "文档".to_string(),
        "SPEC" => "规格".to_string(),
        "FEAT" => "功能".to_string(),
        "TEST" => "测试".to_string(),
        "DEV" => "开发".to_string(),
        "OPS" => "运维".to_string(),
        other => other.to_string(),
    }
}

/// Segment 聚类（用于合并算法中间状态）
struct SegmentCluster {
    segments: Vec<WorkSegment>,
    keywords: HashSet<String>,
    task_ids: HashSet<String>,
    apps: HashSet<String>,
}

/// 将 "HH:MM:SS" 时间字符串转为秒数
fn time_to_seconds(time_str: &str) -> i64 {
    let parts: Vec<&str> = time_str.split(':').collect();
    if parts.len() == 3 {
        let h: i64 = parts[0].parse().unwrap_or(0);
        let m: i64 = parts[1].parse().unwrap_or(0);
        let s: i64 = parts[2].parse().unwrap_or(0);
        h * 3600 + m * 60 + s
    } else if parts.len() == 2 {
        let h: i64 = parts[0].parse().unwrap_or(0);
        let m: i64 = parts[1].parse().unwrap_or(0);
        h * 3600 + m * 60
    } else {
        0
    }
}

/// 提取关键词
pub fn extract_keywords(text: &str) -> Vec<String> {
    if text.trim().is_empty() {
        return vec![];
    }

    let mut freq: HashMap<String, usize> = HashMap::new();

    // 中文单字
    let chinese_char_re = Regex::new(r"[\u4e00-\u9fff]").unwrap();
    for m in chinese_char_re.find_iter(text) {
        let ch = m.as_str();
        if !chinese_stopwords().contains(ch) {
            *freq.entry(ch.to_string()).or_insert(0) += 1;
        }
    }

    // 中文双字组合
    let chinese_text_re = Regex::new(r"[\u4e00-\u9fff]+").unwrap();
    for m in chinese_text_re.find_iter(text) {
        let segment = m.as_str();
        let chars: Vec<char> = segment.chars().collect();
        for i in 0..chars.len().saturating_sub(1) {
            let bigram: String = chars[i..i + 2].iter().collect();
            let first_char = chars[i].to_string();
            let second_char = chars[i + 1].to_string();
            if !chinese_stopwords().contains(first_char.as_str())
                && !chinese_stopwords().contains(second_char.as_str())
                && !ui_noise_words().contains(&bigram)
            {
                *freq.entry(bigram).or_insert(0) += 1;
            }
        }
    }

    // 英文单词
    let english_word_re = Regex::new(r"[a-zA-Z]{2,}").unwrap();
    for m in english_word_re.find_iter(text) {
        let lower = m.as_str().to_lowercase();
        if !english_stopwords().contains(lower.as_str()) && lower.len() >= 2 {
            if !ui_noise_words().contains(&lower) {
                *freq.entry(lower).or_insert(0) += 1;
            }
        }
    }

    // TF 排序，取 top N
    let mut sorted: Vec<(String, usize)> = freq.into_iter().collect();
    sorted.sort_by(|a, b| b.1.cmp(&a.1));
    sorted.into_iter().take(KEYWORDS_TOP_N).map(|(w, _)| w).collect()
}

/// 提取任务单号
pub fn extract_task_ids(text: &str) -> Vec<String> {
    if text.is_empty() {
        return vec![];
    }
    let mut ids: HashSet<String> = HashSet::new();

    let task_re = Regex::new(r"([A-Z]{2,})-(\d+)").unwrap();
    for caps in task_re.captures_iter(text) {
        ids.insert(format!("{}-{}", &caps[1], &caps[2]));
    }

    let hash_re = Regex::new(r"#(\d+)").unwrap();
    for caps in hash_re.captures_iter(text) {
        ids.insert(format!("#{}", &caps[1]));
    }

    ids.into_iter().collect()
}

/// 计算两个集合的 Jaccard 相似度
pub fn jaccard_similarity(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 0.0;
    }
    let intersection = a.intersection(b).count();
    let union = a.len() + b.len() - intersection;
    if union == 0 {
        0.0
    } else {
        intersection as f64 / union as f64
    }
}

/// EpisodeBuilder：Episode 语义合并引擎。
pub struct EpisodeBuilder;

impl EpisodeBuilder {
    /// 创建 EpisodeBuilder 实例
    pub fn new() -> Self {
        Self
    }

    /// 重建指定日期的 Episodes。
    ///
    /// 流程：
    ///  1. 读取该日期所有 active Segments（未删除），按时间排序
    ///  2. 执行合并算法（时间连续性 + 语义相似度 + 应用频繁切换融合）
    ///  3. 为每个聚类生成 Episode（title、one_line_summary、topics）
    ///  4. 持久化：删除非 user_edited 旧 Episodes → 插入新 Episodes
    ///  5. 发布 EpisodesRebuilt 事件
    pub fn rebuild_episodes_for_date(&self, date: &str) -> anyhow::Result<Vec<Episode>> {
        // 1. 读取 active Segments
        let all_segments = SegmentRepository::get_active_by_date(date)?;
        let segments: Vec<WorkSegment> = all_segments
            .into_iter()
            .filter(|s| !s.is_private && s.source_status.as_str() != "private")
            .collect();

        // 2. 执行合并算法
        let clusters = self.cluster_segments(&segments);

        // 3. 生成 Episodes
        let new_episodes: Vec<Episode> = clusters
            .iter()
            .map(|c| self.create_episode_from_cluster(c, date))
            .collect();

        // 4. 持久化
        self.persist_episodes(date, &new_episodes)?;

        // 5. 发布事件
        EventBus::publish(AppEvent::EpisodesRebuilt {
            date: date.to_string(),
        });

        Ok(new_episodes)
    }

    // ===================== 合并算法 =====================

    /// 将 Segments 聚类为多个 Cluster
    fn cluster_segments(&self, segments: &[WorkSegment]) -> Vec<SegmentCluster> {
        if segments.is_empty() {
            return vec![];
        }

        // 按时间排序
        let mut sorted: Vec<WorkSegment> = segments.to_vec();
        sorted.sort_by(|a, b| time_to_seconds(&a.start_time).cmp(&time_to_seconds(&b.start_time)));

        // 初始化聚类
        let mut clusters: Vec<SegmentCluster> = sorted
            .into_iter()
            .map(|segment| {
                let text = Self::segment_text(&segment);
                SegmentCluster {
                    keywords: extract_keywords(&text).into_iter().collect(),
                    task_ids: extract_task_ids(&text).into_iter().collect(),
                    apps: std::iter::once(segment.app_name.clone()).collect(),
                    segments: vec![segment],
                }
            })
            .collect();

        // 第一轮：时间连续性 + 语义相似度合并
        clusters = Self::merge_by_continuity_and_similarity(clusters);

        // 第二轮：应用频繁切换融合
        clusters = Self::merge_by_app_switch_fusion(clusters);

        clusters
    }

    /// 第一轮合并：时间连续性（<5min）+ 语义相似度
    fn merge_by_continuity_and_similarity(mut clusters: Vec<SegmentCluster>) -> Vec<SegmentCluster> {
        if clusters.len() <= 1 {
            return clusters;
        }

        let mut result: Vec<SegmentCluster> = vec![clusters.remove(0)];

        for curr in clusters {
            let prev = result.last_mut().unwrap();
            let prev_end = time_to_seconds(&prev.segments.last().unwrap().end_time);
            let curr_start = time_to_seconds(&curr.segments.first().unwrap().start_time);
            let gap = curr_start - prev_end;

            let time_continuous = gap >= 0 && gap <= TIME_CONTINUITY_THRESHOLD_SEC;
            let semantically_similar = Self::is_semantically_similar(prev, &curr);

            if time_continuous && semantically_similar {
                Self::merge_cluster(prev, curr);
            } else {
                result.push(curr);
            }
        }

        result
    }

    /// 第二轮合并：应用频繁切换融合
    fn merge_by_app_switch_fusion(mut clusters: Vec<SegmentCluster>) -> Vec<SegmentCluster> {
        if clusters.len() <= 1 {
            return clusters;
        }

        let mut result: Vec<SegmentCluster> = vec![clusters.remove(0)];

        for curr in clusters {
            let prev = result.last_mut().unwrap();
            let prev_end = time_to_seconds(&prev.segments.last().unwrap().end_time);
            let curr_start = time_to_seconds(&curr.segments.first().unwrap().start_time);
            let gap = curr_start - prev_end;

            let within_fusion_window = gap >= 0 && gap <= APP_SWITCH_FUSION_WINDOW_SEC;

            if within_fusion_window {
                let mut merged_apps = prev.apps.clone();
                for app in &curr.apps {
                    merged_apps.insert(app.clone());
                }
                let same_topic = jaccard_similarity(&prev.keywords, &curr.keywords) > TOPIC_SIMILARITY_THRESHOLD;

                if merged_apps.len() >= APP_SWITCH_FUSION_MIN_APPS && same_topic {
                    Self::merge_cluster(prev, curr);
                    continue;
                }

                if gap <= TIME_CONTINUITY_THRESHOLD_SEC && same_topic {
                    Self::merge_cluster(prev, curr);
                    continue;
                }
            }

            result.push(curr);
        }

        result
    }

    /// 判断两个 Cluster 是否语义相似
    fn is_semantically_similar(a: &SegmentCluster, b: &SegmentCluster) -> bool {
        // activityType 感知
        let activity_a = Self::get_dominant_activity_type(a);
        let activity_b = Self::get_dominant_activity_type(b);
        if let (Some(aa), Some(ab)) = (activity_a, activity_b) {
            if aa != ab {
                return false;
            }
        }

        // 共享任务单号
        for task_id in &a.task_ids {
            if b.task_ids.contains(task_id) {
                return true;
            }
        }

        // 关键词 Jaccard 相似度
        if jaccard_similarity(&a.keywords, &b.keywords) > TOPIC_SIMILARITY_THRESHOLD {
            return true;
        }

        // 同一应用 + 关键词有交集
        let same_app = a.apps.iter().any(|app| b.apps.contains(app));
        if same_app {
            let intersection = a.keywords.intersection(&b.keywords).count();
            if intersection > 0 {
                return true;
            }
        }

        false
    }

    /// 合并两个 Cluster
    fn merge_cluster(target: &mut SegmentCluster, source: SegmentCluster) {
        target.segments.extend(source.segments);
        for k in source.keywords {
            target.keywords.insert(k);
        }
        for t in source.task_ids {
            target.task_ids.insert(t);
        }
        for a in source.apps {
            target.apps.insert(a);
        }
    }

    /// 计算聚类的主导 activityType
    fn get_dominant_activity_type(cluster: &SegmentCluster) -> Option<ActivityType> {
        let mut counts: HashMap<ActivityType, usize> = HashMap::new();
        for segment in &cluster.segments {
            if let Some(at) = &segment.activity_type {
                if *at != ActivityType::Idle {
                    *counts.entry(at.clone()).or_insert(0) += 1;
                }
            }
        }
        if counts.is_empty() {
            return None;
        }
        counts.into_iter().max_by_key(|(_, c)| *c).map(|(at, _)| at)
    }

    // ===================== Episode 生成 =====================

    /// 从 Cluster 创建 Episode
    fn create_episode_from_cluster(&self, cluster: &SegmentCluster, date: &str) -> Episode {
        let segments = &cluster.segments;
        let start_time = segments.first().unwrap().start_time.clone();
        let end_time = segments.last().unwrap().end_time.clone();
        let segment_ids: Vec<String> = segments.iter().map(|s| s.id.clone()).collect();

        // 提取主题关键词
        let topics: Vec<String> = cluster.keywords.iter().take(KEYWORDS_TOP_N).cloned().collect();

        // 生成 title
        let title = Self::generate_title(cluster);

        // 生成 one_line_summary
        let one_line_summary = Self::generate_one_line_summary(cluster);

        // 聚类内多数 segment 的 activityType
        let dominant_activity_type = Self::get_dominant_activity_type(cluster);

        Episode {
            id: Uuid::new_v4().to_string(),
            date: date.to_string(),
            start_time,
            end_time,
            title,
            one_line_summary,
            segment_ids,
            entities: vec![],
            topics,
            user_edited: false,
            report_eligible: true,
            wiki_eligible: false,
            dominant_activity_type,
        }
    }

    /// 生成 Episode title
    fn generate_title(cluster: &SegmentCluster) -> String {
        let segments = &cluster.segments;
        let task_ids: Vec<String> = cluster.task_ids.iter().cloned().collect();

        // 提取项目名
        let mut project_name = String::new();
        if !task_ids.is_empty() {
            let first_task_id = &task_ids[0];
            let prefix = first_task_id.split('-').next().unwrap_or("");
            project_name = task_prefix_to_project(prefix);
        }

        // 从窗口标题提取项目/需求名
        if project_name.is_empty() {
            let title_project_re = Regex::new(r"([\u4e00-\u9fff\w]{2,10})(项目|需求|功能|模块)").unwrap();
            for segment in segments {
                if let Some(caps) = title_project_re.captures(&segment.window_title) {
                    project_name = format!("{}{}", &caps[1], &caps[2]);
                    break;
                }
            }
        }

        // 提取主题关键词（过滤 UI 噪声词后取 top 2-3）
        let meaningful_keywords: Vec<String> = cluster
            .keywords
            .iter()
            .filter(|k| !ui_noise_words().contains(*k))
            .take(3)
            .cloned()
            .collect();
        let top_keywords = meaningful_keywords.join("");

        if !project_name.is_empty() && !top_keywords.is_empty() {
            return format!("[{}] {}", project_name, top_keywords);
        } else if !project_name.is_empty() {
            return format!("[{}] 工作推进", project_name);
        }

        // 取最频繁应用 + 窗口标题关键词
        let mut app_counts: HashMap<String, usize> = HashMap::new();
        for segment in segments {
            *app_counts.entry(segment.app_name.clone()).or_insert(0) += 1;
        }
        let dominant_app = app_counts
            .into_iter()
            .max_by_key(|(_, c)| *c)
            .map(|(a, _)| a)
            .unwrap_or_default();

        let title_keywords = Self::extract_title_keywords(segments);

        if !dominant_app.is_empty() && !title_keywords.is_empty() {
            format!("{} - {}", dominant_app, title_keywords)
        } else if !dominant_app.is_empty() {
            format!("{} 工作", dominant_app)
        } else if !top_keywords.is_empty() {
            top_keywords
        } else {
            "工作片段".to_string()
        }
    }

    /// 从窗口标题提取关键词
    fn extract_title_keywords(segments: &[WorkSegment]) -> String {
        let titles: Vec<&str> = segments.iter().map(|s| s.window_title.as_str()).filter(|t| t.len() > 0).collect();
        if titles.is_empty() {
            return String::new();
        }

        // 取最长标题
        let longest_title = titles.iter().max_by_key(|t| t.len()).unwrap_or(&"");
        // 去除应用名后缀
        let suffix_re = Regex::new(r"\s*-\s*[^-]+$").unwrap();
        let cleaned = suffix_re.replace(longest_title, "").trim().to_string();
        if cleaned.is_empty() {
            return String::new();
        }
        // 取前 20 字符
        cleaned.chars().take(20).collect()
    }

    /// 生成 one_line_summary
    fn generate_one_line_summary(cluster: &SegmentCluster) -> String {
        let segments = &cluster.segments;
        let full_text: String = segments.iter().map(|s| s.ocr_text.as_str()).collect::<Vec<_>>().join("\n");
        let titles: String = segments.iter().map(|s| s.window_title.as_str()).collect::<Vec<_>>().join("\n");
        let combined_text = format!("{}\n{}", full_text, titles);

        // 提取动作词
        let mut actions: Vec<&str> = Vec::new();
        for (pattern, action) in action_verbs() {
            if pattern.is_match(&combined_text) && !actions.contains(action) {
                actions.push(action);
            }
        }

        // 提取主题对象
        let meaningful_keywords: Vec<String> = cluster
            .keywords
            .iter()
            .filter(|k| !ui_noise_words().contains(*k))
            .take(3)
            .cloned()
            .collect();
        let top_keywords = meaningful_keywords.join("");

        // 提取项目名
        let mut project_name = String::new();
        let task_ids: Vec<String> = cluster.task_ids.iter().cloned().collect();
        if !task_ids.is_empty() {
            let prefix = task_ids[0].split('-').next().unwrap_or("");
            project_name = task_prefix_to_project(prefix);
        }

        // 提取主导应用名
        let mut app_counts: HashMap<String, usize> = HashMap::new();
        for segment in segments {
            *app_counts.entry(segment.app_name.clone()).or_insert(0) += 1;
        }
        let dominant_app = app_counts
            .into_iter()
            .max_by_key(|(_, c)| *c)
            .map(|(a, _)| a)
            .unwrap_or_default();

        // 降级：无动作词且无有意义关键词
        if actions.is_empty() && top_keywords.is_empty() {
            if !dominant_app.is_empty() {
                return format!("查看 {} 相关内容", dominant_app);
            }
            return "查看相关内容".to_string();
        }

        // 组合一句话
        let mut parts: Vec<String> = Vec::new();

        if !actions.is_empty() && !top_keywords.is_empty() {
            parts.push(format!("{}{}", actions[0], top_keywords));
        } else if !actions.is_empty() {
            parts.push(actions[0].to_string());
        } else if !top_keywords.is_empty() {
            parts.push(format!("推进{}", top_keywords));
        }

        if actions.len() > 1 {
            parts.push(format!("并{}", actions[1]));
        }

        if !project_name.is_empty() && !parts.is_empty() {
            return format!("{}：{}", project_name, parts.join("，"));
        }

        if !parts.is_empty() {
            return parts.join("，");
        }

        // 降级：使用窗口标题
        let title_keywords = Self::extract_title_keywords(segments);
        if !title_keywords.is_empty() {
            return format!("处理{}", title_keywords);
        }

        "工作推进".to_string()
    }

    // ===================== 持久化 =====================

    /// 持久化 Episodes
    fn persist_episodes(&self, date: &str, new_episodes: &[Episode]) -> anyhow::Result<()> {
        let existing_episodes = EpisodeRepository::get_by_date(date)?;

        for existing in existing_episodes {
            // 保留 user_edited 的 Episode
            if existing.user_edited {
                continue;
            }
            // 保留每日总结 Episode
            if existing.topics.iter().any(|t| t == DAILY_SUMMARY_TOPIC) {
                continue;
            }
            // 删除非 user_edited 的旧 Episode
            let _ = EpisodeRepository::hard_delete(&existing.id);
        }

        // 插入新 Episodes
        for episode in new_episodes {
            EpisodeRepository::insert(episode.clone())?;
        }

        Ok(())
    }

    // ===================== 工具方法 =====================

    /// 获取 Segment 的文本内容（OCR + 窗口标题）
    fn segment_text(segment: &WorkSegment) -> String {
        format!("{}\n{}", segment.ocr_text, segment.window_title)
    }
}

impl Default for EpisodeBuilder {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{SourceStatus, CaptureSource, SourceQuality};

    fn make_segment(id: &str, start: &str, end: &str, app: &str, title: &str, ocr: &str) -> WorkSegment {
        WorkSegment {
            id: id.to_string(),
            date: "2026-06-22".to_string(),
            start_time: start.to_string(),
            end_time: end.to_string(),
            duration_seconds: 60,
            app_name: app.to_string(),
            process_name: format!("{}.exe", app.to_lowercase()),
            window_title: title.to_string(),
            ocr_text: ocr.to_string(),
            ocr_summary: String::new(),
            image_hash: String::new(),
            screenshot_path: String::new(),
            is_selected_for_report: false,
            is_private: false,
            is_important: false,
            is_deleted: false,
            source_status: SourceStatus::OcrDone,
            user_title: String::new(),
            user_summary: String::new(),
            user_note: String::new(),
            tags: vec![],
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

    #[test]
    fn test_extract_keywords_chinese() {
        let keywords = extract_keywords("编写代码 实现功能 测试代码");
        assert!(!keywords.is_empty());
        // 应包含 "代码" 双字组合
        assert!(keywords.iter().any(|k| k == "代码"));
    }

    #[test]
    fn test_extract_keywords_empty() {
        let keywords = extract_keywords("");
        assert!(keywords.is_empty());
    }

    #[test]
    fn test_extract_task_ids() {
        let ids = extract_task_ids("ORD-123 处理订单 PR-456 合并代码");
        assert!(ids.contains(&"ORD-123".to_string()));
        assert!(ids.contains(&"PR-456".to_string()));
    }

    #[test]
    fn test_extract_task_ids_hash() {
        let ids = extract_task_ids("查看 #123 和 #456");
        assert!(ids.contains(&"#123".to_string()));
        assert!(ids.contains(&"#456".to_string()));
    }

    #[test]
    fn test_jaccard_similarity_identical() {
        let a: HashSet<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        let b: HashSet<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        assert_eq!(jaccard_similarity(&a, &b), 1.0);
    }

    #[test]
    fn test_jaccard_similarity_disjoint() {
        let a: HashSet<String> = ["a", "b"].iter().map(|s| s.to_string()).collect();
        let b: HashSet<String> = ["c", "d"].iter().map(|s| s.to_string()).collect();
        assert_eq!(jaccard_similarity(&a, &b), 0.0);
    }

    #[test]
    fn test_jaccard_similarity_partial() {
        let a: HashSet<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        let b: HashSet<String> = ["a", "b", "d"].iter().map(|s| s.to_string()).collect();
        // 交集 2，并集 4，相似度 0.5
        assert_eq!(jaccard_similarity(&a, &b), 0.5);
    }

    #[test]
    fn test_time_to_seconds() {
        assert_eq!(time_to_seconds("01:30:45"), 5445);
        assert_eq!(time_to_seconds("00:00:00"), 0);
    }

    #[test]
    fn test_cluster_segments_merges_similar() {
        let builder = EpisodeBuilder::new();
        let segments = vec![
            make_segment("s1", "10:00:00", "10:05:00", "Code", "main.rs", "fn main 编写代码"),
            make_segment("s2", "10:06:00", "10:10:00", "Code", "main.rs", "fn main 编写代码 测试"),
        ];
        let clusters = builder.cluster_segments(&segments);
        // 时间连续且语义相似，应合并为一个 cluster
        assert_eq!(clusters.len(), 1);
        assert_eq!(clusters[0].segments.len(), 2);
    }

    #[test]
    fn test_cluster_segments_separates_different() {
        let builder = EpisodeBuilder::new();
        let segments = vec![
            make_segment("s1", "10:00:00", "10:05:00", "Code", "main.rs", "fn main 编写代码"),
            make_segment("s2", "12:00:00", "12:05:00", "Chrome", "Google", "搜索 购物"),
        ];
        let clusters = builder.cluster_segments(&segments);
        // 时间间隔大且语义不同，应分为两个 cluster
        assert_eq!(clusters.len(), 2);
    }
}
