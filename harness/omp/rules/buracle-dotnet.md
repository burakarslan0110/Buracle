---
description: "Buracle path rule: .NET and C# (injected when editing or writing matching files)"
condition:
  - "**/*.cs"
  - "**/*.csproj"
  - "**/*.sln"
  - "**/*.slnx"
  - "**/global.json"
  - "**/Directory.Build.props"
  - "**/Directory.Packages.props"
---
# .NET and C#

## SDK and project settings
- Respect `global.json` (the SDK pin), the target frameworks, the solution format and central package management (`Directory.Packages.props`). Never change the SDK version or a target framework as incidental cleanup.
- Keep the nullable, analyzer and warnings-as-errors settings the repo has; don't switch new global settings on or off to get a build green.
- Add packages with `dotnet add <project> package <name> --version <v>` (or the repo's own way), never by hand-editing a lock file.

## Checks
- Run the repo's scripts when it has them; otherwise `dotnet build`, `dotnet test` (narrow with `--filter` while iterating) and `dotnet format --verify-no-changes` on the solution or project you changed.
- Keep the failure output when a check fails; don't silence warnings to pass.

## Async and resources
- Return `Task` or `Task<T>` from async methods; `async void` only for event handlers whose signature requires it.
- Never block on async work (`.Result`, `.Wait()`, `GetAwaiter().GetResult()`); pass a `CancellationToken` down through I/O calls and honor it.
- Get `HttpClient` from `IHttpClientFactory` or keep one long-lived instance; never create and dispose one per request.
- Dispose what you open (`using`, `await using`), and don't keep mutable state in statics.

## Errors and logging
- Catch specific exceptions where you can recover; rethrow with `throw;` so the stack trace survives.
- Log with structured templates (`logger.LogInformation("Order {OrderId} paid", id)`), never secrets, tokens or personal data.
- Follow the app's existing routing, options, authorization and error contracts; production error responses never expose stack traces.
- A null-forgiving `!` or a suppression needs an invariant that holds, not just a failing build.

## Tests
- Use the existing test framework, fixtures and seams; add an interface only for a real architectural need.
- ASP.NET integration tests use `WebApplicationFactory` when the project does.
- An in-memory database provider or a mocked repository cannot prove query translation, constraints or transaction behavior; test those against the real database engine (for example a disposable container).
- Wait for task or event completion in async tests, never for a fixed delay.

## Library docs
- Check .NET, ASP.NET Core, EF Core and package APIs with context7 at the installed SDK and package versions.
