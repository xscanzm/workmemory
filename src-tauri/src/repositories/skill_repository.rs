// src-tauri/src/repositories/skill_repository.rs

//! SkillRepository：技能卡数据访问层（对应 electron/db/repositories/SkillRepository.ts）
//!
//! skills 表存储 SkillEvolver 产出的技能卡：
//!  - title：技能标题（如"数据库迁移工作流"），用于 get_by_title 去重
//!  - steps/traps/insights/source_cell_ids：JSON 数组
//!  - confidence：0-1
//!  - evolved_at：ISO 时间戳

use rusqlite::params;

use crate::db::database::get_database;
use crate::db::json::{parse_json_array, stringify_json_array};
use crate::models::Skill;

/// 从数据库行构造 Skill。
///
/// steps/traps/insights/source_cell_ids 解析为 JSON 数组。
fn row_to_skill(row: &rusqlite::Row<'_>) -> rusqlite::Result<Skill> {
    let steps_str: String = row.get("steps")?;
    let traps_str: String = row.get("traps")?;
    let insights_str: String = row.get("insights")?;
    let source_cell_ids_str: String = row.get("source_cell_ids")?;

    Ok(Skill {
        id: row.get("id")?,
        title: row.get("title")?,
        steps: parse_json_array::<String>(&steps_str),
        traps: parse_json_array::<String>(&traps_str),
        insights: parse_json_array::<String>(&insights_str),
        source_cell_ids: parse_json_array::<String>(&source_cell_ids_str),
        confidence: row.get("confidence")?,
        evolved_at: row.get("evolved_at")?,
    })
}

/// SkillRepository：技能卡数据访问层
pub struct SkillRepository;

impl SkillRepository {
    /// 插入技能卡。id/evolved_at 为空时由仓库内部生成。
    pub fn insert(mut skill: Skill) -> anyhow::Result<()> {
        if skill.id.is_empty() {
            skill.id = uuid::Uuid::new_v4().to_string();
        }
        if skill.evolved_at.is_empty() {
            skill.evolved_at = chrono::Utc::now().to_rfc3339();
        }

        let steps = stringify_json_array(&skill.steps);
        let traps = stringify_json_array(&skill.traps);
        let insights = stringify_json_array(&skill.insights);
        let source_cell_ids = stringify_json_array(&skill.source_cell_ids);

        let conn = get_database()?;
        conn.execute(
            "INSERT INTO skills (
                id, title, steps, traps, insights, source_cell_ids, confidence, evolved_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
            )",
            params![
                skill.id,
                skill.title,
                steps,
                traps,
                insights,
                source_cell_ids,
                skill.confidence,
                skill.evolved_at,
            ],
        )?;
        Ok(())
    }

    /// 按 ID 查询技能卡，不存在返回 None。
    pub fn get_by_id(id: &str) -> anyhow::Result<Option<Skill>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM skills WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_skill(row)?)),
            None => Ok(None),
        }
    }

    /// 查询全部技能卡（按 evolved_at 升序）。
    pub fn get_all() -> anyhow::Result<Vec<Skill>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM skills ORDER BY evolved_at ASC")?;
        let skills = stmt
            .query_map([], row_to_skill)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(skills)
    }

    /// 按 title 查询技能卡（用于去重：同 title 已存在则跳过新生成）。
    pub fn get_by_title(title: &str) -> anyhow::Result<Option<Skill>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM skills WHERE title = ?1")?;
        let mut rows = stmt.query(params![title])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_skill(row)?)),
            None => Ok(None),
        }
    }
}
