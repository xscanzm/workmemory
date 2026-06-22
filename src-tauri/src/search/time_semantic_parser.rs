//! TimeSemanticParser：时间语义搜索解析器（F8.7）
//!
//! 功能：
//!  - 将自然语言查询解析为结构化 ParsedQuery
//!  - 识别时间范围（如"上周五下午"）
//!  - 识别实体（如"和张三开会"）
//!  - 识别项目（如"做 XX 项目最长的那天"）
//!  - 识别查询意图：LongestDay / EntityTimeline / GeneralSearch
//!
//! 解析模式示例：
//!  - "上周五下午" → time_range = 上周五 13:00-18:00
//!  - "和张三开会的时候" → entity = "张三", intent = EntityTimeline
//!  - "做 XX 项目最长的那天" → project = "XX", intent = LongestDay
//!  - "昨天" → time_range = 昨日全天
//!  - "上周" → time_range = 上周 7 天

use chrono::{Datelike, Local, NaiveDate, NaiveDateTime, NaiveTime, Weekday};
use regex::Regex;
use serde::{Deserialize, Serialize};

/// 时间范围（Unix 毫秒）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TimeRange {
    pub start: i64,
    pub end: i64,
}

/// 查询意图
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum QueryIntent {
    /// 最长的那天
    LongestDay,
    /// 实体时间线
    EntityTimeline,
    /// 通用搜索
    GeneralSearch,
}

/// 解析后的查询
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ParsedQuery {
    /// 时间范围（Unix 毫秒），None 表示未指定
    pub time_range: Option<TimeRange>,
    /// 实体名（人/项目等）
    pub entity: Option<String>,
    /// 项目名
    pub project: Option<String>,
    /// 查询意图
    pub intent: Option<QueryIntent>,
    /// 关键词列表
    pub keywords: Vec<String>,
}

/// TimeSemanticParser：时间语义搜索解析器
pub struct TimeSemanticParser {
    /// "和 XX 开会/讨论/沟通" 模式
    entity_re: Regex,
    /// "做 XX 项目最长的那天" 模式
    project_longest_re: Regex,
    /// "上周五下午" / "上周三上午" 模式
    last_week_day_period_re: Regex,
    /// "昨天" / "前天"
    relative_day_re: Regex,
    /// "上周" 单独
    last_week_re: Regex,
    /// "今天"
    today_re: Regex,
}

impl TimeSemanticParser {
    /// 创建实例并编译正则
    pub fn new() -> Self {
        TimeSemanticParser {
            // 和张三开会的时候 / 与李四讨论
            entity_re: Regex::new(r"[和与跟]\s*([\u4e00-\u9fa5A-Za-z]{2,10})\s*(?:开会|讨论|沟通|聊天|见面|对接|对齐)").unwrap(),
            // 做 XX 项目最长的那天 / XX 项目最长的那天
            project_longest_re: Regex::new(r"(?:做|关于|在)?\s*([\u4e00-\u9fa5A-Za-z0-9]{1,15})\s*项目.*最长.*(?:那天|一天|天)").unwrap(),
            // 上周五下午 / 上周三上午 / 上周一全天
            last_week_day_period_re: Regex::new(r"上周([一二三四五六七日天])\s*(上午|下午|全天|晚上)?").unwrap(),
            // 昨天 / 前天
            relative_day_re: Regex::new(r"(昨天|前天|大前天)").unwrap(),
            // 上周
            last_week_re: Regex::new(r"上周").unwrap(),
            // 今天
            today_re: Regex::new(r"今天").unwrap(),
        }
    }

    /// 解析自然语言查询为 ParsedQuery
    pub fn parse(&self, query: &str) -> ParsedQuery {
        let mut pq = ParsedQuery::default();

        // 1. 识别项目 + LongestDay 意图
        if let Some(caps) = self.project_longest_re.captures(query) {
            let project = caps.get(1).map(|m| m.as_str().to_string());
            if let Some(p) = project {
                pq.project = Some(p.clone());
                pq.intent = Some(QueryIntent::LongestDay);
                pq.keywords.push(p);
            }
        }

        // 2. 识别实体 + EntityTimeline 意图
        if let Some(caps) = self.entity_re.captures(query) {
            let entity = caps.get(1).map(|m| m.as_str().to_string());
            if let Some(e) = entity {
                pq.entity = Some(e.clone());
                // 若未设置意图则设为 EntityTimeline
                if pq.intent.is_none() {
                    pq.intent = Some(QueryIntent::EntityTimeline);
                }
                pq.keywords.push(e);
            }
        }

        // 3. 识别时间范围
        pq.time_range = self.parse_time_range(query);

        // 4. 若未识别意图，则为通用搜索
        if pq.intent.is_none() {
            pq.intent = Some(QueryIntent::GeneralSearch);
        }

        // 5. 提取关键词（去除已识别模式后的剩余 token）
        if pq.keywords.is_empty() {
            let keywords = extract_keywords(query);
            pq.keywords = keywords;
        }

        pq
    }

    /// 解析时间范围
    fn parse_time_range(&self, query: &str) -> Option<TimeRange> {
        // 上周五下午 / 上周三上午
        if let Some(caps) = self.last_week_day_period_re.captures(query) {
            let weekday_str = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let period = caps.get(2).map(|m| m.as_str()).unwrap_or("全天");
            let weekday = parse_weekday(weekday_str)?;
            let today = Local::now().date_naive();
            let target = last_weekday(today, weekday);
            return Some(time_range_for_period(target, period));
        }

        // 昨天 / 前天 / 大前天
        if let Some(caps) = self.relative_day_re.captures(query) {
            let word = caps.get(1).map(|m| m.as_str()).unwrap_or("昨天");
            let today = Local::now().date_naive();
            let offset = match word {
                "昨天" => 1,
                "前天" => 2,
                "大前天" => 3,
                _ => 1,
            };
            let target = today - chrono::Duration::days(offset);
            return Some(time_range_for_period(target, "全天"));
        }

        // 今天
        if self.today_re.is_match(query) {
            let today = Local::now().date_naive();
            return Some(time_range_for_period(today, "全天"));
        }

        // 上周（整周）
        if self.last_week_re.is_match(query) {
            let today = Local::now().date_naive();
            // 上周一
            let this_week_monday = today
                - chrono::Duration::days((today.weekday().num_days_from_monday() as i64));
            let last_monday = this_week_monday - chrono::Duration::days(7);
            let last_sunday = last_monday + chrono::Duration::days(6);
            return Some(time_range_for_date_range(last_monday, last_sunday));
        }

        None
    }
}

impl Default for TimeSemanticParser {
    fn default() -> Self {
        Self::new()
    }
}

/// 解析中文星期字符串为 Weekday
fn parse_weekday(s: &str) -> Option<Weekday> {
    match s {
        "一" => Some(Weekday::Mon),
        "二" => Some(Weekday::Tue),
        "三" => Some(Weekday::Wed),
        "四" => Some(Weekday::Thu),
        "五" => Some(Weekday::Fri),
        "六" => Some(Weekday::Sat),
        "七" | "日" | "天" => Some(Weekday::Sun),
        _ => None,
    }
}

/// 计算上周指定星期几的日期
fn last_weekday(today: NaiveDate, target: Weekday) -> NaiveDate {
    let this_week_target = today
        - chrono::Duration::days(
            (today.weekday().num_days_from_monday() as i64
                - target.num_days_from_monday() as i64
                + 7)
                % 7,
        );
    // 若等于今天，则取上周
    if this_week_target == today {
        this_week_target - chrono::Duration::days(7)
    } else {
        this_week_target
    }
}

/// 根据日期与时段构造 TimeRange（Unix 毫秒）
fn time_range_for_period(date: NaiveDate, period: &str) -> TimeRange {
    match period {
        "上午" => TimeRange {
            start: date
                .and_time(NaiveTime::from_hms_opt(8, 0, 0).unwrap())
                .and_utc()
                .timestamp_millis(),
            end: date
                .and_time(NaiveTime::from_hms_opt(12, 0, 0).unwrap())
                .and_utc()
                .timestamp_millis(),
        },
        "下午" => TimeRange {
            start: date
                .and_time(NaiveTime::from_hms_opt(13, 0, 0).unwrap())
                .and_utc()
                .timestamp_millis(),
            end: date
                .and_time(NaiveTime::from_hms_opt(18, 0, 0).unwrap())
                .and_utc()
                .timestamp_millis(),
        },
        "晚上" => TimeRange {
            start: date
                .and_time(NaiveTime::from_hms_opt(19, 0, 0).unwrap())
                .and_utc()
                .timestamp_millis(),
            end: date
                .and_time(NaiveTime::from_hms_opt(23, 0, 0).unwrap())
                .and_utc()
                .timestamp_millis(),
        },
        _ => TimeRange {
            start: date
                .and_time(NaiveTime::from_hms_opt(0, 0, 0).unwrap())
                .and_utc()
                .timestamp_millis(),
            end: date
                .and_time(NaiveTime::from_hms_opt(23, 59, 59).unwrap())
                .and_utc()
                .timestamp_millis(),
        },
    }
}

/// 构造日期范围（含两端）的 TimeRange
fn time_range_for_date_range(start: NaiveDate, end: NaiveDate) -> TimeRange {
    TimeRange {
        start: start
            .and_time(NaiveTime::from_hms_opt(0, 0, 0).unwrap())
            .and_utc()
            .timestamp_millis(),
        end: end
            .and_time(NaiveTime::from_hms_opt(23, 59, 59).unwrap())
            .and_utc()
            .timestamp_millis(),
    }
}

/// 从查询中提取关键词（简单分词）
fn extract_keywords(query: &str) -> Vec<String> {
    let mut keywords: Vec<String> = Vec::new();
    // 英文单词
    let english_re = Regex::new(r"[a-zA-Z]{2,}").unwrap();
    for m in english_re.find_iter(query) {
        keywords.push(m.as_str().to_lowercase());
    }
    // 中文 bigram
    let chinese_re = Regex::new(r"[\u{4e00}-\u{9fa5}]").unwrap();
    let chinese_chars: Vec<char> = chinese_re
        .find_iter(query)
        .filter_map(|m| m.as_str().chars().next())
        .collect();
    if chinese_chars.len() >= 2 {
        for i in 0..chinese_chars.len() - 1 {
            keywords.push(format!("{}{}", chinese_chars[i], chinese_chars[i + 1]));
        }
    }
    // 去重
    let mut seen = std::collections::HashSet::new();
    keywords.retain(|k| seen.insert(k.clone()));
    keywords
}

// 防止未使用导入告警
#[allow(dead_code)]
fn _unused_import_guard(_d: NaiveDateTime) {}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_entity_timeline() {
        let parser = TimeSemanticParser::new();
        let pq = parser.parse("和张三开会的时候");
        assert_eq!(pq.entity, Some("张三".to_string()));
        assert_eq!(pq.intent, Some(QueryIntent::EntityTimeline));
    }

    #[test]
    fn test_parse_project_longest_day() {
        let parser = TimeSemanticParser::new();
        let pq = parser.parse("做 WorkMemory 项目最长的那天");
        assert_eq!(pq.project, Some("WorkMemory".to_string()));
        assert_eq!(pq.intent, Some(QueryIntent::LongestDay));
    }

    #[test]
    fn test_parse_last_week_friday_afternoon() {
        let parser = TimeSemanticParser::new();
        let pq = parser.parse("上周五下午");
        assert!(pq.time_range.is_some());
        let tr = pq.time_range.unwrap();
        assert!(tr.end > tr.start);
        // 下午时段跨度 5 小时 = 5*3600*1000 毫秒
        assert_eq!(tr.end - tr.start, 5 * 3600 * 1000);
    }

    #[test]
    fn test_parse_yesterday() {
        let parser = TimeSemanticParser::new();
        let pq = parser.parse("昨天");
        assert!(pq.time_range.is_some());
        let tr = pq.time_range.unwrap();
        // 全天时段约 24 小时
        let diff_hours = (tr.end - tr.start) as f64 / 3_600_000.0;
        assert!((diff_hours - 23.9997).abs() < 0.01);
    }

    #[test]
    fn test_parse_today() {
        let parser = TimeSemanticParser::new();
        let pq = parser.parse("今天");
        assert!(pq.time_range.is_some());
    }

    #[test]
    fn test_parse_last_week_full() {
        let parser = TimeSemanticParser::new();
        let pq = parser.parse("上周");
        assert!(pq.time_range.is_some());
        let tr = pq.time_range.unwrap();
        let diff_days = (tr.end - tr.start) as f64 / 86_400_000.0;
        assert!(diff_days >= 6.0 && diff_days < 7.0);
    }

    #[test]
    fn test_parse_general_search_default_intent() {
        let parser = TimeSemanticParser::new();
        let pq = parser.parse("搜索关键词 report");
        assert_eq!(pq.intent, Some(QueryIntent::GeneralSearch));
        assert!(pq.time_range.is_none());
        assert!(pq.entity.is_none());
        assert!(pq.project.is_none());
    }

    #[test]
    fn test_parse_weekday_mapping() {
        assert_eq!(parse_weekday("一"), Some(Weekday::Mon));
        assert_eq!(parse_weekday("五"), Some(Weekday::Fri));
        assert_eq!(parse_weekday("日"), Some(Weekday::Sun));
        assert_eq!(parse_weekday("天"), Some(Weekday::Sun));
        assert_eq!(parse_weekday("七"), Some(Weekday::Sun));
        assert_eq!(parse_weekday("x"), None);
    }

    #[test]
    fn test_extract_keywords_dedup() {
        let kws = extract_keywords("report report 项目");
        // report 应只出现一次
        let count = kws.iter().filter(|k| *k == "report").count();
        assert_eq!(count, 1);
    }
}
