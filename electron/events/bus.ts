/**
 * 共享事件总线
 *
 * 基于 Node.js EventEmitter 的进程内事件中心，用于解耦生产者与消费者。
 *
 * 当前事件：
 *  - 'memcell-created'(memCell: MemCell)：DistillManager 写入 MemCell 后发射，
 *    MemCellIndexer 监听该事件异步生成 embedding 并存储到 embeddings 表。
 *
 * 设计说明：
 *  - DistillManager 不直接持有 MemCellIndexer 引用，避免循环依赖与初始化顺序问题。
 *  - 失败不阻塞：事件发射是同步的，但监听器内部异步处理 embedding 生成，
 *    任何异常都被监听器自身捕获，不会影响 DistillManager 主流程。
 */
import { EventEmitter } from 'node:events'
import type { MemCell } from '../memory/MemCell'

/** 事件总线事件名常量 */
export const MEMCELL_CREATED_EVENT = 'memcell-created' as const

/** 事件总线事件签名映射 */
export interface MemCellEventBusEvents {
  [MEMCELL_CREATED_EVENT]: (memCell: MemCell) => void
}

/**
 * 共享事件总线单例。
 *
 * 使用方式：
 *  - 生产者：`memCellEventBus.emit(MEMCELL_CREATED_EVENT, memCell)`
 *  - 消费者：`memCellEventBus.on(MEMCELL_CREATED_EVENT, (memCell) => { ... })`
 */
export const memCellEventBus = new EventEmitter()

// 生产环境下不限制监听器数量（默认 10 会触发 MaxListenersExceededWarning）
memCellEventBus.setMaxListeners(20)
