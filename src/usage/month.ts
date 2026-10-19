export function monthKeyOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function dayKeyOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return dayKeyOf(new Date(y, m - 1, d - n, 12).getTime())
}

export function monthDays(ym: string, nowMs: number): string[] {
  const { startMs, endMs } = monthRange(ym)
  const last = Math.min(endMs - 1, nowMs)
  const out: string[] = []
  for (let day = dayKeyOf(startMs); last >= startMs && day <= dayKeyOf(last); day = shiftDay(day, -1)) out.push(day)
  return out
}

export function isMonthKey(s: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/u.test(s)
}

export function monthRange(ym: string): { startMs: number, endMs: number } {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return { startMs: new Date(y, m - 1, 1).getTime(), endMs: new Date(y, m, 1).getTime() }
}

export function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return monthKeyOf(new Date(y, m - 1 - n, 1).getTime())
}

export function localIso(ms: number): string {
  const d = new Date(ms)
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
}
