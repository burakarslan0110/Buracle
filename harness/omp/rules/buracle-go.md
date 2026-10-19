---
description: "Buracle path rule: Go (injected when editing or writing matching files)"
condition:
  - "**/*.go"
  - "**/go.mod"
  - "**/go.sum"
  - "**/go.work"
---
# Go

## Modules and tooling
- Respect the `go` and `toolchain` lines in go.mod. Add dependencies with `go get module@version`, run `go mod tidy` after changing imports and read its diff, and never edit go.sum by hand. Never run a blanket `go get -u ./...` as routine verification. Touch `vendor/` only if the repo vendors (`go mod vendor`).
- Use workspace mode (`go.work`) only when the repo already has one.
- Format every changed file with `gofmt` (or `goimports`), run `go vet ./...`, and run `golangci-lint run` when the repo has a config for it.

## Errors
- Return errors; don't panic in library code. Panics are for programmer bugs and `Must…` helpers fed constant input.
- Wrap with context: `fmt.Errorf("load config %s: %w", path, err)`. Inspect with `errors.Is` and `errors.As`, never by comparing strings.
- Handle every error. When one is deliberately ignored, a comment says why. Error strings are lowercase with no trailing punctuation.
- Sentinel errors are package variables (`var ErrNotFound = errors.New("not found")`); use a custom error type when callers need fields.

## Context and concurrency
- Functions that do I/O, block, or can be cancelled take `ctx context.Context` as their first parameter. Pass it down, never store it in a struct, and honor `ctx.Done()`.
- Pair every `context.WithTimeout` or `WithCancel` with `defer cancel()`.
- Every goroutine has an owner and a way to stop. Prefer `errgroup.Group` for fan-out with error propagation; the sending side closes channels.
- Guard shared state with a `sync.Mutex` or confine it to one goroutine, and run `go test -race` on concurrent code.

## Design
- Accept interfaces, return concrete types; declare small interfaces where they are consumed, not where they are implemented.
- Avoid package-level mutable state and side effects in `init()`.
- `defer` cleanup right after acquiring a resource, and check the error from `Close` on writers.
- Use `log/slog` for structured logging when the repo does.
- Keep the exported API small; doc comments start with the identifier's name.

## Tests
- Run `go test ./...` before finishing; while iterating, narrow with `go test ./pkg -run TestName -count=1`.
- Write table-driven tests with `t.Run` subtests, call `t.Helper()` in helpers, and isolate with `t.TempDir()` and `t.Setenv()`. Fixtures live in `testdata/`.
- Synchronize with channels or `sync.WaitGroup`, never `time.Sleep`.
- Compare values with `cmp.Diff` (go-cmp) when the repo uses it; otherwise `reflect.DeepEqual` plus a clear failure message.

## Library docs
- Check third-party module APIs with context7, or `go doc pkg.Symbol` for modules already in go.mod, before relying on them.
