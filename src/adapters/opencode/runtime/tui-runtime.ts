// @ts-ignore
import * as solidJs from 'solid-js'
// @ts-ignore
import * as opentuiJsx from '@opentui/solid/jsx-runtime'
// @ts-ignore
import * as opentui from '@opentui/solid'

export type Accessor<T> = () => T
export type Setter<T> = (value: T | ((prev: T) => T)) => void

const solid = solidJs as unknown as {
  createSignal<T>(value: T): [Accessor<T>, Setter<T>]
  createMemo<T>(fn: () => T, initial?: T, options?: { equals?: (a: T, b: T) => boolean }): Accessor<T>
  onCleanup(fn: () => void): void
}
const tui = opentui as unknown as { useTerminalDimensions(): Accessor<{ width: number, height: number }> }
const jsxRuntime = opentuiJsx as unknown as { jsx(type: unknown, props: Record<string, unknown>): unknown }

export const createSignal = <T>(value: T): [Accessor<T>, Setter<T>] => solid.createSignal(value)
export const createMemo = <T>(fn: () => T, equals: (a: T, b: T) => boolean): Accessor<T> => solid.createMemo(fn, undefined, { equals })
export const onCleanup = (fn: () => void): void => solid.onCleanup(fn)
export const useTerminalDimensions = (): Accessor<{ width: number, height: number }> => tui.useTerminalDimensions()

export function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): h.JSX.Element {
  const p: Record<string, unknown> = { ...(props ?? {}) }
  if (children.length === 1) p['children'] = children[0]
  else if (children.length > 1) p['children'] = children
  return jsxRuntime.jsx(type, p)
}

export declare namespace h {
  namespace JSX {
    type Element = unknown
    interface ElementChildrenAttribute { children: unknown }
    interface IntrinsicElements {
      box: Record<string, unknown>
      text: Record<string, unknown>
      span: Record<string, unknown>
    }
  }
}
