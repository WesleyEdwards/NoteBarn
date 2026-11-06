/** A time the way a list of versions shows it: "Today, 3:05 PM", "Yesterday, 9:12 AM", "Nov 3, 3:05 PM". */
export function when(iso: string, now = new Date()): string {
  const at = new Date(iso)
  const time = at.toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"})
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((day(now) - day(at)) / 86_400_000)
  if (days === 0) return `Today, ${time}`
  if (days === 1) return `Yesterday, ${time}`
  const date = at.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(at.getFullYear() !== now.getFullYear() ? {year: "numeric"} : {})
  })
  return `${date}, ${time}`
}

/** A size for people: "820 B", "12 KB", "3.4 MB". */
export function bytes(n: number): string {
  if (n < 1000) return `${n} B`
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`
  return `${(n / 1_000_000).toFixed(1)} MB`
}
