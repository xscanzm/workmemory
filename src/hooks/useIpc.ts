/**
 * IPC 调用 Hook 封装
 * - useIpcInvoke：一次性查询（带 loading/error/refresh）
 * - useIpcMutation：变更操作（带 loading/error）
 * - useIpcSubscribe：订阅事件
 */
import { useCallback, useEffect, useRef, useState } from 'react'

type Unsubscribe = () => void

interface InvokeResult<T> {
  data: T | null
  loading: boolean
  error: Error | null
  refresh: () => void
}

/**
 * 一次性 IPC 查询 hook。
 * @param fn 返回 Promise 的 IPC 调用函数；传 null 表示不查询
 * @param deps 依赖数组，变化时重新查询
 */
export function useIpcInvoke<T>(
  fn: (() => Promise<T>) | null,
  deps: unknown[]
): InvokeResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState<boolean>(fn !== null)
  const [error, setError] = useState<Error | null>(null)
  const [trigger, setTrigger] = useState<number>(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const refresh = useCallback((): void => {
    setTrigger((t) => t + 1)
  }, [])

  useEffect(() => {
    if (!fnRef.current) {
      setData(null)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fnRef
      .current()
      .then((result) => {
        if (!cancelled) {
          setData(result)
          setLoading(false)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)))
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, trigger])

  return { data, loading, error, refresh }
}

interface MutationResult<TArgs extends unknown[], TResult> {
  mutate: (...args: TArgs) => Promise<TResult>
  loading: boolean
  error: Error | null
  data: TResult | null
}

/**
 * IPC 变更 hook。
 * @param fn 返回 Promise 的 IPC 调用函数
 */
export function useIpcMutation<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>
): MutationResult<TArgs, TResult> {
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<Error | null>(null)
  const [data, setData] = useState<TResult | null>(null)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const mutate = useCallback(async (...args: TArgs): Promise<TResult> => {
    setLoading(true)
    setError(null)
    try {
      const result = await fnRef.current(...args)
      setData(result)
      setLoading(false)
      return result
    } catch (err: unknown) {
      setError(err instanceof Error ? err : new Error(String(err)))
      setLoading(false)
      throw err
    }
  }, [])

  return { mutate, loading, error, data }
}

/**
 * IPC 事件订阅 hook。
 * @param subscribe 订阅函数，返回取消订阅函数
 * @param callback 事件回调
 * @param deps 依赖数组
 */
export function useIpcSubscribe<T>(
  subscribe: (cb: (payload: T) => void) => Unsubscribe,
  callback: (payload: T) => void,
  deps: unknown[]
): void {
  const callbackRef = useRef(callback)
  callbackRef.current = callback
  const subscribeRef = useRef(subscribe)
  subscribeRef.current = subscribe

  useEffect(() => {
    const unsubscribe = subscribeRef.current((payload: T) => {
      callbackRef.current(payload)
    })
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
