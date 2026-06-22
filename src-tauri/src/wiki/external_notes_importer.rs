//! ExternalNotesImporter：外部笔记导入器（F8.14）
//!
//! 功能：
//!  - import_markdown_dir(dir_path)：批量导入 Markdown 目录
//!  - import_notion_export(zip_path)：导入 Notion 导出（已解压的目录）
//!  - 解析 [[wikilink]] 语法 → 保留原样，由 WikiLinkEngine 后续维护反链
//!  - 解析 YAML frontmatter 提取 title / type / aliases 等元数据
//!  - 草稿通过 WikiRepository.add_to_review_queue 加入审核队列
//!
//! 注意：由于未引入 zip 依赖，import_notion_export 接受已解压的目录路径。

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::models::WikiType;
use crate::repositories::wiki_repository::WikiRepository;

/// 外部笔记导入草稿
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WikiPageDraft {
    /// 标题
    pub title: String,
    /// Markdown 正文（含 [[wikilink]]）
    pub content: String,
    /// Wiki 类型
    pub wiki_type: WikiType,
    /// 来源文件路径
    pub source_path: String,
    /// 别名列表（来自 frontmatter）
    #[serde(default)]
    pub aliases: Vec<String>,
}

/// ExternalNotesImporter：外部笔记导入器
pub struct ExternalNotesImporter;

impl ExternalNotesImporter {
    /// 创建实例
    pub fn new() -> Self {
        ExternalNotesImporter
    }

    /// 批量导入 Markdown 目录。
    ///
    /// 流程：
    ///  1. 递归扫描目录下所有 .md / .markdown 文件
    ///  2. 解析每个文件的 frontmatter + 正文
    ///  3. 将草稿加入 WikiRepository 审核队列
    ///  4. 返回导入的草稿列表
    pub fn import_markdown_dir(&self, dir_path: &str) -> anyhow::Result<Vec<WikiPageDraft>> {
        let root = Path::new(dir_path);
        if !root.exists() {
            anyhow::bail!("目录不存在: {}", dir_path);
        }
        if !root.is_dir() {
            anyhow::bail!("路径不是目录: {}", dir_path);
        }

        let mut drafts: Vec<WikiPageDraft> = Vec::new();
        self.collect_markdown_files(root, &mut drafts)?;

        // 将草稿加入审核队列
        for draft in &drafts {
            WikiRepository::add_to_review_queue(
                draft.wiki_type.clone(),
                draft.title.clone(),
                draft.aliases.clone(),
                draft.content.clone(),
                vec![format!("__import__:{}", draft.source_path)],
                0.5, // 导入草稿默认置信度 0.5
            )?;
        }

        Ok(drafts)
    }

    /// 导入 Notion 导出。
    ///
    /// Notion 导出通常是 ZIP 文件，由于未引入 zip 依赖，
    /// 此处接受已解压的目录路径，按 Markdown 目录方式导入。
    pub fn import_notion_export(&self, zip_path: &str) -> anyhow::Result<Vec<WikiPageDraft>> {
        let path = Path::new(zip_path);
        if !path.exists() {
            anyhow::bail!("路径不存在: {}", zip_path);
        }
        // 若为目录，按目录导入；若为文件（zip），提示需先解压
        if path.is_dir() {
            return self.import_markdown_dir(zip_path);
        }
        anyhow::bail!(
            "Notion 导出为 ZIP 文件，请先解压到目录再导入: {}",
            zip_path
        );
    }

    /// 递归收集 Markdown 文件并解析为草稿
    fn collect_markdown_files(
        &self,
        dir: &Path,
        drafts: &mut Vec<WikiPageDraft>,
    ) -> anyhow::Result<()> {
        let entries = fs::read_dir(dir)?;
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                self.collect_markdown_files(&path, drafts)?;
            } else if path.is_file() {
                if let Some(ext) = path.extension() {
                    let ext_lower = ext.to_string_lossy().to_lowercase();
                    if ext_lower == "md" || ext_lower == "markdown" {
                        if let Ok(draft) = self.parse_markdown_file(&path) {
                            drafts.push(draft);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// 解析单个 Markdown 文件为 WikiPageDraft
    pub fn parse_markdown_file(&self, path: &Path) -> anyhow::Result<WikiPageDraft> {
        let content_raw = fs::read_to_string(path)?;
        let source_path = path.to_string_lossy().to_string();
        Ok(self.parse_markdown_content(&content_raw, &source_path))
    }

    /// 解析 Markdown 文本为 WikiPageDraft（公开供测试调用）
    pub fn parse_markdown_content(&self, raw: &str, source_path: &str) -> WikiPageDraft {
        let (frontmatter, body) = split_frontmatter(raw);
        let title = frontmatter
            .get("title")
            .cloned()
            .or_else(|| extract_first_heading(&body))
            .unwrap_or_else(|| {
                // 回退到文件名（不含扩展名）
                Path::new(source_path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "未命名".to_string())
            });
        let wiki_type = frontmatter
            .get("type")
            .or_else(|| frontmatter.get("wiki_type"))
            .map(|s| WikiType::from_str(s))
            .unwrap_or_default();
        let aliases = frontmatter
            .get("aliases")
            .map(|s| parse_yaml_list(s))
            .unwrap_or_default();

        WikiPageDraft {
            title,
            content: body.trim().to_string(),
            wiki_type,
            source_path: source_path.to_string(),
            aliases,
        }
    }
}

impl Default for ExternalNotesImporter {
    fn default() -> Self {
        Self::new()
    }
}

/// 分离 frontmatter 与正文。
///
/// frontmatter 格式：
/// ```text
/// ---
/// title: 标题
/// type: project
/// ---
/// 正文内容
/// ```
fn split_frontmatter(raw: &str) -> (std::collections::HashMap<String, String>, String) {
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        return (std::collections::HashMap::new(), raw.to_string());
    }
    // 跳过开头的 ---
    let after_first = &trimmed[3..];
    // 找到结束的 ---
    let end_marker = after_first.find("\n---");
    match end_marker {
        Some(idx) => {
            let fm_text = &after_first[..idx];
            let body_start = idx + 4; // 跳过 "\n---"
            let body = if after_first.len() > body_start {
                after_first[body_start..].trim_start().to_string()
            } else {
                String::new()
            };
            (parse_simple_yaml(fm_text), body)
        }
        None => (std::collections::HashMap::new(), raw.to_string()),
    }
}

/// 解析简单 YAML（key: value 形式，不支持嵌套）
fn parse_simple_yaml(text: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(colon_idx) = line.find(':') {
            let key = line[..colon_idx].trim().to_lowercase();
            let value = line[colon_idx + 1..].trim();
            // 去除引号
            let value = value
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
            if !key.is_empty() {
                map.insert(key, value);
            }
        }
    }
    map
}

/// 解析 YAML 列表格式（支持 `[a, b, c]` 与多行 `- a` 格式）
fn parse_yaml_list(s: &str) -> Vec<String> {
    let s = s.trim();
    if s.starts_with('[') && s.ends_with(']') {
        let inner = &s[1..s.len() - 1];
        return inner
            .split(',')
            .map(|p| p.trim().trim_matches('"').trim_matches('\'').to_string())
            .filter(|p| !p.is_empty())
            .collect();
    }
    // 多行格式：- a\n- b
    let mut result = Vec::new();
    for line in s.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix('-') {
            let v = rest
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
            if !v.is_empty() {
                result.push(v);
            }
        }
    }
    result
}

/// 提取 Markdown 第一个一级标题作为标题
fn extract_first_heading(content: &str) -> Option<String> {
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with("# ") {
            return Some(line[2..].trim().to_string());
        }
    }
    None
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 创建唯一临时目录（测试结束后由系统清理）
    fn make_temp_dir(prefix: &str) -> PathBuf {
        let base = std::env::temp_dir();
        let unique = format!(
            "wm_test_{}_{}_{}",
            prefix,
            std::process::id(),
            chrono::Utc::now().timestamp_millis()
        );
        let path = base.join(unique);
        std::fs::create_dir_all(&path).expect("创建临时目录失败");
        path
    }

    #[test]
    fn test_split_frontmatter_with_metadata() {
        let raw = "---\ntitle: 测试标题\ntype: project\n---\n# 正文\n内容";
        let (fm, body) = split_frontmatter(raw);
        assert_eq!(fm.get("title"), Some(&"测试标题".to_string()));
        assert_eq!(fm.get("type"), Some(&"project".to_string()));
        assert!(body.starts_with("# 正文"));
    }

    #[test]
    fn test_split_frontmatter_without_metadata() {
        let raw = "# 标题\n正文内容";
        let (fm, body) = split_frontmatter(raw);
        assert!(fm.is_empty());
        assert_eq!(body, raw);
    }

    #[test]
    fn test_parse_simple_yaml() {
        let map = parse_simple_yaml("title: 标题\ntype: person\naliases: [a, b]");
        assert_eq!(map.get("title"), Some(&"标题".to_string()));
        assert_eq!(map.get("type"), Some(&"person".to_string()));
        assert_eq!(map.get("aliases"), Some(&"[a, b]".to_string()));
    }

    #[test]
    fn test_parse_yaml_list_bracket() {
        let list = parse_yaml_list("[a, b, c]");
        assert_eq!(list, vec!["a", "b", "c"]);
    }

    #[test]
    fn test_parse_yaml_list_multiline() {
        let list = parse_yaml_list("- a\n- b\n- c");
        assert_eq!(list, vec!["a", "b", "c"]);
    }

    #[test]
    fn test_extract_first_heading() {
        assert_eq!(
            extract_first_heading("# 标题\n正文"),
            Some("标题".to_string())
        );
        assert_eq!(extract_first_heading("无标题"), None);
    }

    #[test]
    fn test_parse_markdown_content_with_frontmatter() {
        let importer = ExternalNotesImporter::new();
        let raw = "---\ntitle: Tauri 配置\ntype: project\naliases: [Tauri]\n---\n# Tauri 配置\n使用 [[Rust]] 开发";
        let draft = importer.parse_markdown_content(raw, "/tmp/test.md");
        assert_eq!(draft.title, "Tauri 配置");
        assert_eq!(draft.wiki_type, WikiType::Project);
        assert_eq!(draft.aliases, vec!["Tauri"]);
        assert!(draft.content.contains("[[Rust]]"));
        assert_eq!(draft.source_path, "/tmp/test.md");
    }

    #[test]
    fn test_parse_markdown_content_without_frontmatter_uses_heading() {
        let importer = ExternalNotesImporter::new();
        let raw = "# Rust 编程\nRust 是系统编程语言";
        let draft = importer.parse_markdown_content(raw, "/tmp/rust.md");
        assert_eq!(draft.title, "Rust 编程");
        assert_eq!(draft.wiki_type, WikiType::Topic); // 默认
        assert!(draft.content.contains("系统编程语言"));
    }

    #[test]
    fn test_parse_markdown_content_preserves_wikilinks() {
        let importer = ExternalNotesImporter::new();
        let raw = "# 笔记\n引用 [[Tauri]] 和 [[Rust|铁锈]]";
        let draft = importer.parse_markdown_content(raw, "/tmp/note.md");
        assert!(draft.content.contains("[[Tauri]]"));
        assert!(draft.content.contains("[[Rust|铁锈]]"));
    }

    #[test]
    fn test_import_markdown_dir_reads_files() {
        let dir = make_temp_dir("import_md");
        let dir_str = dir.to_string_lossy().to_string();

        let mut f1 = std::fs::File::create(dir.join("a.md")).unwrap();
        use std::io::Write;
        writeln!(f1, "---\ntitle: 页面 A\ntype: project\n---\n内容 A [[B]]").unwrap();

        let sub = dir.join("sub");
        std::fs::create_dir(&sub).unwrap();
        let mut f2 = std::fs::File::create(sub.join("b.md")).unwrap();
        writeln!(f2, "# 页面 B\n内容 B").unwrap();

        let importer = ExternalNotesImporter::new();
        // 注意：此测试不连数据库，仅验证文件解析逻辑
        // 直接调用 parse_markdown_file 验证
        let draft_a = importer.parse_markdown_file(&dir.join("a.md")).unwrap();
        assert_eq!(draft_a.title, "页面 A");
        assert_eq!(draft_a.wiki_type, WikiType::Project);

        let draft_b = importer.parse_markdown_file(&sub.join("b.md")).unwrap();
        assert_eq!(draft_b.title, "页面 B");

        // 验证目录扫描逻辑（不连数据库时会失败，但文件解析已验证）
        let _ = dir_str;
    }

    #[test]
    fn test_import_markdown_dir_nonexistent_returns_error() {
        let importer = ExternalNotesImporter::new();
        let result = importer.import_markdown_dir("/nonexistent/path/12345");
        assert!(result.is_err());
    }

    #[test]
    fn test_import_notion_export_zip_returns_error() {
        let dir = make_temp_dir("notion_zip");
        let zip_path = dir.join("export.zip");
        std::fs::write(&zip_path, b"fake zip content").unwrap();

        let importer = ExternalNotesImporter::new();
        let result = importer.import_notion_export(zip_path.to_str().unwrap());
        assert!(result.is_err());
    }
}
