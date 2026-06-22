//! mem_scene_clusterer：MemScene 主题自组织聚类（对应 electron/memory/MemSceneClusterer.ts）
//!
//! 职责：
//!  - cluster_scenes()：将语义相似的 MemCell 聚类为 MemScene（主题场景）
//!  - 聚类算法：基于 embedding 余弦相似度，相似度 > 阈值则归并到同一 MemScene
//!  - 质心增量更新：归并时新质心 = (旧质心 * 旧成员数 + 新向量) / (旧成员数 + 1)
//!
//! 设计说明：
//!  - 借鉴 EverOS MemScene 概念，将语义相似的 MemCell 自组织聚类为 MemScene，
//!    支持跨时间的主题关联发现
//!  - 当前 EmbeddingService 为 stub，cluster_scenes 会返回空结果（无可用 embedding）
//!  - 待 ort 启用后，聚类逻辑可正常工作

use std::sync::atomic::{AtomicBool, Ordering};

use crate::memory::embedding_service::EmbeddingService;
use crate::models::{MemCell, MemScene};
use crate::repositories::embedding_repository::EmbeddingRepository;
use crate::repositories::mem_cell_repository::MemCellRepository;
use crate::repositories::mem_scene_repository::MemSceneRepository;

/// 聚类阈值：余弦相似度 > 0.85 则归并到同一 MemScene
pub const SIMILARITY_THRESHOLD: f64 = 0.85;

/// 降级标题最大长度（按字符计）
pub const FALLBACK_TITLE_MAX_CHARS: usize = 30;

/// MemSceneClusterer：MemScene 主题自组织聚类器
pub struct MemSceneClusterer {
    /// 是否正在运行聚类
    running: AtomicBool,
}

/// 聚类结果
#[derive(Debug, Clone)]
pub struct ClusterResult {
    /// 归并到的 MemScene ID
    pub scene_id: String,
    /// 是否为新建的 MemScene
    pub is_new: bool,
}

impl MemSceneClusterer {
    /// 创建聚类器实例
    pub fn new() -> Self {
        MemSceneClusterer {
            running: AtomicBool::new(false),
        }
    }

    /// 是否正在运行聚类
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// 全量聚类：将所有 MemCell 按语义相似度聚类为 MemScene
    ///
    /// 算法：
    ///  1. 通过 MemCellRepository 获取全部 MemCell（按时间范围）
    ///  2. 对每个 MemCell，从 EmbeddingRepository 获取其 embedding
    ///  3. 计算与所有现有 MemScene 质心的余弦相似度
    ///  4. 最大相似度 > 阈值 → 归并：addMember + updateCentroid（增量更新质心）
    ///  5. 最大相似度 ≤ 阈值 → 新建 MemScene
    ///
    /// 当前 EmbeddingService 为 stub，无可用 embedding 时返回空 Vec。
    pub fn cluster_scenes(&self) -> anyhow::Result<Vec<MemScene>> {
        self.running.store(true, Ordering::SeqCst);
        let result = self.do_cluster_scenes();
        self.running.store(false, Ordering::SeqCst);
        result
    }

    /// 实际聚类逻辑（内部函数，由 cluster_scenes 调用并管理 running 状态）
    fn do_cluster_scenes(&self) -> anyhow::Result<Vec<MemScene>> {
        // 1. 获取全部 MemCell（使用宽松时间范围覆盖所有历史数据）
        let mem_cells = MemCellRepository::get_by_date_range(
            "1970-01-01T00:00:00.000Z",
            "2999-12-31T23:59:59.999Z",
        )?;

        if mem_cells.is_empty() {
            return Ok(Vec::new());
        }

        // 2. 加载现有 MemScene（用于增量聚类）
        let mut scenes = MemSceneRepository::get_all()?;

        // 3. 对每个 MemCell 进行增量聚类
        for cell in &mem_cells {
            // 从 EmbeddingRepository 获取 embedding
            let record = match EmbeddingRepository::get_by_memory_cell_id(&cell.id)? {
                Some(r) => r,
                None => {
                    // 无 embedding 跳过（EmbeddingService stub 模式下所有 MemCell 都会跳过）
                    continue;
                }
            };
            let new_embedding = &record.embedding;

            // 4. 计算与每个 MemScene 质心的余弦相似度，找最大值
            let mut best_idx: Option<usize> = None;
            let mut best_score = f64::NEG_INFINITY;
            for (idx, scene) in scenes.iter().enumerate() {
                let score = EmbeddingService::cosine_similarity(new_embedding, &scene.centroid_embedding);
                if score > best_score {
                    best_score = score;
                    best_idx = Some(idx);
                }
            }

            // 5. 归并或新建
            if let Some(idx) = best_idx {
                if best_score > SIMILARITY_THRESHOLD {
                    // 归并到现有 MemScene：增量更新质心
                    let old_member_count = scenes[idx].member_cell_ids.len();
                    let new_centroid = compute_new_centroid(
                        &scenes[idx].centroid_embedding,
                        new_embedding,
                        old_member_count,
                    );
                    // 持久化：addMember + updateCentroid
                    if let Err(e) = MemSceneRepository::add_member(&scenes[idx].id, &cell.id) {
                        log::warn!(
                            "[MemSceneClusterer] add_member 失败 (scene={}, cell={}): {}",
                            scenes[idx].id,
                            cell.id,
                            e
                        );
                    }
                    if let Err(e) =
                        MemSceneRepository::update_centroid(&scenes[idx].id, &new_centroid)
                    {
                        log::warn!(
                            "[MemSceneClusterer] update_centroid 失败 (scene={}): {}",
                            scenes[idx].id,
                            e
                        );
                    }
                    // 同步内存中的 scenes
                    scenes[idx].centroid_embedding = new_centroid;
                    if !scenes[idx].member_cell_ids.iter().any(|m| m == &cell.id) {
                        scenes[idx].member_cell_ids.push(cell.id.clone());
                    }
                    scenes[idx].updated_at = chrono::Utc::now().to_rfc3339();
                    continue;
                }
            }

            // 6. 新建 MemScene（无现有 MemScene 或最大相似度 ≤ 阈值）
            let title = generate_fallback_title(&cell.episode);
            let now = chrono::Utc::now().to_rfc3339();
            let scene = MemScene {
                id: uuid::Uuid::new_v4().to_string(),
                title,
                centroid_embedding: new_embedding.clone(),
                member_cell_ids: vec![cell.id.clone()],
                summary: String::new(),
                created_at: now.clone(),
                updated_at: now,
            };
            // 持久化
            if let Err(e) = MemSceneRepository::insert(scene.clone()) {
                log::warn!(
                    "[MemSceneClusterer] insert MemScene 失败 (cell={}): {}",
                    cell.id,
                    e
                );
            }
            scenes.push(scene);
        }

        Ok(scenes)
    }

    /// 增量聚类单个 MemCell：归并到现有 MemScene 或新建 MemScene
    ///
    /// 与 `cluster_scenes` 的区别：仅处理一个 MemCell，不重新聚类全部历史数据。
    /// 适用于 MemCellIndexer 在创建 MemCell 后立即触发聚类的场景。
    pub fn cluster_mem_cell(&self, mem_cell: &MemCell) -> anyhow::Result<ClusterResult> {
        // 1. 获取新 MemCell 的 embedding
        let record = EmbeddingRepository::get_by_memory_cell_id(&mem_cell.id)?
            .ok_or_else(|| {
                anyhow::anyhow!("MemCell {} 没有 embedding，无法聚类", mem_cell.id)
            })?;
        let new_embedding = record.embedding;

        // 2. 加载所有现有 MemScene
        let scenes = MemSceneRepository::get_all()?;

        // 3. 计算与每个质心的余弦相似度，找最大值
        let mut best_scene: Option<MemScene> = None;
        let mut best_score = f64::NEG_INFINITY;
        for scene in scenes {
            let score =
                EmbeddingService::cosine_similarity(&new_embedding, &scene.centroid_embedding);
            if score > best_score {
                best_score = score;
                best_scene = Some(scene);
            }
        }

        // 4. 归并或新建
        if let Some(best) = best_scene {
            if best_score > SIMILARITY_THRESHOLD {
                // 归并到现有 MemScene：增量更新质心
                let old_member_count = best.member_cell_ids.len();
                let new_centroid = compute_new_centroid(
                    &best.centroid_embedding,
                    &new_embedding,
                    old_member_count,
                );
                MemSceneRepository::add_member(&best.id, &mem_cell.id)?;
                MemSceneRepository::update_centroid(&best.id, &new_centroid)?;
                return Ok(ClusterResult {
                    scene_id: best.id,
                    is_new: false,
                });
            }
        }

        // 5. 新建 MemScene
        let title = generate_fallback_title(&mem_cell.episode);
        let now = chrono::Utc::now().to_rfc3339();
        let scene = MemScene {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            centroid_embedding: new_embedding,
            member_cell_ids: vec![mem_cell.id.clone()],
            summary: String::new(),
            created_at: now.clone(),
            updated_at: now,
        };
        let scene_id = scene.id.clone();
        MemSceneRepository::insert(scene)?;
        Ok(ClusterResult {
            scene_id,
            is_new: true,
        })
    }
}

impl Default for MemSceneClusterer {
    fn default() -> Self {
        Self::new()
    }
}

/// 计算归并后的新质心（增量更新，避免重新计算所有成员向量）
///
/// 新质心 = (旧质心 * 旧成员数 + 新向量) / (旧成员数 + 1)
fn compute_new_centroid(
    old_centroid: &[f32],
    new_vector: &[f32],
    old_member_count: usize,
) -> Vec<f32> {
    let dim = old_centroid.len().min(new_vector.len());
    let new_count = old_member_count + 1;
    let mut result = vec![0.0f32; dim];
    for i in 0..dim {
        result[i] =
            (old_centroid[i] * old_member_count as f32 + new_vector[i]) / new_count as f32;
    }
    result
}

/// 生成降级标题：取 episode 前 N 个字符
///
/// 当 AI 标题生成不可用时使用（当前实现始终使用降级标题）。
fn generate_fallback_title(episode: &str) -> String {
    episode.chars().take(FALLBACK_TITLE_MAX_CHARS).collect()
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_clusterer_not_running() {
        let clusterer = MemSceneClusterer::new();
        assert!(!clusterer.is_running());
    }

    #[test]
    fn test_compute_new_centroid_basic() {
        let old = vec![1.0, 2.0, 3.0];
        let new_vec = vec![3.0, 2.0, 1.0];
        // old_member_count=1, new_count=2
        // 新质心 = (old * 1 + new) / 2 = [(1+3)/2, (2+2)/2, (3+1)/2] = [2, 2, 2]
        let result = compute_new_centroid(&old, &new_vec, 1);
        assert_eq!(result, vec![2.0, 2.0, 2.0]);
    }

    #[test]
    fn test_compute_new_centroid_zero_members() {
        let old = vec![0.0, 0.0];
        let new_vec = vec![4.0, 6.0];
        // old_member_count=0, new_count=1
        // 新质心 = (old * 0 + new) / 1 = new
        let result = compute_new_centroid(&old, &new_vec, 0);
        assert_eq!(result, vec![4.0, 6.0]);
    }

    #[test]
    fn test_generate_fallback_title_short_episode() {
        let episode = "用户实现了加密功能";
        let title = generate_fallback_title(episode);
        // 短文本应原样返回
        assert_eq!(title, episode);
    }

    #[test]
    fn test_generate_fallback_title_long_episode_truncated() {
        let episode = "这是一个非常非常非常非常非常非常非常非常非常非常非常非常非常长的 episode 描述文本需要被截断";
        let title = generate_fallback_title(episode);
        // 应被截断为 FALLBACK_TITLE_MAX_CHARS 个字符
        assert_eq!(title.chars().count(), FALLBACK_TITLE_MAX_CHARS);
    }

    #[test]
    fn test_similarity_threshold_constant() {
        // 验证阈值常量符合预期
        assert!((SIMILARITY_THRESHOLD - 0.85).abs() < 1e-6);
    }

    #[test]
    fn test_cluster_mem_cell_without_embedding_returns_error() {
        // 无 embedding 时应返回错误（不 panic）
        // 注意：此测试需要数据库未初始化或该 MemCell 不存在 embedding 记录
        // 在测试环境中，get_by_memory_cell_id 会因数据库未初始化而返回 Err
        let clusterer = MemSceneClusterer::new();
        let cell = MemCell {
            id: "non-existent-cell".to_string(),
            clean_episode_id: "ep-1".to_string(),
            episode: "测试".to_string(),
            facts: Vec::new(),
            foresight: Vec::new(),
            metadata: Default::default(),
            created_at: "2026-06-22T10:00:00Z".to_string(),
        };
        let result = clusterer.cluster_mem_cell(&cell);
        // 应返回错误（数据库未初始化或无 embedding）
        assert!(result.is_err());
    }
}
