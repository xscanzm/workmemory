//! OpenAIClient：OpenAI-compatible API 客户端（对应 electron/ai/OpenAIClient.ts）
//!
//! 使用 reqwest 实现，支持 OpenAI、Azure OpenAI、本地 Ollama 等兼容接口。
//!
//! 特性：
//!  - chat_completion 非流式调用
//!  - chat_completion_stream 流式调用（SSE 解析）
//!  - test_connection 连接测试
//!  - 错误处理：网络错误、401 鉴权失败、429 限流、5xx 服务端错误
//!  - 自动重试：429 和 5xx 重试 2 次，指数退避（1s, 2s）
//!  - 超时：30 秒
//!  - reasoning_content 兜底：content 为空时回退使用 reasoning_content

use std::time::Duration;

use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::repositories::settings_store::SettingsStore;

/// 默认 API Base URL
const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
/// 请求超时（秒）
const REQUEST_TIMEOUT_SECS: u64 = 30;
/// 最大重试次数（429 和 5xx）
const MAX_RETRIES: u32 = 2;
/// 重试基础延迟（毫秒），指数退避：1s, 2s
const RETRY_BASE_DELAY_MS: u64 = 1_000;

// ===================== 错误类型 =====================

/// OpenAI API 错误，携带 HTTP 状态码与重试信息
#[derive(Debug, Clone)]
pub struct OpenAiApiError {
    /// HTTP 状态码（网络错误时为 0）
    pub status_code: u16,
    /// 是否可重试（429/5xx/网络错误为 true）
    pub is_retryable: bool,
    /// 错误原因代码（reasoning_only / length_without_content / 空字符串）
    pub reason_code: String,
    /// 错误消息
    pub message: String,
}

impl OpenAiApiError {
    pub fn new(message: impl Into<String>, status_code: u16, is_retryable: bool) -> Self {
        OpenAiApiError {
            status_code,
            is_retryable,
            reason_code: String::new(),
            message: message.into(),
        }
    }

    pub fn with_reason_code(
        message: impl Into<String>,
        status_code: u16,
        is_retryable: bool,
        reason_code: impl Into<String>,
    ) -> Self {
        OpenAiApiError {
            status_code,
            is_retryable,
            reason_code: reason_code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for OpenAiApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "OpenAiApiError(status={}, retryable={}, reason={}, msg={})",
            self.status_code, self.is_retryable, self.reason_code, self.message
        )
    }
}

impl std::error::Error for OpenAiApiError {}

// ===================== 请求 / 响应结构 =====================

/// 聊天消息（role: system / user / assistant）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    /// 角色：system / user / assistant
    pub role: String,
    /// 消息内容
    pub content: String,
}

impl Message {
    pub fn new(role: impl Into<String>, content: impl Into<String>) -> Self {
        Message {
            role: role.into(),
            content: content.into(),
        }
    }
}

/// chatCompletion 请求参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatCompletionRequest {
    /// 模型名
    pub model: String,
    /// 消息列表
    pub messages: Vec<Message>,
    /// 温度（0-2），默认 0.4
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// 最大 token 数
    #[serde(skip_serializing_if = "Option::is_none", rename = "max_tokens")]
    pub max_tokens: Option<u32>,
    /// 是否流式
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
}

impl ChatCompletionRequest {
    pub fn new(model: impl Into<String>, messages: Vec<Message>) -> Self {
        ChatCompletionRequest {
            model: model.into(),
            messages,
            temperature: None,
            max_tokens: None,
            stream: None,
        }
    }
}

/// token 用量
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Usage {
    #[serde(default)]
    pub prompt_tokens: u32,
    #[serde(default)]
    pub completion_tokens: u32,
    #[serde(default)]
    pub total_tokens: u32,
}

/// chatCompletion 响应
#[derive(Debug, Clone)]
pub struct ChatCompletionResponse {
    /// 文本内容（若为空且 reasoning_content 存在，则使用 reasoning_content）
    pub content: String,
    /// 实际使用的模型名
    pub model: String,
    /// token 用量
    pub usage: Option<Usage>,
    /// 结束原因（stop / length / content_filter 等）
    pub finish_reason: String,
}

// ===================== 内部响应结构（用于反序列化） =====================

/// OpenAI API 原始响应（仅取需要的字段）
#[derive(Debug, Deserialize)]
struct OpenAiResponse {
    #[serde(default)]
    choices: Vec<OpenAiChoice>,
    #[serde(default)]
    usage: Option<Usage>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    error: Option<OpenAiErrorBody>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChoice {
    #[serde(default)]
    message: Option<OpenAiMessage>,
    #[serde(default)]
    finish_reason: Option<String>,
}

/// 消息体（content / reasoning_content 可能是字符串或数组，用 Value 统一处理）
#[derive(Debug, Deserialize)]
struct OpenAiMessage {
    #[serde(default)]
    content: Option<serde_json::Value>,
    #[serde(default)]
    reasoning_content: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct OpenAiErrorBody {
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    code: Option<String>,
}

/// 流式响应中的单条 chunk
#[derive(Debug, Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
    #[serde(default)]
    #[allow(dead_code)]
    model: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: Option<StreamDelta>,
    #[serde(default)]
    #[allow(dead_code)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
}

// ===================== 工具函数 =====================

/// 规范化助手文本（处理字符串或数组形式）
fn normalize_assistant_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.trim().to_string(),
        serde_json::Value::Array(arr) => {
            let parts: Vec<String> = arr
                .iter()
                .filter_map(|item| {
                    if let Some(s) = item.as_str() {
                        return Some(s.to_string());
                    }
                    if let Some(obj) = item.as_object() {
                        if let Some(s) = obj.get("text").and_then(|v| v.as_str()) {
                            return Some(s.to_string());
                        }
                        if let Some(s) = obj.get("content").and_then(|v| v.as_str()) {
                            return Some(s.to_string());
                        }
                    }
                    None
                })
                .collect();
            parts.join("\n").trim().to_string()
        }
        _ => String::new(),
    }
}

/// 拼接 chat/completions URL
/// - 支持 base URL（如 https://api.openai.com/v1）
/// - 支持完整地址（如 https://api.openai.com/v1/chat/completions）
fn get_chat_completions_url(raw_base_url: &str) -> String {
    let trimmed = if raw_base_url.trim().is_empty() {
        DEFAULT_BASE_URL
    } else {
        raw_base_url.trim().trim_end_matches('/')
    };
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{}/chat/completions", trimmed)
    }
}

/// 汇总非 JSON 响应体为错误消息
fn summarize_non_json_body(status_code: u16, body: &str) -> String {
    let compact: String = body.split_whitespace().collect();
    let preview = if compact.len() > 200 {
        &compact[..200]
    } else {
        &compact
    };
    let lower = compact.to_lowercase();
    if lower.starts_with("<!doctype html") || lower.starts_with("<html") {
        return format!(
            "接口返回 HTML 而不是 JSON (HTTP {})，通常是 API URL 不正确或填成了网页地址。请填写 OpenAI-compatible Base URL，例如 https://api.example.com/v1；也支持完整 /chat/completions 地址。响应预览: {}",
            status_code, preview
        );
    }
    format!(
        "响应体 JSON 解析失败 (HTTP {}): {}",
        status_code, preview
    )
}

/// 睡眠（毫秒）
async fn sleep_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

// ===================== 客户端 =====================

/// OpenAI-compatible 客户端
pub struct OpenAIClient {
    client: Client,
}

impl OpenAIClient {
    /// 创建客户端（30s 超时）
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .expect("reqwest::Client 构建失败");
        OpenAIClient { client }
    }

    /// 从 SettingsStore 读取 API Key
    fn get_api_key() -> Result<String> {
        let key = SettingsStore::get_api_key();
        if key.is_empty() {
            return Err(anyhow!("未配置 AI API Key，请在设置中配置"));
        }
        Ok(key)
    }

    /// 从 SettingsStore 读取 Base URL（默认 https://api.openai.com/v1）
    fn get_base_url() -> String {
        let url = SettingsStore::get().api_base_url;
        if url.trim().is_empty() {
            DEFAULT_BASE_URL.to_string()
        } else {
            url
        }
    }

    /// 调用 chat/completions 接口（非流式）。
    ///
    /// 自动重试：429 和 5xx 错误重试 2 次，指数退避（1s, 2s）。
    /// 超时：30 秒。
    ///
    /// reasoning_content 兜底：若 content 为空但 reasoning_content 存在，使用 reasoning_content。
    pub async fn chat_completion(
        &self,
        req: ChatCompletionRequest,
    ) -> Result<ChatCompletionResponse> {
        let api_key = Self::get_api_key()?;
        let base_url = Self::get_base_url();
        let url = get_chat_completions_url(&base_url);

        let mut last_error: Option<OpenAiApiError> = None;
        for attempt in 0..=MAX_RETRIES {
            match self.do_chat_completion_once(&url, &api_key, &req).await {
                Ok(resp) => return Ok(resp),
                Err(err) => {
                    let retryable = err.is_retryable;
                    last_error = Some(err);
                    if retryable && attempt < MAX_RETRIES {
                        // 指数退避：1s, 2s
                        let delay = RETRY_BASE_DELAY_MS * 2u64.pow(attempt);
                        sleep_ms(delay).await;
                        continue;
                    }
                    // 不可重试或重试耗尽，抛出
                    return Err(anyhow!(last_error.unwrap()));
                }
            }
        }
        // 理论上不会到达
        Err(anyhow!(last_error.unwrap_or_else(|| {
            OpenAiApiError::new("chat_completion 未知失败", 0, false)
        })))
    }

    /// 执行单次 chatCompletion 请求（不含重试）
    async fn do_chat_completion_once(
        &self,
        url: &str,
        api_key: &str,
        req: &ChatCompletionRequest,
    ) -> std::result::Result<ChatCompletionResponse, OpenAiApiError> {
        let resp = self
            .client
            .post(url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(req)
            .send()
            .await
            .map_err(|e| OpenAiApiError::new(format!("网络请求失败: {}", e), 0, true))?;

        let status_code = resp.status().as_u16();
        let body = resp
            .text()
            .await
            .map_err(|e| OpenAiApiError::new(format!("读取响应失败: {}", e), 0, true))?;

        // 解析响应体
        let data: OpenAiResponse = serde_json::from_str(&body).map_err(|_| {
            OpenAiApiError::new(summarize_non_json_body(status_code, &body), status_code, false)
        })?;

        // 错误状态码处理
        if status_code == 401 {
            let msg = data
                .error
                .as_ref()
                .and_then(|e| e.message.clone())
                .unwrap_or_else(|| "API Key 鉴权失败，请检查设置中的 API Key".to_string());
            return Err(OpenAiApiError::new(msg, 401, false));
        }
        if status_code == 429 {
            let msg = data
                .error
                .as_ref()
                .and_then(|e| e.message.clone())
                .unwrap_or_else(|| "请求被限流（429），请稍后重试".to_string());
            return Err(OpenAiApiError::new(msg, 429, true));
        }
        if status_code >= 500 {
            let msg = data
                .error
                .as_ref()
                .and_then(|e| e.message.clone())
                .unwrap_or_else(|| format!("服务端错误 (HTTP {})", status_code));
            return Err(OpenAiApiError::new(msg, status_code, true));
        }
        if status_code < 200 || status_code >= 300 {
            let msg = data
                .error
                .as_ref()
                .and_then(|e| e.message.clone())
                .unwrap_or_else(|| format!("请求失败 (HTTP {})", status_code));
            return Err(OpenAiApiError::new(msg, status_code, false));
        }

        // 提取内容
        let choice = data.choices.first();
        let content = choice
            .and_then(|c| c.message.as_ref())
            .map(|m| {
                m.content
                    .as_ref()
                    .map(normalize_assistant_text)
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        let reasoning_content = choice
            .and_then(|c| c.message.as_ref())
            .and_then(|m| m.reasoning_content.as_ref())
            .map(normalize_assistant_text)
            .unwrap_or_default();
        let finish_reason = choice
            .and_then(|c| c.finish_reason.clone())
            .unwrap_or_else(|| "unknown".to_string());
        let model = data.model.unwrap_or_default();

        // reasoning_content 兜底：content 为空但 reasoning_content 存在时使用 reasoning_content
        let final_content = if content.is_empty() {
            if reasoning_content.is_empty() {
                // 两者都为空
                if finish_reason == "length" {
                    return Err(OpenAiApiError::with_reason_code(
                        "AI 在达到输出上限前没有返回最终答案。请提高 max tokens，或在提示词里明确\"只输出最终答案，不要思考过程\"。",
                        status_code,
                        false,
                        "length_without_content",
                    ));
                }
                return Err(OpenAiApiError::new(
                    "AI 接口返回内容为空",
                    status_code,
                    false,
                ));
            }
            reasoning_content
        } else {
            content
        };

        Ok(ChatCompletionResponse {
            content: final_content,
            model,
            usage: data.usage,
            finish_reason,
        })
    }

    /// 调用 chat/completions 接口（流式）。
    ///
    /// 设置 `stream: true`，解析 SSE delta，对每个 delta 调用 `on_delta(chunk)` 回调，
    /// 返回拼接后的完整文本。
    ///
    /// reasoning_content 兜底：若 content 为空但 reasoning_content 存在，使用 reasoning_content。
    pub async fn chat_completion_stream<F>(
        &self,
        mut req: ChatCompletionRequest,
        mut on_delta: F,
    ) -> Result<String>
    where
        F: FnMut(&str),
    {
        let api_key = Self::get_api_key()?;
        let base_url = Self::get_base_url();
        let url = get_chat_completions_url(&base_url);

        req.stream = Some(true);

        let mut resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&req)
            .send()
            .await
            .map_err(|e| anyhow!("网络请求失败: {}", e))?;

        let status_code = resp.status().as_u16();
        if status_code < 200 || status_code >= 300 {
            let body = resp.text().await.unwrap_or_default();
            let msg = serde_json::from_str::<OpenAiResponse>(&body)
                .ok()
                .and_then(|d| d.error.and_then(|e| e.message))
                .unwrap_or_else(|| format!("请求失败 (HTTP {})", status_code));
            return Err(anyhow!("连接失败 (HTTP {}): {}", status_code, msg));
        }

        // 解析 SSE 流：使用 resp.chunk() 逐块读取
        let mut full_text = String::new();
        let mut buffer = String::new();

        while let Some(chunk_opt) = resp
            .chunk()
            .await
            .map_err(|e| anyhow!("读取流失败: {}", e))?
        {
            buffer.push_str(&String::from_utf8_lossy(&chunk_opt));

            // 按换行处理 SSE 事件
            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].trim().to_string();
                buffer = buffer[pos + 1..].to_string();

                if line.is_empty() {
                    continue;
                }
                // SSE 数据行以 "data:" 开头
                let data = match line.strip_prefix("data:") {
                    Some(s) => s.trim(),
                    None => continue,
                };
                if data == "[DONE]" {
                    continue;
                }
                // 解析 chunk JSON
                let chunk = match serde_json::from_str::<StreamChunk>(data) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                if let Some(choice) = chunk.choices.first() {
                    if let Some(delta) = &choice.delta {
                        // 优先使用 content；若 content 为空则回退到 reasoning_content
                        let text = delta
                            .content
                            .as_deref()
                            .filter(|s| !s.is_empty())
                            .or_else(|| {
                                delta
                                    .reasoning_content
                                    .as_deref()
                                    .filter(|s| !s.is_empty())
                            });
                        if let Some(text) = text {
                            on_delta(text);
                            full_text.push_str(text);
                        }
                    }
                }
            }
        }

        Ok(full_text)
    }

    /// 测试 API 连接（发送一个极简 ping 请求）。
    ///
    /// 返回 true 表示连接成功，false 表示连接失败（API Key 未配置或 HTTP 非 2xx）。
    /// 网络错误等异常通过 Err 返回。
    pub async fn test_connection(&self) -> Result<bool> {
        let api_key = SettingsStore::get_api_key();
        if api_key.is_empty() {
            return Ok(false);
        }
        let base_url = Self::get_base_url();
        let url = get_chat_completions_url(&base_url);
        let model = SettingsStore::get().model_name;
        if model.is_empty() {
            return Ok(false);
        }

        let req = ChatCompletionRequest {
            model,
            messages: vec![Message::new("user", "ping")],
            temperature: Some(0.0),
            max_tokens: Some(5),
            stream: None,
        };

        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&req)
            .send()
            .await
            .map_err(|e| anyhow!("连接失败: {}", e))?;

        Ok(resp.status().is_success())
    }
}

impl Default for OpenAIClient {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试 ChatCompletionRequest 序列化（基础字段 + skip_serializing_if）
    #[test]
    fn test_request_serialization() {
        let req = ChatCompletionRequest {
            model: "gpt-4o-mini".to_string(),
            messages: vec![
                Message::new("system", "你是一个助手"),
                Message::new("user", "你好"),
            ],
            temperature: Some(0.4),
            max_tokens: Some(2048),
            stream: None,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"model\":\"gpt-4o-mini\""));
        assert!(json.contains("\"max_tokens\":2048"));
        assert!(json.contains("\"temperature\":0.4"));
        // None 字段不应序列化
        assert!(!json.contains("\"stream\""));
        // 反序列化验证
        let parsed: ChatCompletionRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.model, "gpt-4o-mini");
        assert_eq!(parsed.messages.len(), 2);
        assert_eq!(parsed.messages[0].role, "system");
        assert_eq!(parsed.messages[1].content, "你好");
    }

    /// 测试 ChatCompletionRequest 序列化（带 stream，None 字段跳过）
    #[test]
    fn test_request_serialization_with_stream() {
        let req = ChatCompletionRequest {
            model: "gpt-4o".to_string(),
            messages: vec![Message::new("user", "hi")],
            temperature: None,
            max_tokens: None,
            stream: Some(true),
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"stream\":true"));
        assert!(!json.contains("\"temperature\""));
        assert!(!json.contains("\"max_tokens\""));
    }

    /// 测试 OpenAiResponse 反序列化（标准响应）
    #[test]
    fn test_response_deserialization() {
        let body = r#"{
            "id": "chatcmpl-123",
            "model": "gpt-4o-mini",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "你好，我是助手"
                    },
                    "finish_reason": "stop"
                }
            ],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 8,
                "total_tokens": 18
            }
        }"#;
        let resp: OpenAiResponse = serde_json::from_str(body).unwrap();
        assert_eq!(resp.choices.len(), 1);
        let choice = &resp.choices[0];
        let msg = choice.message.as_ref().unwrap();
        assert_eq!(
            normalize_assistant_text(msg.content.as_ref().unwrap()),
            "你好，我是助手"
        );
        assert_eq!(choice.finish_reason.as_deref(), Some("stop"));
        let usage = resp.usage.unwrap();
        assert_eq!(usage.prompt_tokens, 10);
        assert_eq!(usage.completion_tokens, 8);
        assert_eq!(usage.total_tokens, 18);
        assert_eq!(resp.model.as_deref(), Some("gpt-4o-mini"));
    }

    /// 测试 reasoning_content 字段反序列化
    #[test]
    fn test_response_with_reasoning_content() {
        let body = r#"{
            "model": "deepseek-r1",
            "choices": [
                {
                    "message": {
                        "content": "",
                        "reasoning_content": "思考过程..."
                    },
                    "finish_reason": "stop"
                }
            ]
        }"#;
        let resp: OpenAiResponse = serde_json::from_str(body).unwrap();
        let msg = resp.choices[0].message.as_ref().unwrap();
        assert_eq!(normalize_assistant_text(msg.content.as_ref().unwrap()), "");
        assert_eq!(
            normalize_assistant_text(msg.reasoning_content.as_ref().unwrap()),
            "思考过程..."
        );
    }

    /// 测试错误响应反序列化
    #[test]
    fn test_error_response_deserialization() {
        let body = r#"{
            "error": {
                "message": "Invalid API key",
                "type": "invalid_request_error",
                "code": "invalid_api_key"
            }
        }"#;
        let resp: OpenAiResponse = serde_json::from_str(body).unwrap();
        assert!(resp.choices.is_empty());
        let err = resp.error.unwrap();
        assert_eq!(err.message.as_deref(), Some("Invalid API key"));
    }

    /// 测试 content 为数组形式的规范化
    #[test]
    fn test_normalize_assistant_text_array() {
        let arr = serde_json::json!(["hello", "world"]);
        assert_eq!(normalize_assistant_text(&arr), "hello\nworld");

        let arr_obj = serde_json::json!([
            {"type": "text", "text": "第一段"},
            {"type": "text", "text": "第二段"}
        ]);
        assert_eq!(normalize_assistant_text(&arr_obj), "第一段\n第二段");

        let null = serde_json::Value::Null;
        assert_eq!(normalize_assistant_text(&null), "");
    }

    /// 测试 URL 拼接逻辑
    #[test]
    fn test_get_chat_completions_url() {
        assert_eq!(
            get_chat_completions_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/chat/completions"
        );
        // 尾部斜杠应被去除
        assert_eq!(
            get_chat_completions_url("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/chat/completions"
        );
        // 完整地址不再追加
        assert_eq!(
            get_chat_completions_url("https://api.openai.com/v1/chat/completions"),
            "https://api.openai.com/v1/chat/completions"
        );
        // 空字符串使用默认值
        assert_eq!(
            get_chat_completions_url(""),
            "https://api.openai.com/v1/chat/completions"
        );
        // 多个尾部斜杠
        assert_eq!(
            get_chat_completions_url("https://api.openai.com/v1///"),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    /// 测试错误分类（状态码 / 可重试 / reason_code）
    #[test]
    fn test_error_classification() {
        // 401 鉴权失败：不可重试
        let err_401 = OpenAiApiError::new("鉴权失败", 401, false);
        assert_eq!(err_401.status_code, 401);
        assert!(!err_401.is_retryable);
        assert!(err_401.reason_code.is_empty());

        // 429 限流：可重试
        let err_429 = OpenAiApiError::new("限流", 429, true);
        assert_eq!(err_429.status_code, 429);
        assert!(err_429.is_retryable);

        // 5xx 服务端错误：可重试
        let err_500 = OpenAiApiError::new("服务端错误", 500, true);
        assert_eq!(err_500.status_code, 500);
        assert!(err_500.is_retryable);

        let err_503 = OpenAiApiError::new("服务不可用", 503, true);
        assert_eq!(err_503.status_code, 503);
        assert!(err_503.is_retryable);

        // 网络错误：状态码 0，可重试
        let err_net = OpenAiApiError::new("网络请求失败", 0, true);
        assert_eq!(err_net.status_code, 0);
        assert!(err_net.is_retryable);

        // 带 reason_code 的错误
        let err_reasoning = OpenAiApiError::with_reason_code(
            "仅返回 reasoning_content",
            200,
            false,
            "reasoning_only",
        );
        assert_eq!(err_reasoning.reason_code, "reasoning_only");
        assert!(!err_reasoning.is_retryable);

        let err_length = OpenAiApiError::with_reason_code(
            "达到输出上限",
            200,
            false,
            "length_without_content",
        );
        assert_eq!(err_length.reason_code, "length_without_content");
    }

    /// 测试 OpenAiApiError 的 Display 实现
    #[test]
    fn test_error_display() {
        let err = OpenAiApiError::with_reason_code("测试错误", 429, true, "rate_limit");
        let s = format!("{}", err);
        assert!(s.contains("status=429"));
        assert!(s.contains("retryable=true"));
        assert!(s.contains("reason=rate_limit"));
        assert!(s.contains("msg=测试错误"));
    }

    /// 测试流式 chunk 反序列化
    #[test]
    fn test_stream_chunk_deserialization() {
        let body = r#"{
            "id": "chatcmpl-123",
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "content": "你好"
                    },
                    "finish_reason": null
                }
            ]
        }"#;
        let chunk: StreamChunk = serde_json::from_str(body).unwrap();
        let delta = chunk.choices[0].delta.as_ref().unwrap();
        assert_eq!(delta.content.as_deref(), Some("你好"));
        assert!(delta.reasoning_content.is_none());

        // reasoning_content delta
        let body2 = r#"{
            "choices": [
                {
                    "delta": {
                        "reasoning_content": "思考中..."
                    }
                }
            ]
        }"#;
        let chunk2: StreamChunk = serde_json::from_str(body2).unwrap();
        let delta2 = chunk2.choices[0].delta.as_ref().unwrap();
        assert!(delta2.content.is_none());
        assert_eq!(delta2.reasoning_content.as_deref(), Some("思考中..."));
    }
}
