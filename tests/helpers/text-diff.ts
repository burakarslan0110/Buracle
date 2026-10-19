// The first line where two texts differ, so a failed equality shows the line instead of `false`.
export function firstLineDiff(a: string, b: string): { line: number, a: string | undefined, b: string | undefined } | undefined {
  if (a === b) return undefined
  const la = a.split('\n')
  const lb = b.split('\n')
  let i = 0
  while (i < la.length && i < lb.length && la[i] === lb[i]) i++
  return { line: i + 1, a: la[i], b: lb[i] }
}
