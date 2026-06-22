// src-tauri/src/repositories/causal_chain_repository.rs

//! CausalChainRepository：跨 Episode 因果链数据访问层（对应 electron/db/repositories/CausalChainRepository.ts）
//!
//! causal_chains 表存储 CausalChainBuilder 产出的因果关系：
//!  - cause_cell_id / effect_cell_id：关联 memory_cells 表（外键）
//!  - relation：'leads_to' | 'blocks' | 'enables'
//!  - confidence：0-1 置信度
//!  - evidence：人类可读的证据描述
//!
//! 由 DailyDistillManager 完成后触发 buildChains 写入。

use rusqlite::params;

use crate::db::database::get_database;
use crate::models::CausalChain;

/// 从数据库行构造 CausalChain。
fn row_to_causal_chain(row: &rusqlite::Row<'_>) -> rusqlite::Result<CausalChain> {
    Ok(CausalChain {
        id: row.get("id")?,
        cause_cell_id: row.get("cause_cell_id")?,
        effect_cell_id: row.get("effect_cell_id")?,
        relation: row.get("relation")?,
        confidence: row.get("confidence")?,
        evidence: row.get("evidence")?,
        created_at: row.get("created_at")?,
    })
}

/// CausalChainRepository：跨 Episode 因果链数据访问层
pub struct CausalChainRepository;

impl CausalChainRepository {
    /// 插入一条因果链记录。
    /// id 与 created_at 为空时由仓库内部生成。
    pub fn insert(mut chain: CausalChain) -> anyhow::Result<()> {
        if chain.id.is_empty() {
            chain.id = uuid::Uuid::new_v4().to_string();
        }
        if chain.created_at.is_empty() {
            chain.created_at = chrono::Utc::now().to_rfc3339();
        }

        let conn = get_database()?;
        conn.execute(
            "INSERT INTO causal_chains (
                id, cause_cell_id, effect_cell_id, relation, confidence, evidence, created_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7
            )",
            params![
                chain.id,
                chain.cause_cell_id,
                chain.effect_cell_id,
                chain.relation,
                chain.confidence,
                chain.evidence,
                chain.created_at,
            ],
        )?;
        Ok(())
    }

    /// 按日期查询因果链：通过 JOIN memory_cells.created_at 落在指定日期的链。
    /// 日期格式 YYYY-MM-DD，基于 cause_cell 的 created_at 前缀匹配。
    pub fn get_by_date(date: &str) -> anyhow::Result<Vec<CausalChain>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT c.*
             FROM causal_chains c
             JOIN memory_cells m ON m.id = c.cause_cell_id
             WHERE substr(m.created_at, 1, 10) = ?1
             ORDER BY c.created_at ASC",
        )?;
        let chains = stmt
            .query_map(params![date], row_to_causal_chain)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(chains)
    }

    /// 按日期范围查询因果链：通过 JOIN memory_cells.created_at 落在 [start_date, end_date] 的链。
    /// 日期格式 YYYY-MM-DD，基于 cause_cell 的 created_at 前缀匹配。
    pub fn get_by_date_range(start_date: &str, end_date: &str) -> anyhow::Result<Vec<CausalChain>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT c.*
             FROM causal_chains c
             JOIN memory_cells m ON m.id = c.cause_cell_id
             WHERE substr(m.created_at, 1, 10) >= ?1 AND substr(m.created_at, 1, 10) <= ?2
             ORDER BY c.created_at ASC",
        )?;
        let chains = stmt
            .query_map(params![start_date, end_date], row_to_causal_chain)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(chains)
    }

    /// 按 cause_cell_id 查询因果链（作为原因的链），按 created_at 升序。
    pub fn get_by_cause_cell_id(cell_id: &str) -> anyhow::Result<Vec<CausalChain>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM causal_chains WHERE cause_cell_id = ?1 ORDER BY created_at ASC",
        )?;
        let chains = stmt
            .query_map(params![cell_id], row_to_causal_chain)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(chains)
    }

    /// 按 effect_cell_id 查询因果链（作为结果的链），按 created_at 升序。
    pub fn get_by_effect_cell_id(cell_id: &str) -> anyhow::Result<Vec<CausalChain>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM causal_chains WHERE effect_cell_id = ?1 ORDER BY created_at ASC",
        )?;
        let chains = stmt
            .query_map(params![cell_id], row_to_causal_chain)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(chains)
    }
}
