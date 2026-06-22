//! embedding_service：本地语义向量服务（对应 electron/memory/EmbeddingService.ts）
//!
//! 为 MemCell 提供语义向量化能力，支持语义检索（如"前端组件开发"查询能匹配到
//! "UI 组件库实现"的 MemCell）。
//!
//! 后端策略：
//!  1. ONNX 模型（multilingual-e5-small）：当 resources/embedding/model.onnx 与
//!     vocab.txt 同时存在且 ort crate 可用时，使用 ONNX 推理生成 384 维语义向量。
//!  2. TF-IDF 哈希降级方案：当 ONNX 模型不可用时（模型文件缺失或 ort crate 未启用），
//!     使用基于 TF-IDF + 带符号哈希（sign hashing trick）的 384 维向量。
//!
//! 当前实现：由于 `ort` crate 在 Cargo.toml 中被注释禁用，本模块仅提供 stub 实现：
//!  - `is_available()` 返回 false
//!  - `embed()` / `embed_batch()` 返回 "embedding service not available" 错误
//!  - 待 ort 启用后，可在此处接入真实 ONNX 推理
//!
//! 依赖声明（在 Cargo.toml 中取消注释即可启用）：
//! ```toml
//! ort = { version = "2", features = ["download-binaries"] }
//! ```
//!
//! 向量存储通过 `crate::repositories::embedding_repository::EmbeddingRepository` 完成。

use crate::repositories::embedding_repository::EmbeddingRepository;

/// 向量维度（与 multilingual-e5-small 一致）
pub const EMBEDDING_DIM: usize = 384;

/// ONNX 模型版本标识
pub const ONNX_MODEL_VERSION: &str = "onnx-multilingual-e5-small";

/// TF-IDF 降级方案版本标识
pub const TFIDF_MODEL_VERSION: &str = "tfidf-hash-384";

/// 嵌入后端类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbeddingBackend {
    /// ONNX 推理后端
    Onnx,
    /// TF-IDF 哈希降级后端
    Tfidf,
    /// 不可用（stub 模式）
    Unavailable,
}

/// EmbeddingService：本地语义向量服务
///
/// 当前为 stub 实现，待 `ort` crate 启用后接入真实 ONNX 推理。
pub struct EmbeddingService;

impl EmbeddingService {
    /// 创建 EmbeddingService 实例
    pub fn new() -> Self {
        EmbeddingService
    }

    /// 服务是否可用
    ///
    /// 当前 stub 实现始终返回 false（ort crate 未启用）。
    /// 待 ort 启用并加载模型后返回 true。
    pub fn is_available(&self) -> bool {
        false
    }

    /// 获取当前后端类型
    pub fn get_backend(&self) -> EmbeddingBackend {
        EmbeddingBackend::Unavailable
    }

    /// 获取当前模型版本标识
    pub fn get_model_version(&self) -> &'static str {
        // stub 模式下返回 TF-IDF 版本标识，保持与 TS 实现一致的语义
        TFIDF_MODEL_VERSION
    }

    /// 获取向量维度
    pub fn get_dimension(&self) -> usize {
        EMBEDDING_DIM
    }

    /// 生成文本的语义向量
    ///
    /// 当前 stub 实现始终返回错误。待 ort 启用后接入真实推理。
    pub fn embed(&self, _text: &str) -> anyhow::Result<Vec<f32>> {
        Err(anyhow::anyhow!("embedding service not available"))
    }

    /// 批量生成语义向量
    ///
    /// 当前 stub 实现始终返回错误。待 ort 启用后接入真实推理。
    pub fn embed_batch(&self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            // 空数组直接返回空结果，不视为错误
            return Ok(Vec::new());
        }
        Err(anyhow::anyhow!("embedding service not available"))
    }

    /// 计算两个向量的余弦相似度
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
}

impl Default for EmbeddingService {
    fn default() -> Self {
        Self::new()
    }
}

/// EmbeddingService 单例（懒加载）
///
/// 通过 `once_cell::sync::Lazy` 提供进程内单例，避免重复初始化。
static EMBEDDING_SERVICE_INSTANCE: once_cell::sync::Lazy<EmbeddingService> =
    once_cell::sync::Lazy::new(EmbeddingService::new);

/// 获取 EmbeddingService 单例
pub fn get_embedding_service() -> &'static EmbeddingService {
    &EMBEDDING_SERVICE_INSTANCE
}

/// 便捷函数：将文本生成 embedding 并存入 EmbeddingRepository
///
/// 当前 stub 实现会直接返回 EmbeddingService::embed 的错误。
pub fn embed_and_store(memory_cell_id: &str, text: &str) -> anyhow::Result<()> {
    let service = get_embedding_service();
    let embedding = service.embed(text)?;
    EmbeddingRepository::insert(memory_cell_id, &embedding, service.get_model_version())
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stub_is_unavailable() {
        let service = EmbeddingService::new();
        // stub 模式下服务不可用
        assert!(!service.is_available());
        assert_eq!(service.get_backend(), EmbeddingBackend::Unavailable);
    }

    #[test]
    fn test_stub_embed_returns_error() {
        let service = EmbeddingService::new();
        let result = service.embed("前端组件开发");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("not available"), "错误信息应包含 not available，实际: {}", err);
    }

    #[test]
    fn test_stub_embed_batch_empty_returns_ok() {
        let service = EmbeddingService::new();
        // 空数组应返回 Ok 空向量，不视为错误
        let result = service.embed_batch(&[]);
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[test]
    fn test_stub_embed_batch_non_empty_returns_error() {
        let service = EmbeddingService::new();
        let texts = vec!["文本A".to_string(), "文本B".to_string()];
        let result = service.embed_batch(&texts);
        assert!(result.is_err());
    }

    #[test]
    fn test_cosine_similarity_identical_vectors() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![1.0, 0.0, 0.0];
        let sim = EmbeddingService::cosine_similarity(&a, &b);
        assert!((sim - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_cosine_similarity_orthogonal_vectors() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        let sim = EmbeddingService::cosine_similarity(&a, &b);
        assert!(sim.abs() < 1e-6);
    }

    #[test]
    fn test_cosine_similarity_empty_vectors() {
        let a: Vec<f32> = Vec::new();
        let b = vec![1.0, 2.0];
        let sim = EmbeddingService::cosine_similarity(&a, &b);
        assert_eq!(sim, 0.0);
    }

    #[test]
    fn test_cosine_similarity_zero_vector() {
        let a = vec![0.0, 0.0];
        let b = vec![1.0, 2.0];
        let sim = EmbeddingService::cosine_similarity(&a, &b);
        assert_eq!(sim, 0.0);
    }

    #[test]
    fn test_model_version_constant() {
        let service = EmbeddingService::new();
        assert_eq!(service.get_model_version(), TFIDF_MODEL_VERSION);
        assert_eq!(service.get_dimension(), EMBEDDING_DIM);
    }

    #[test]
    fn test_singleton_returns_same_instance() {
        let s1 = get_embedding_service();
        let s2 = get_embedding_service();
        // 两次获取应为同一地址（单例）
        assert!(std::ptr::eq(s1, s2));
    }
}
