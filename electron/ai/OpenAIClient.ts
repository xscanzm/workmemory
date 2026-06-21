/**
 * OpenAIClient：OpenAI-compatible API 客户端
 *
 * 使用 Node 原生 https/http 模块实现（不依赖 openai SDK，减少依赖）。
 * 支持 OpenAI、Azure OpenAI、本地 Ollama 等兼容接口。
 *
 * 特性：
 *  - chatCompletion 非流式调用
 *  - 错误处理：网络错误、401 鉴权失败、429 限流、5xx 服务端错误
 *  - 自动重试：429 和 5xx 重试 2 次，指数退避（1s, 2s）
 *  - 超时：30 秒
 */
import https from 'node:https'
import http from 'node:http'
import { URL } from 'node:url'

/** 聊天消息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** chatCompletion 请求参数 */
export interface ChatCompletionParams {
  /** 基础 URL，如 https://api.openai.com/v1 */
  baseUrl: string
  /** API Key */
  apiKey: string
  /** 模型名 */
  model: string
  /** 消息列表 */
  messages: ChatMessage[]
  /** 温度（0-2），默认 0.4 */
  temperature?: number
  /** 最大 token 数 */
  maxTokens?: number
  /** 响应格式：json_object 或 text */
  responseFormat?: { type: 'json_object' | 'text' }
  /** JSON Schema 结构化输出（优先级高于 responseFormat） */
  jsonSchema?: { name: string; schema: object }
}

/** token 用量 */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** chatCompletion 响应 */
export interface ChatCompletionResult {
  content: string
  usage: TokenUsage
  finishReason: string
}

/** 请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 30_000
/** 最大重试次数（429 和 5xx） */
const MAX_RETRIES = 2
/** 重试基础延迟（毫秒），指数退避：1s, 2s */
const RETRY_BASE_DELAY_MS = 1_000

function getChatCompletionsUrl(rawBaseUrl: string): string {
  const trimmed = (rawBaseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '')
  const parsed = new URL(trimmed)
  const pathname = parsed.pathname.replace(/\/+$/, '')
  if (pathname.endsWith('/chat/completions')) {
    return parsed.toString().replace(/\/+$/, '')
  }
  return `${trimmed}/chat/completions`
}

function summarizeNonJsonBody(statusCode: number, body: string): string {
  const compact = body.replace(/\s+/g, ' ').trim()
  const preview = compact.slice(0, 200)
  if (/^<!doctype html/i.test(compact) || /^<html/i.test(compact)) {
    return `接口返回 HTML 而不是 JSON (HTTP ${statusCode})，通常是 API URL 不正确或填成了网页地址。请填写 OpenAI-compatible Base URL，例如 https://api.example.com/v1；也支持完整 /chat/completions 地址。响应预览: ${preview}`
  }
  return `响应体 JSON 解析失败 (HTTP ${statusCode}): ${preview}`
}

/** 自定义错误类，携带 HTTP 状态码 */
export class OpenAiApiError extends Error {
  readonly statusCode: number
  readonly isRetryable: boolean

  constructor(message: string, statusCode: number, isRetryable: boolean) {
    super(message)
    this.name = 'OpenAiApiError'
    this.statusCode = statusCode
    this.isRetryable = isRetryable
  }
}

/** 睡眠工具函数 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 发送 HTTP/HTTPS 请求并返回响应体字符串。
 * 使用原生 http/https 模块，支持 30 秒超时。
 */
function httpRequest(
  url: string,
  options: { method: string; headers: Record<string, string> },
  body: string
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const isHttps = parsedUrl.protocol === 'https:'
    const transport = isHttps ? https : http

    const reqOptions: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method,
      headers: options.headers
    }

    const req = transport.request(reqOptions, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf-8')
        resolve({ statusCode: res.statusCode ?? 0, body: responseBody })
      })
      res.on('error', reject)
    })

    // 超时处理
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000}秒）`))
    })

    req.on('error', reject)

    req.write(body)
    req.end()
  })
}

/** OpenAI API 响应结构（仅取需要的字段） */
interface OpenAiResponse {
  choices?: Array<{
    message?: { role?: string; content?: string }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
  error?: { message?: string; type?: string; code?: string }
}

function createChatCompletionRequest(params: ChatCompletionParams): {
  url: string
  body: string
  headers: Record<string, string>
} {
  const requestBody: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    temperature: params.temperature ?? 0.4,
    max_tokens: params.maxTokens ?? 2048
  }

  if (params.jsonSchema) {
    requestBody.response_format = {
      type: 'json_schema',
      json_schema: {
        name: params.jsonSchema.name,
        schema: params.jsonSchema.schema,
        strict: true
      }
    }
  } else if (params.responseFormat) {
    requestBody.response_format = { type: params.responseFormat.type }
  }

  return {
    url: getChatCompletionsUrl(params.baseUrl),
    body: JSON.stringify(requestBody),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.apiKey}`
    }
  }
}

/**
 * 执行单次 chatCompletion 请求（不含重试）。
 * @throws OpenAiApiError 当返回 401/429/5xx 等错误状态码时
 */
async function doChatCompletionOnce(
  params: ChatCompletionParams,
  options?: { allowEmptyContent?: boolean }
): Promise<ChatCompletionResult> {
  const request = createChatCompletionRequest(params)

  let resp: { statusCode: number; body: string }
  try {
    resp = await httpRequest(request.url, { method: 'POST', headers: request.headers }, request.body)
  } catch (e) {
    // 网络错误（DNS、连接拒绝、超时等）
    throw new OpenAiApiError(
      `网络请求失败: ${e instanceof Error ? e.message : String(e)}`,
      0,
      true
    )
  }

  const { statusCode, body } = resp

  // 解析响应体
  let data: OpenAiResponse
  try {
    data = JSON.parse(body) as OpenAiResponse
  } catch {
    throw new OpenAiApiError(
      summarizeNonJsonBody(statusCode, body),
      statusCode,
      false
    )
  }

  // 错误状态码处理
  if (statusCode === 401) {
    const msg = data.error?.message ?? 'API Key 鉴权失败，请检查设置中的 API Key'
    throw new OpenAiApiError(msg, 401, false)
  }
  if (statusCode === 429) {
    const msg = data.error?.message ?? '请求被限流（429），请稍后重试'
    throw new OpenAiApiError(msg, 429, true)
  }
  if (statusCode >= 500) {
    const msg = data.error?.message ?? `服务端错误 (HTTP ${statusCode})`
    throw new OpenAiApiError(msg, statusCode, true)
  }
  if (statusCode < 200 || statusCode >= 300) {
    const msg = data.error?.message ?? `请求失败 (HTTP ${statusCode})`
    throw new OpenAiApiError(msg, statusCode, false)
  }

  // 提取内容
  const choice = data.choices?.[0]
  const content = choice?.message?.content
  if (!content && !options?.allowEmptyContent) {
    throw new OpenAiApiError('AI 接口返回内容为空', statusCode, false)
  }

  const usage: TokenUsage = {
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    totalTokens: data.usage?.total_tokens ?? 0
  }

  return {
    content: (content ?? '').trim(),
    usage,
    finishReason: choice?.finish_reason ?? 'unknown'
  }
}

/**
 * OpenAI-compatible 客户端
 */
export const OpenAIClient = {
  /**
   * 调用 chat/completions 接口（非流式）。
   *
   * 自动重试：429 和 5xx 错误重试 2 次，指数退避（1s, 2s）。
   * 超时：30 秒。
   *
   * @throws OpenAiApiError 当请求失败且不可重试，或重试耗尽时
   * @throws Error 当 API Key 为空时
   */
  async chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    if (!params.apiKey) {
      throw new Error('未配置 AI API Key，请在设置中配置')
    }
    if (!params.baseUrl) {
      throw new Error('未配置 API Base URL，请在设置中配置')
    }
    if (!params.model) {
      throw new Error('未配置模型名称，请在设置中配置')
    }

    let lastError: Error | null = null
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await doChatCompletionOnce(params)
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e))
        if (e instanceof OpenAiApiError && e.isRetryable && attempt < MAX_RETRIES) {
          // 指数退避：1s, 2s
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
          await sleep(delay)
          continue
        }
        // 不可重试或重试耗尽，抛出
        throw e
      }
    }
    // 理论上不会到达
    throw lastError ?? new Error('chatCompletion 未知失败')
  },

  /**
   * 测试 API 连接（发送一个极简 ping 请求）。
   * 不抛异常，返回 { ok, message }。
   */
  async testConnection(params: {
    baseUrl: string
    apiKey: string
    model: string
  }): Promise<{ ok: boolean; message: string }> {
    if (!params.apiKey) {
      return { ok: false, message: '未配置 API Key' }
    }
    if (!params.baseUrl) {
      return { ok: false, message: '未配置 API Base URL' }
    }
    if (!params.model) {
      return { ok: false, message: '未配置模型名称' }
    }
    try {
      const request = createChatCompletionRequest({
        baseUrl: params.baseUrl,
        apiKey: params.apiKey,
        model: params.model,
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0,
        maxTokens: 5
      })
      const response = await httpRequest(
        request.url,
        { method: 'POST', headers: request.headers },
        request.body
      )
      if (response.statusCode < 200 || response.statusCode >= 300) {
        try {
          const data = JSON.parse(response.body) as OpenAiResponse
          const msg = data.error?.message ?? `请求失败 (HTTP ${response.statusCode})`
          return { ok: false, message: `连接失败 (HTTP ${response.statusCode}): ${msg}` }
        } catch {
          return {
            ok: false,
            message: `连接失败 (HTTP ${response.statusCode}): ${summarizeNonJsonBody(response.statusCode, response.body)}`
          }
        }
      }

      let content = ''
      let totalTokens = 0
      try {
        const data = JSON.parse(response.body) as OpenAiResponse
        content = (data.choices?.[0]?.message?.content ?? '').trim()
        totalTokens = data.usage?.total_tokens ?? 0
      } catch {
        return {
          ok: true,
          message: `连接成功，接口已返回 HTTP ${response.statusCode}；但响应不是标准 JSON，生成日报时还需要验证兼容性。`
        }
      }
      return {
        ok: true,
        message: content
          ? `连接成功，模型 ${params.model} 可用（消耗 ${totalTokens} tokens）`
          : `连接成功，接口已返回 HTTP ${response.statusCode}；但该兼容接口未返回文本内容，请在生成报告时再验证模型输出。`
      }
    } catch (e) {
      if (e instanceof OpenAiApiError) {
        return { ok: false, message: `连接失败 (HTTP ${e.statusCode}): ${e.message}` }
      }
      return { ok: false, message: `连接失败: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
}
