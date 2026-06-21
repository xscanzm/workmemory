/**
 * EmbeddingService 单元测试
 *
 * 测试内容：
 *  - embed 返回 384 维 Float32Array
 *  - embedBatch 批量返回向量
 *  - cosineSimilarity 正确性
 *  - TF-IDF 降级方案工作（相似文本相似度高于不相似文本）
 *  - L2 归一化（向量范数为 1）
 *
 * 运行方式：npx vitest run electron/memory/__tests__/EmbeddingService.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { EmbeddingService } from '../EmbeddingService'

describe('EmbeddingService', () => {
  let service: EmbeddingService

  beforeEach(() => {
    // 使用默认模型路径（resources/embedding/ 不存在 model.onnx → TF-IDF 降级方案）
    service = new EmbeddingService()
  })

  // ===================== embed =====================

  describe('embed', () => {
    it('返回 384 维 Float32Array', async () => {
      const vec = await service.embed('前端组件开发')
      expect(vec).toBeInstanceOf(Float32Array)
      expect(vec.length).toBe(384)
    })

    it('空文本返回 384 维零向量（L2 归一化后仍为零）', async () => {
      const vec = await service.embed('')
      expect(vec).toBeInstanceOf(Float32Array)
      expect(vec.length).toBe(384)
      // 空文本无 token，L2 归一化保持零向量
      let sum = 0
      for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i]
      expect(sum).toBe(0)
    })

    it('相同文本生成相同向量（确定性）', async () => {
      const a = await service.embed('前端组件开发')
      const b = await service.embed('前端组件开发')
      for (let i = 0; i < a.length; i++) {
        expect(a[i]).toBe(b[i])
      }
    })

    it('返回 L2 归一化向量（范数为 1）', async () => {
      const vec = await service.embed('前端组件开发')
      let norm = 0
      for (let i = 0; i < vec.length; i++) {
        norm += vec[i] * vec[i]
      }
      expect(Math.sqrt(norm)).toBeCloseTo(1, 5)
    })

    it('支持中英文混合文本', async () => {
      const vec = await service.embed('使用 React 实现 frontend 组件库')
      expect(vec).toBeInstanceOf(Float32Array)
      expect(vec.length).toBe(384)
      let norm = 0
      for (let i = 0; i < vec.length; i++) {
        norm += vec[i] * vec[i]
      }
      expect(Math.sqrt(norm)).toBeCloseTo(1, 5)
    })
  })

  // ===================== embedBatch =====================

  describe('embedBatch', () => {
    it('批量返回向量数组', async () => {
      const vecs = await service.embedBatch(['前端组件开发', 'UI 组件库实现', '数据库优化'])
      expect(vecs).toHaveLength(3)
      for (const vec of vecs) {
        expect(vec).toBeInstanceOf(Float32Array)
        expect(vec.length).toBe(384)
      }
    })

    it('空数组返回空数组', async () => {
      const vecs = await service.embedBatch([])
      expect(vecs).toEqual([])
    })

    it('批量结果与单独 embed 一致', async () => {
      const texts = ['前端组件开发', 'UI 组件库实现']
      const batch = await service.embedBatch(texts)
      const single1 = await service.embed(texts[0])
      const single2 = await service.embed(texts[1])
      for (let i = 0; i < 384; i++) {
        expect(batch[0][i]).toBe(single1[i])
        expect(batch[1][i]).toBe(single2[i])
      }
    })
  })

  // ===================== cosineSimilarity =====================

  describe('cosineSimilarity', () => {
    it('相同向量相似度为 1', async () => {
      const a = await service.embed('前端组件开发')
      const sim = EmbeddingService.cosineSimilarity(a, a)
      expect(sim).toBeCloseTo(1, 5)
    })

    it('正交向量相似度为 0', () => {
      const a = new Float32Array([1, 0, 0, 0])
      const b = new Float32Array([0, 1, 0, 0])
      const sim = EmbeddingService.cosineSimilarity(a, b)
      expect(sim).toBeCloseTo(0, 5)
    })

    it('反向向量相似度为 -1', () => {
      const a = new Float32Array([1, 0, 0, 0])
      const b = new Float32Array([-1, 0, 0, 0])
      const sim = EmbeddingService.cosineSimilarity(a, b)
      expect(sim).toBeCloseTo(-1, 5)
    })

    it('维度不匹配抛错', () => {
      const a = new Float32Array(384)
      const b = new Float32Array(768)
      expect(() => EmbeddingService.cosineSimilarity(a, b)).toThrow(/Dimension mismatch/)
    })

    it('零向量返回 0', () => {
      const a = new Float32Array(384)
      const b = new Float32Array(384)
      const sim = EmbeddingService.cosineSimilarity(a, b)
      expect(sim).toBe(0)
    })

    it('已知向量对计算正确', () => {
      const a = new Float32Array([1, 2, 3])
      const b = new Float32Array([4, 5, 6])
      // dot = 4 + 10 + 18 = 32
      // |a| = sqrt(1+4+9) = sqrt(14)
      // |b| = sqrt(16+25+36) = sqrt(77)
      // cos = 32 / (sqrt(14) * sqrt(77))
      const expected = 32 / (Math.sqrt(14) * Math.sqrt(77))
      const sim = EmbeddingService.cosineSimilarity(a, b)
      expect(sim).toBeCloseTo(expected, 5)
    })
  })

  // ===================== 降级方案（TF-IDF 哈希） =====================

  describe('TF-IDF 降级方案', () => {
    it('后端为 tfidf（无模型文件时降级）', async () => {
      await service.ensureInitialized()
      expect(service.getBackend()).toBe('tfidf')
      expect(service.getModelVersion()).toBe('tfidf-hash-384')
    })

    it('维度为 384', () => {
      expect(service.getDimension()).toBe(384)
    })

    it('相似文本相似度高于不相似文本', async () => {
      const query = await service.embed('前端组件开发')
      const similar = await service.embed('UI 组件库实现')
      const dissimilar = await service.embed('数据库性能优化')

      const simSimilar = EmbeddingService.cosineSimilarity(query, similar)
      const simDissimilar = EmbeddingService.cosineSimilarity(query, dissimilar)

      // "前端组件开发" 与 "UI 组件库实现" 共享 "组件" 二字，相似度应更高
      expect(simSimilar).toBeGreaterThan(simDissimilar)
    })

    it('完全相同的文本相似度为 1', async () => {
      const a = await service.embed('前端组件开发')
      const b = await service.embed('前端组件开发')
      const sim = EmbeddingService.cosineSimilarity(a, b)
      expect(sim).toBeCloseTo(1, 5)
    })

    it('无共享 token 的文本相似度较低', async () => {
      const a = await service.embed('前端组件开发')
      const b = await service.embed('数据库性能优化')
      const sim = EmbeddingService.cosineSimilarity(a, b)
      // 无共享 token 时，相似度由哈希碰撞决定，应较低
      expect(sim).toBeLessThan(0.5)
    })

    it('包含子串的文本相似度较高', async () => {
      const query = await service.embed('前端组件')
      const doc = await service.embed('前端组件开发')
      const unrelated = await service.embed('数据库优化')

      const simDoc = EmbeddingService.cosineSimilarity(query, doc)
      const simUnrelated = EmbeddingService.cosineSimilarity(query, unrelated)

      expect(simDoc).toBeGreaterThan(simUnrelated)
    })
  })

  // ===================== 自定义模型目录 =====================

  describe('自定义模型目录', () => {
    it('指定不存在的模型目录时降级到 TF-IDF', async () => {
      const customService = new EmbeddingService({
        modelDir: '/nonexistent/path/embedding'
      })
      await customService.ensureInitialized()
      expect(customService.getBackend()).toBe('tfidf')
      expect(customService.getModelVersion()).toBe('tfidf-hash-384')

      const vec = await customService.embed('测试文本')
      expect(vec.length).toBe(384)
    })
  })
})
