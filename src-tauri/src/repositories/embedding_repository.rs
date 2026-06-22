// src-tauri/src/repositories/embedding_repository.rs

//! EmbeddingRepository：MemCell 语义向量数据访问层（对应 electron/db/repositories/EmbeddingRepository.ts）
//!
//! embeddings 表存储 MemCell 的语义向量（Vec<f32> 序列化为 BLOB），
//! 通过 memory_cell_id 外键关联 memory_cells 表。
//!
//! 向量序列化：Vec<f32> ↔ Vec<u8>（小端序，每 4 字节一个 float）。
//! 语义检索：search_by_similarity 加载所有 embedding 到内存，计算余弦相似度，返回 top-N。

use rusqlite::params;

use crate::db::database::get_database;

/// 查询结果：向量 + 模型版本
pub struct EmbeddingRecord {
    pub embedding: Vec<f32>,
    pub model_version: String,
}

/// 搜索结果：memory_cell_id + 相似度分数
pub struct EmbeddingSearchResult {
    pub memory_cell_id: String,
    pub score: f64,
}

/// Vec<f32> → Vec<u8>（小端序，每 4 字节一个 float）
pub fn float32_vec_to_bytes(vec: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vec.len() * 4);
    for &f in vec {
        bytes.extend_from_slice(&f.to_le_bytes());
    }
    bytes
}

/// Vec<u8> → Vec<f32>（小端序，每 4 字节一个 float）
pub fn bytes_to_float32_vec(bytes: &[u8]) -> Vec<f32> {
    let count = bytes.len() / 4;
    (0..count)
        .map(|i| {
            let start = i * 4;
            let mut arr = [0u8; 4];
            arr.copy_from_slice(&bytes[start..start + 4]);
            f32::from_le_bytes(arr)
        })
        .collect()
}

/// 计算两个向量的余弦相似度。
///
/// 公式：dot(a, b) / (||a|| * ||b||)。
/// 任一向量为空时返回 0.0；任一向量范数为 0 时返回 0.0（避免除零）。
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f64;
    let mut norm_a = 0.0f64;
    let mut norm_b = 0.0f64;
    let len = a.len().min(b.len());
    for i in 0..len {
        let av = a[i] as f64;
        let bv = b[i] as f64;
        dot += av * bv;
        norm_a += av * av;
        norm_b += bv * bv;
    }
    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom == 0.0 {
        return 0.0;
    }
    dot / denom
}

/// EmbeddingRepository：MemCell 语义向量数据访问层
pub struct EmbeddingRepository;

impl EmbeddingRepository {
    /// 插入 embedding 记录。
    ///
    /// # 参数
    /// - `memory_cell_id`：关联的 MemCell ID
    /// - `embedding`：语义向量
    /// - `model_version`：模型版本标识（如 'tfidf-hash-384' 或 'onnx-multilingual-e5-small'）
    pub fn insert(memory_cell_id: &str, embedding: &[f32], model_version: &str) -> anyhow::Result<()> {
        let conn = get_database()?;
        let id = uuid::Uuid::new_v4().to_string();
        let created_at = chrono::Utc::now().to_rfc3339();
        let embedding_blob = float32_vec_to_bytes(embedding);
        conn.execute(
            "INSERT INTO embeddings (id, memory_cell_id, embedding, model_version, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, memory_cell_id, embedding_blob, model_version, created_at],
        )?;
        Ok(())
    }

    /// 按 memory_cell_id 查询最新的 embedding 记录。
    ///
    /// 按 created_at DESC 取第一条，返回向量 + 模型版本；不存在返回 None。
    pub fn get_by_memory_cell_id(memory_cell_id: &str) -> anyhow::Result<Option<EmbeddingRecord>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT embedding, model_version FROM embeddings
             WHERE memory_cell_id = ?1
             ORDER BY created_at DESC
             LIMIT 1",
        )?;
        let mut rows = stmt.query(params![memory_cell_id])?;
        match rows.next()? {
            Some(row) => {
                let blob: Vec<u8> = row.get(0)?;
                let model_version: String = row.get(1)?;
                Ok(Some(EmbeddingRecord {
                    embedding: bytes_to_float32_vec(&blob),
                    model_version,
                }))
            }
            None => Ok(None),
        }
    }

    /// 语义检索：加载所有 embedding 到内存，计算余弦相似度，返回 top-N。
    ///
    /// # 参数
    /// - `query_embedding`：查询向量
    /// - `limit`：返回数量上限
    ///
    /// # 返回
    /// 按 score 降序排列的 EmbeddingSearchResult 数组
    pub fn search_by_similarity(
        query_embedding: &[f32],
        limit: usize,
    ) -> anyhow::Result<Vec<EmbeddingSearchResult>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT memory_cell_id, embedding FROM embeddings")?;
        let rows = stmt.query_map([], |row| {
            let memory_cell_id: String = row.get(0)?;
            let blob: Vec<u8> = row.get(1)?;
            Ok((memory_cell_id, blob))
        })?;

        let mut results: Vec<EmbeddingSearchResult> = Vec::new();
        for row in rows {
            let (memory_cell_id, blob) = row?;
            let embedding = bytes_to_float32_vec(&blob);
            let score = cosine_similarity(query_embedding, &embedding);
            results.push(EmbeddingSearchResult {
                memory_cell_id,
                score,
            });
        }

        if results.is_empty() {
            return Ok(Vec::new());
        }

        // 按得分降序排序，取前 limit 条
        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        results.truncate(limit);
        Ok(results)
    }
}
