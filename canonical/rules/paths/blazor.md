---
paths:
  - "**/*.razor"
  - "**/*.razor.cs"
  - "**/*.razor.css"
---
# Blazor

## Components
- Follow the project's Blazor version, render model and component conventions; these defaults never call for reorganizing existing components.
- Parameters are `[Parameter]` properties with sensible defaults; mark mandatory ones `[EditorRequired]`.
- A child tells its parent through an `EventCallback<T>`, never by calling `StateHasChanged()` to refresh the parent (the callback re-renders it).
- Share state with `[CascadingParameter]` or a registered state service instead of passing parameters down many levels.
- Use an inline `@code` block or a code-behind partial class as the component's size and the project's convention suggest.

## Styling
- Use the project's styling system. With CSS isolation (`Component.razor.css`), remember the generated scope attributes and use `::deep` only where child markup needs it.

## Rendering and lifecycle
- Use only the render modes the project's framework version supports. Where static server rendering is enough, don't add interactivity just because a template has it.
- Give list items a stable `@key` when their identity must survive re-renders.
- Optimize rendering only after you found real waste; a `ShouldRender()` override must never swallow a needed update.
- Release timers, event handlers and subscriptions with `@implements IDisposable` or `IAsyncDisposable`; they leak in interactive server components otherwise.

## Verify
- Check changed components in a real browser: the browser-automation rule has the procedure, and the dotnet rule covers the build and tests.
- Check Blazor and component-library APIs with context7 at the installed version.
