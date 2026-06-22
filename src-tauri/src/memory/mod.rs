//! memory 模块：结构化记忆单元（MemCell）相关业务逻辑
//!
//! 对应 electron/memory/ 目录下的 TypeScript 模块，包含：
//!  - mem_cell：MemCell 结构化记忆单元及构造器
//!  - embedding_service：本地语义向量服务（ONNX / TF-IDF 降级）
//!  - mem_cell_indexer：MemCell 语义向量索引器，监听事件总线异步生成 embedding
//!  - mem_scene_clusterer：MemScene 主题自组织聚类
//!  - user_profile_evolver：用户画像演进（stable / transient）

pub mod embedding_service;
pub mod mem_cell;
pub mod mem_cell_indexer;
pub mod mem_scene_clusterer;
pub mod user_profile_evolver;
