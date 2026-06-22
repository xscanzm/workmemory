//! PrivacyRuleRepository：隐私规则数据访问层 + 规则匹配引擎（对应 electron/db/repositories/PrivacyRuleRepository.ts）
//!
//! 匹配动作由规则类型决定：
//!   - app_name / process_name 命中 → skip（完全跳过，不截图不 OCR）
//!   - window_title / url 命中 → placeholder（占位符，记录隐私窗口被保护）
//!   - 未命中 → allow

use rusqlite::{params, Connection};

use crate::db::database::get_database;
use crate::models::{
    PrivacyAction, PrivacyMatchMode, PrivacyMatchResult, PrivacyRule, PrivacyRuleType,
};

fn row_to_rule(row: &rusqlite::Row<'_>) -> rusqlite::Result<PrivacyRule> {
    let type_str: String = row.get("type")?;
    let match_mode_str: String = row.get("match_mode")?;
    Ok(PrivacyRule {
        id: row.get("id")?,
        rule_type: PrivacyRuleType::from_str(&type_str),
        pattern: row.get("pattern")?,
        match_mode: PrivacyMatchMode::from_str(&match_mode_str),
        enabled: row.get::<_, i64>("enabled")? != 0,
    })
}

/// 单条规则对单个目标值的匹配判定
pub fn match_value(value: &str, pattern: &str, mode: PrivacyMatchMode) -> bool {
    if pattern.is_empty() {
        return false;
    }
    match mode {
        PrivacyMatchMode::Contains => value.to_lowercase().contains(&pattern.to_lowercase()),
        PrivacyMatchMode::Equals => value.to_lowercase() == pattern.to_lowercase(),
        PrivacyMatchMode::Regex => {
            let re = match regex::Regex::new(&format!("(?i){}", pattern)) {
                Ok(r) => r,
                Err(_) => return false,
            };
            re.is_match(value)
        }
    }
}

/// 根据规则类型决定过滤动作
pub fn action_for_type(rule_type: PrivacyRuleType) -> PrivacyAction {
    match rule_type {
        PrivacyRuleType::AppName | PrivacyRuleType::ProcessName => PrivacyAction::Skip,
        _ => PrivacyAction::Placeholder,
    }
}

pub struct PrivacyRuleRepository;

impl PrivacyRuleRepository {
    pub fn insert(rule: PrivacyRule) -> anyhow::Result<PrivacyRule> {
        let id = if rule.id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            rule.id.clone()
        };
        let mut rule = rule;
        rule.id = id.clone();

        let conn = get_database()?;
        conn.execute(
            "INSERT INTO privacy_rules (id, type, pattern, match_mode, enabled)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                rule.id,
                rule.rule_type.as_str(),
                rule.pattern,
                rule.match_mode.as_str(),
                rule.enabled as i64,
            ],
        )?;
        drop(conn);
        Self::get_all()?
            .into_iter()
            .find(|r| r.id == id)
            .ok_or_else(|| anyhow::anyhow!("PrivacyRule insert failed for id={}", id))
    }

    pub fn update(id: &str, patch: PrivacyRule) -> anyhow::Result<Option<PrivacyRule>> {
        let existing = match Self::get_all()?.into_iter().find(|r| r.id == id) {
            Some(e) => e,
            None => return Ok(None),
        };
        let merged = merge_rule(existing, patch, id);
        let conn = get_database()?;
        conn.execute(
            "UPDATE privacy_rules SET type = ?1, pattern = ?2, match_mode = ?3, enabled = ?4 WHERE id = ?5",
            params![
                merged.rule_type.as_str(),
                merged.pattern,
                merged.match_mode.as_str(),
                merged.enabled as i64,
                merged.id,
            ],
        )?;
        drop(conn);
        Ok(Self::get_all()?.into_iter().find(|r| r.id == id))
    }

    pub fn delete(id: &str) -> anyhow::Result<bool> {
        let conn = get_database()?;
        let changes = conn.execute("DELETE FROM privacy_rules WHERE id = ?1", params![id])?;
        Ok(changes > 0)
    }

    pub fn get_all() -> anyhow::Result<Vec<PrivacyRule>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM privacy_rules ORDER BY rowid ASC")?;
        let rules = stmt
            .query_map([], row_to_rule)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rules)
    }

    pub fn get_enabled() -> anyhow::Result<Vec<PrivacyRule>> {
        let conn = get_database()?;
        let mut stmt =
            conn.prepare("SELECT * FROM privacy_rules WHERE enabled = 1 ORDER BY rowid ASC")?;
        let rules = stmt
            .query_map([], row_to_rule)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rules)
    }

    /// 规则匹配引擎
    pub fn match_rule(
        app_name: &str,
        process_name: &str,
        window_title: &str,
        url: &str,
    ) -> anyhow::Result<PrivacyMatchResult> {
        let rules = Self::get_enabled()?;
        // 第一轮：检查 skip 类规则（app_name / process_name）
        for rule in &rules {
            match rule.rule_type {
                PrivacyRuleType::AppName => {
                    if match_value(app_name, &rule.pattern, rule.match_mode) {
                        return Ok(PrivacyMatchResult {
                            action: PrivacyAction::Skip,
                            matched_rule: Some(rule.clone()),
                        });
                    }
                }
                PrivacyRuleType::ProcessName => {
                    if match_value(process_name, &rule.pattern, rule.match_mode) {
                        return Ok(PrivacyMatchResult {
                            action: PrivacyAction::Skip,
                            matched_rule: Some(rule.clone()),
                        });
                    }
                }
                _ => {}
            }
        }
        // 第二轮：检查 placeholder 类规则（window_title / url）
        for rule in &rules {
            match rule.rule_type {
                PrivacyRuleType::WindowTitle => {
                    if match_value(window_title, &rule.pattern, rule.match_mode) {
                        return Ok(PrivacyMatchResult {
                            action: PrivacyAction::Placeholder,
                            matched_rule: Some(rule.clone()),
                        });
                    }
                }
                PrivacyRuleType::Url => {
                    if match_value(url, &rule.pattern, rule.match_mode) {
                        return Ok(PrivacyMatchResult {
                            action: PrivacyAction::Placeholder,
                            matched_rule: Some(rule.clone()),
                        });
                    }
                }
                _ => {}
            }
        }
        Ok(PrivacyMatchResult {
            action: PrivacyAction::Allow,
            matched_rule: None,
        })
    }

    /// 播种默认隐私规则（对应 PrivacyGuard.seedDefaultRules）
    pub fn seed_default_rules() -> anyhow::Result<()> {
        let existing = Self::get_all()?;
        if !existing.is_empty() {
            return Ok(());
        }
        let defaults = vec![
            // 进程级 skip
            PrivacyRule {
                id: String::new(),
                rule_type: PrivacyRuleType::ProcessName,
                pattern: "1password".to_string(),
                match_mode: PrivacyMatchMode::Contains,
                enabled: true,
            },
            PrivacyRule {
                id: String::new(),
                rule_type: PrivacyRuleType::ProcessName,
                pattern: "keepass".to_string(),
                match_mode: PrivacyMatchMode::Contains,
                enabled: true,
            },
            PrivacyRule {
                id: String::new(),
                rule_type: PrivacyRuleType::ProcessName,
                pattern: "bitwarden".to_string(),
                match_mode: PrivacyMatchMode::Contains,
                enabled: true,
            },
            // 银行/支付类窗口标题 placeholder
            PrivacyRule {
                id: String::new(),
                rule_type: PrivacyRuleType::WindowTitle,
                pattern: "银行".to_string(),
                match_mode: PrivacyMatchMode::Contains,
                enabled: true,
            },
            PrivacyRule {
                id: String::new(),
                rule_type: PrivacyRuleType::WindowTitle,
                pattern: "支付宝".to_string(),
                match_mode: PrivacyMatchMode::Contains,
                enabled: true,
            },
            PrivacyRule {
                id: String::new(),
                rule_type: PrivacyRuleType::WindowTitle,
                pattern: "微信支付".to_string(),
                match_mode: PrivacyMatchMode::Contains,
                enabled: true,
            },
        ];
        for rule in defaults {
            Self::insert(rule)?;
        }
        Ok(())
    }
}

fn merge_rule(mut existing: PrivacyRule, patch: PrivacyRule, id: &str) -> PrivacyRule {
    existing.rule_type = patch.rule_type;
    if !patch.pattern.is_empty() {
        existing.pattern = patch.pattern;
    }
    existing.match_mode = patch.match_mode;
    existing.enabled = patch.enabled;
    existing.id = id.to_string();
    existing
}
