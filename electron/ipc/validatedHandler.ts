/**
 * validatedHandler：IPC 入参校验高阶函数
 *
 * 包装 ipcMain.handle，自动用 Zod schema 校验入参：
 *  - 校验失败返回 { ok: false, error: 'VALIDATION_ERROR', details }
 *  - handler 抛错时 catch 返回 { ok: false, error: 'INTERNAL_ERROR', message }
 *  - handler 正常返回包装为 { ok: true, data }
 *
 * unwrapResult：供 preload 端解包，ok=false 时抛 Error 给 renderer。
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'

/** IPC 统一返回信封 */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: 'VALIDATION_ERROR'; details: z.ZodIssue[] }
  | { ok: false; error: 'INTERNAL_ERROR'; message: string }

/**
 * 注册一个带入参校验的 ipcMain.handle。
 *
 * @param channel IPC 通道名
 * @param schema 入参 Zod schema（无参通道用 z.undefined()）
 * @param handler 业务处理器，接收 (event, validatedPayload)，返回业务数据
 */
export function validatedHandler<S extends z.ZodType>(
  channel: string,
  schema: S,
  handler: (event: IpcMainInvokeEvent, payload: z.infer<S>) => unknown | Promise<unknown>
): void {
  ipcMain.handle(channel, async (event, payload) => {
    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      const result: IpcResult<never> = {
        ok: false,
        error: 'VALIDATION_ERROR',
        details: parsed.error.issues
      }
      return result
    }
    try {
      const data = await handler(event, parsed.data)
      const result: IpcResult<unknown> = { ok: true, data }
      return result
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const result: IpcResult<never> = { ok: false, error: 'INTERNAL_ERROR', message }
      return result
    }
  })
}

/**
 * 解包 IPC 返回信封。ok=false 时抛 Error，renderer 用 try-catch 处理。
 * 供 preload 端使用。
 */
export function unwrapResult<T>(result: IpcResult<T>): T {
  if (!result.ok) {
    if (result.error === 'VALIDATION_ERROR') {
      const detailText = result.details
        .map((d) => `${d.path.join('.')}: ${d.message}`)
        .join('; ')
      throw new Error(`参数校验失败: ${detailText}`)
    }
    throw new Error(result.message)
  }
  return result.data
}
