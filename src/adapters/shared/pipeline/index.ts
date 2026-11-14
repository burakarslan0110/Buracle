// The harness-neutral steps of the seven canonical events (`CanonicalEvent` in src/core/events.ts). Each
// function takes a typed input and a dependency object and returns a typed decision; decoding a native
// payload and writing the harness's own output stay in the adapter.
export * from './types'
export * from './health'
export * from './session-start'
export * from './prompt'
export * from './pre-tool'
export * from './post-tool'
export * from './stop'
export * from './pre-compact'
export * from './session-end'
