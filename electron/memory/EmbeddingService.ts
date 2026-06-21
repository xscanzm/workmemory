/**
 * EmbeddingService：本地语义向量服务
 *
 * 为 MemCell 提供语义向量化能力，支持语义检索（如"前端组件开发"查询能匹配到
 * "UI 组件库实现"的 MemCell）。
 *
 * 后端策略：
 *  1. ONNX 模型（multilingual-e5-small）：当 resources/embedding/model.onnx 与
 *     vocab.txt 同时存在且 onnxruntime-node 可用时，使用 ONNX 推理生成 384 维语义向量。
 *  2. TF-IDF 哈希降级方案：当 ONNX 模型不可用时（模型文件缺失或 onnxruntime-node 未安装），
 *     使用基于 TF-IDF + 带符号哈希（sign hashing trick）的 384 维向量。
 *     虽然不如真实模型，但 cosineSimilarity 仍能反映文本相似度，功能可用。
 *
 * 降级方案说明（未来可替换为 ONNX 模型）：
 *  - 维度：384 维（与 multilingual-e5-small 一致）
 *  - 分词：中文按字符 + 英文按单词（小写化）
 *  - 哈希：对每个 token 用 FNV-1a 哈希映射到 384 维的某个位置
 *  - 权重：TF（词频），使用带符号哈希（第二个哈希位决定正负）提升正交性
 *  - 归一化：L2 归一化
 */
import fs from 'node:fs'
import path from 'node:path'

/** 向量维度（与 multilingual-e5-small 一致） */
const EMBEDDING_DIM = 384

/** ONNX 模型版本标识 */
const ONNX_MODEL_VERSION = 'onnx-multilingual-e5-small'

/** TF-IDF 降级方案版本标识 */
const TFIDF_MODEL_VERSION = 'tfidf-hash-384'

/** 嵌入后端类型 */
export type EmbeddingBackend = 'onnx' | 'tfidf'

/** EmbeddingService 配置选项 */
export interface EmbeddingServiceOptions {
  /** 模型目录路径（包含 model.onnx 和 vocab.txt） */
  modelDir?: string
  /** ONNX 模型文件名 */
  modelFileName?: string
}

/** ONNX 推理会话接口（与 onnxruntime-node 的 InferenceSession 兼容） */
interface OnnxSession {
  run(inputs: Record<string, unknown>): Promise<
    Record<string, { data: Float32Array; dims: number[] }>
  >
}

/** ONNX 运行时模块接口 */
interface OnnxRuntimeModule {
  Tensor: new (type: string, data: unknown, dims: number[]) => unknown
  InferenceSession: { create(modelPath: string): Promise<OnnxSession> }
}

/**
 * EmbeddingService：本地语义向量服务
 *
 * 单例导出 `embeddingService`，提供 embed / embedBatch / cosineSimilarity 方法。
 */
export class EmbeddingService {
  private backend: EmbeddingBackend | null = null
  private modelVersion = ''
  private session: OnnxSession | null = null
  private vocab: Map<string, number> | null = null
  private readonly modelDir: string
  private readonly modelFileName: string
  private initPromise: Promise<void> | null = null

  constructor(options: EmbeddingServiceOptions = {}) {
    this.modelDir = options.modelDir ?? resolveDefaultModelDir()
    this.modelFileName = options.modelFileName ?? 'model.onnx'
  }

  /** 获取当前后端类型 */
  getBackend(): EmbeddingBackend {
    return this.backend ?? 'tfidf'
  }

  /** 获取当前模型版本标识 */
  getModelVersion(): string {
    return this.modelVersion || TFIDF_MODEL_VERSION
  }

  /** 获取向量维度 */
  getDimension(): number {
    return EMBEDDING_DIM
  }

  /** 确保服务已初始化（加载模型或降级方案） */
  async ensureInitialized(): Promise<void> {
    if (this.backend !== null) return
    if (this.initPromise !== null) {
      await this.initPromise
      return
    }
    this.initPromise = this.initialize()
    await this.initPromise
  }

  /**
   * 生成文本的语义向量
   * @param text 输入文本
   * @returns 384 维 L2 归一化的 Float32Array
   */
  async embed(text: string): Promise<Float32Array> {
    await this.ensureInitialized()
    if (this.backend === 'onnx' && this.session !== null) {
      return this.embedWithOnnx(text)
    }
    return this.embedWithTfidf(text)
  }

  /**
   * 批量生成语义向量
   * @param texts 输入文本数组
   * @returns 384 维 Float32Array 数组
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    await this.ensureInitialized()
    if (this.backend === 'onnx' && this.session !== null) {
      const results: Float32Array[] = []
      for (const text of texts) {
        results.push(await this.embedWithOnnx(text))
      }
      return results
    }
    return texts.map((text) => this.embedWithTfidf(text))
  }

  /**
   * 计算两个向量的余弦相似度
   * @param a 向量 A
   * @param b 向量 B
   * @returns 余弦相似度 [-1, 1]；零向量返回 0
   */
  static cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`)
    }
    let dot = 0
    let normA = 0
    let normB = 0
    for (let i = 0; i < a.length; i++) {
      const va = a[i]
      const vb = b[i]
      dot += va * vb
      normA += va * va
      normB += vb * vb
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB)
    if (denom === 0) return 0
    return dot / denom
  }

  // ===================== 内部方法 =====================

  private getModelFilePath(): string {
    return path.join(this.modelDir, this.modelFileName)
  }

  private getVocabFilePath(): string {
    return path.join(this.modelDir, 'vocab.txt')
  }

  private async initialize(): Promise<void> {
    const modelFile = this.getModelFilePath()
    const vocabFile = this.getVocabFilePath()

    // 检查 ONNX 模型和词表文件是否存在
    if (!fs.existsSync(modelFile) || !fs.existsSync(vocabFile)) {
      this.activateFallback()
      return
    }

    try {
      const ort = await loadOnnxRuntime()
      if (ort === null) {
        this.activateFallback()
        return
      }
      this.session = await ort.InferenceSession.create(modelFile)
      this.vocab = this.loadVocab(vocabFile)
      this.backend = 'onnx'
      this.modelVersion = ONNX_MODEL_VERSION
    } catch {
      this.activateFallback()
    }
  }

  private activateFallback(): void {
    this.backend = 'tfidf'
    this.modelVersion = TFIDF_MODEL_VERSION
    this.session = null
    this.vocab = null
  }

  private loadVocab(vocabPath: string): Map<string, number> {
    const content = fs.readFileSync(vocabPath, 'utf-8')
    const vocab = new Map<string, number>()
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const token = lines[i].trimEnd()
      if (token) vocab.set(token, i)
    }
    return vocab
  }

  private async embedWithOnnx(text: string): Promise<Float32Array> {
    if (this.session === null || this.vocab === null) {
      throw new Error('ONNX session not initialized')
    }

    // E5 模型要求 "query: " 或 "passage: " 前缀
    const inputText = `query: ${text}`
    const { inputIds, attentionMask } = this.tokenizeForBert(inputText)

    const ort = await loadOnnxRuntime()
    if (ort === null) {
      // 运行时降级：onnxruntime-node 不可用
      return this.embedWithTfidf(text)
    }

    const inputIdsTensor = new ort.Tensor(
      'int64',
      BigInt64Array.from(inputIds.map((id) => BigInt(id))),
      [1, inputIds.length]
    )
    const attentionMaskTensor = new ort.Tensor(
      'int64',
      BigInt64Array.from(attentionMask.map((m) => BigInt(m))),
      [1, attentionMask.length]
    )

    const outputs = await this.session.run({
      input_ids: inputIdsTensor,
      attention_mask: attentionMaskTensor
    })

    // 获取 last_hidden_state: [1, seq_len, hidden_size]
    const outputKey = 'last_hidden_state' in outputs
      ? 'last_hidden_state'
      : Object.keys(outputs)[0]
    const lastHiddenState = outputs[outputKey]
    const dims = lastHiddenState.dims
    const hiddenSize = dims[2]
    const tokenEmbeddings = lastHiddenState.data as Float32Array

    // Mean pooling with attention mask
    const pooled = meanPool(tokenEmbeddings, attentionMask, hiddenSize)

    // L2 normalize
    return l2Normalize(pooled)
  }

  /** BERT WordPiece 分词（需要 vocab.txt） */
  private tokenizeForBert(text: string): { inputIds: number[]; attentionMask: number[] } {
    if (this.vocab === null) {
      throw new Error('Vocabulary not loaded')
    }

    const tokens: string[] = ['[CLS]']
    const words = text.toLowerCase().match(/[a-z]+|\d+|[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []

    for (const word of words) {
      if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(word)) {
        // CJK 字符：单字作为 token
        if (this.vocab.has(word)) {
          tokens.push(word)
        } else {
          tokens.push('[UNK]')
        }
      } else {
        // 拉丁文/数字：WordPiece 贪婪最长匹配
        let remaining = word
        let isFirst = true
        while (remaining.length > 0) {
          let matched = false
          for (let i = remaining.length; i > 0; i--) {
            const candidate = (isFirst ? '' : '##') + remaining.slice(0, i)
            if (this.vocab.has(candidate)) {
              tokens.push(candidate)
              remaining = remaining.slice(i)
              matched = true
              break
            }
          }
          if (!matched) {
            tokens.push('[UNK]')
            break
          }
          isFirst = false
        }
      }
    }
    tokens.push('[SEP]')

    const unkId = this.vocab.get('[UNK]') ?? 0
    const inputIds = tokens.map((t) => this.vocab!.get(t) ?? unkId)
    const attentionMask = inputIds.map(() => 1)

    return { inputIds, attentionMask }
  }

  /** TF-IDF 哈希降级方案：生成 384 维 L2 归一化向量 */
  private embedWithTfidf(text: string): Float32Array {
    const tokens = tokenize(text)
    const vec = new Float32Array(EMBEDDING_DIM)

    // 统计词频（TF）
    const tfMap = new Map<string, number>()
    for (const token of tokens) {
      tfMap.set(token, (tfMap.get(token) ?? 0) + 1)
    }

    // 带符号哈希（sign hashing trick）：提升向量正交性，使 cosineSimilarity 更准确
    // 每个 token 的贡献权重为 TF，方向由哈希高位决定（+1 或 -1）
    for (const [token, tf] of tfMap) {
      const h = fnv1aHash(token)
      const position = h % EMBEDDING_DIM
      const sign = ((h >>> 31) & 1) === 0 ? 1 : -1
      vec[position] += sign * tf
    }

    return l2Normalize(vec)
  }
}

// ===================== 工具函数 =====================

/** 解析默认模型目录路径 */
function resolveDefaultModelDir(): string {
  // 在打包后的 Electron 应用中，process.resourcesPath 指向 resources 目录
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    const packagedPath = path.join(resourcesPath, 'resources', 'embedding')
    if (fs.existsSync(packagedPath)) return packagedPath
  }
  // 开发环境与测试环境：使用项目根目录下的 resources/embedding
  return path.join(process.cwd(), 'resources', 'embedding')
}

/** 动态加载 onnxruntime-node（可能未安装，失败时返回 null） */
async function loadOnnxRuntime(): Promise<OnnxRuntimeModule | null> {
  try {
    // 使用变量名避免 TypeScript 静态模块解析（onnxruntime-node 可能未安装）
    const moduleName = 'onnxruntime-node'
    const mod = await import(moduleName)
    return mod as OnnxRuntimeModule
  } catch {
    return null
  }
}

/** 分词：中文按字符 + 英文按单词（小写化） */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const regex = /[a-z]+|\d+|[\u4e00-\u9fff\u3400-\u4dbf]/g
  const tokens: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(lower)) !== null) {
    tokens.push(match[0])
  }
  return tokens
}

/** FNV-1a 哈希（32 位无符号） */
function fnv1aHash(s: string): number {
  let hash = 2166136261
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** L2 归一化 */
function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i]
  }
  norm = Math.sqrt(norm)
  if (norm === 0) return vec
  const result = new Float32Array(vec.length)
  for (let i = 0; i < vec.length; i++) {
    result[i] = vec[i] / norm
  }
  return result
}

/** Mean pooling with attention mask（ONNX 推理后处理） */
function meanPool(
  tokenEmbeddings: Float32Array,
  attentionMask: number[],
  hiddenSize: number
): Float32Array {
  const seqLen = attentionMask.length
  const pooled = new Float32Array(hiddenSize)
  let maskSum = 0
  for (let t = 0; t < seqLen; t++) {
    if (attentionMask[t] === 0) continue
    maskSum++
    const offset = t * hiddenSize
    for (let h = 0; h < hiddenSize; h++) {
      pooled[h] += tokenEmbeddings[offset + h]
    }
  }
  if (maskSum > 0) {
    for (let h = 0; h < hiddenSize; h++) {
      pooled[h] /= maskSum
    }
  }
  return pooled
}

// ===================== 单例 =====================

let embeddingServiceInstance: EmbeddingService | null = null

/** 获取 EmbeddingService 单例 */
export function getEmbeddingService(): EmbeddingService {
  if (embeddingServiceInstance === null) {
    embeddingServiceInstance = new EmbeddingService()
  }
  return embeddingServiceInstance
}

/** 重置单例（仅供测试） */
export function resetEmbeddingService(): void {
  embeddingServiceInstance = null
}

/** EmbeddingService 单例实例 */
export const embeddingService = new EmbeddingService()
