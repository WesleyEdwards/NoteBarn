import {useCallback, useState} from "react"

/** localStorage that never throws (private windows and blocked storage just don't remember). */
export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? fallback : (JSON.parse(raw) as T)
    } catch {
      return fallback
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Full or blocked.
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key)
    } catch {
      // Blocked.
    }
  }
}

export function usePersistentState<T>(key: string, initial: T): [T, (value: T | ((old: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => storage.get(key, initial))
  const set = useCallback(
    (next: T | ((old: T) => T)) => {
      setValue((old) => {
        const v = typeof next === "function" ? (next as (old: T) => T)(old) : next
        storage.set(key, v)
        return v
      })
    },
    [key]
  )
  return [value, set]
}
