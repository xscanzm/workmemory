/** FTS5 中文分词预处理（对应 electron/db/ftsTokenizer.ts）
 *
 * 问题：SQLite FTS5 默认 `unicode61` tokenizer 将整段中文字符串视为单个 token，
 * 导致双字滑窗（bigram）MATCH 查询无法命中。
 *
 * 解决方案：在写入 FTS5 索引前，将文本预处理为空格分隔的 bigram 序列。
 * 例如 "前端组件开发" → "前端 端组 组件 件开 开发"。
 */

/// 将文本预处理为空格分隔的 token 序列，供 FTS5 索引使用。
///
/// 规则：
///  - 中文：双字滑窗（bigram）
///  - 英文：按空格/标点切分单词（≥2 字符，小写化）
///  - 数字：独立 token
pub fn preprocess_fts_text(text: Option<&str>) -> String {
    let text = match text {
        Some(t) => t,
        None => return String::new(),
    };
    let mut tokens: Vec<String> = Vec::new();

    // 中文双字滑窗（bigram）
    let chinese_chars: Vec<char> = text.chars().filter(|&c| is_chinese_char(c)).collect();
    if !chinese_chars.is_empty() {
        if chinese_chars.len() == 1 {
            tokens.push(chinese_chars[0].to_string());
        } else {
            for i in 0..chinese_chars.len() - 1 {
                let mut bigram = String::new();
                bigram.push(chinese_chars[i]);
                bigram.push(chinese_chars[i + 1]);
                tokens.push(bigram);
            }
        }
    }

    // 英文单词（≥2 字符，小写化）
    let mut current_word = String::new();
    for c in text.chars() {
        if c.is_ascii_alphabetic() {
            current_word.push(c);
        } else {
            if current_word.len() >= 2 {
                tokens.push(current_word.to_lowercase());
            }
            current_word.clear();
        }
    }
    if current_word.len() >= 2 {
        tokens.push(current_word.to_lowercase());
    }

    // 数字 token
    let mut current_num = String::new();
    for c in text.chars() {
        if c.is_ascii_digit() {
            current_num.push(c);
        } else {
            if !current_num.is_empty() {
                tokens.push(current_num.clone());
            }
            current_num.clear();
        }
    }
    if !current_num.is_empty() {
        tokens.push(current_num);
    }

    tokens.join(" ")
}

/// 判断字符是否为中文字符（CJK 统一表意文字基本区）
fn is_chinese_char(c: char) -> bool {
    let code = c as u32;
    (0x4E00..=0x9FA5).contains(&code)
}

/// 在 rusqlite 连接上注册 `wm_preprocess_fts` 自定义 SQL 函数。
///
/// 该函数被 fts_memory_cells 的同步触发器调用，确保写入 FTS5 索引的中文文本
/// 被预处理为 bigram 序列。必须在触发器触发（memory_cells INSERT/UPDATE/DELETE）之前注册。
pub fn register_fts_functions(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.create_scalar_function(
        "wm_preprocess_fts",
        1,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8 | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx: &rusqlite::functions::Context<'_>| -> rusqlite::Result<String> {
            let text: Option<String> = ctx.get(0)?;
            Ok(preprocess_fts_text(text.as_deref()))
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chinese_bigram() {
        let result = preprocess_fts_text(Some("前端组件开发"));
        assert_eq!(result, "前端 端组 组件 件开 开发");
    }

    #[test]
    fn test_single_chinese_char() {
        let result = preprocess_fts_text(Some("中"));
        assert_eq!(result, "中");
    }

    #[test]
    fn test_english_words() {
        let result = preprocess_fts_text(Some("Hello World API"));
        assert_eq!(result, "hello world api");
    }

    #[test]
    fn test_numbers() {
        let result = preprocess_fts_text(Some("v2 version 123"));
        // "v" 长度 < 2 被跳过，"2" 和 "123" 作为数字 token
        assert_eq!(result, "version 2 123");
    }

    #[test]
    fn test_none() {
        let result = preprocess_fts_text(None);
        assert_eq!(result, "");
    }

    #[test]
    fn test_mixed() {
        let result = preprocess_fts_text(Some("前端 API v2"));
        assert!(result.contains("前端"));
        assert!(result.contains("api"));
        assert!(result.contains("2"));
    }
}
