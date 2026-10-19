---
description: "Buracle path rule: Python (injected when editing or writing matching files)"
condition:
  - "**/*.py"
  - "**/*.pyi"
  - "**/pyproject.toml"
  - "**/requirements*.txt"
  - "**/uv.lock"
  - "**/setup.cfg"
---
# Python

## Environment
- Identify the toolchain before running anything: `uv.lock` → uv; `poetry.lock` → Poetry; `Pipfile.lock` → Pipenv; otherwise a `.venv` with `requirements*.txt`. Take the Python version from `.python-version` or `requires-python`.
- Run everything inside the project environment: `uv run pytest`, `uv run python -m pkg`, or the activated `.venv`. Never install into the system or Homebrew Python; no `pip install --user`, no `sudo pip`.
- Add dependencies with the project's tool (`uv add httpx`, `uv add --dev pytest`) so the lockfile stays in sync; never hand-edit a lockfile. New projects default to uv (`uv init`).
- Run one-off tools with `uvx` (`uvx ruff check .`) instead of installing them globally.

## Style and lint
- If ruff is configured (`[tool.ruff]` in pyproject.toml or a `ruff.toml`), run `ruff check --fix` and `ruff format` on the files you touched. Otherwise keep the formatter the repo already uses; don't introduce a new one.
- PEP 8 naming, no wildcard imports, no unused imports or variables. Prefer `pathlib.Path`, f-strings and comprehensions that stay readable.

## Types
- Annotate public functions, methods and module-level constants. Use modern syntax (`list[str]`, `X | None`) when the minimum Python version allows it.
- Run the configured checker (pyright, basedpyright or mypy) on changed code. Don't silence it with `# type: ignore` or `Any` unless a comment says why.
- Model structured data with `dataclasses`, `TypedDict` or pydantic, following the project's convention, rather than loose dicts.

## Errors and resources
- Raise specific exception types and chain causes (`raise ConfigError(...) from err`). No bare `except:`; catch `Exception` only at boundaries (CLI entry point, request handler, worker loop) and log or translate it there.
- Don't use `assert` for runtime validation; it disappears under `python -O`.
- Manage resources with context managers (files, locks, DB sessions, temp dirs). Pass `encoding="utf-8"` when reading or writing text.
- `subprocess.run([...], check=True, timeout=...)` with an argument list; never `shell=True` with interpolated input.
- No mutable default arguments. Use timezone-aware datetimes (`datetime.now(timezone.utc)`).
- Never `eval`/`exec` or `pickle.load` untrusted data; use `yaml.safe_load`; parameterize SQL.
- Library code logs through `logging.getLogger(__name__)`; `print` belongs only in CLIs and scripts.

## Async
- Never block the event loop: no `time.sleep`, blocking I/O or heavy CPU work inside `async` code; offload with `asyncio.to_thread`.
- Prefer `asyncio.TaskGroup` and `asyncio.timeout` (3.11+) when the project targets them, and keep references to tasks you create.

## Tests (pytest)
- Use pytest idioms: plain `assert`, fixtures, `tmp_path`, `monkeypatch`, `pytest.mark.parametrize`, `pytest.raises(..., match=...)`.
- Test through the public API. Unit tests touch no live network, no real home directory and no wall clock.
- Iterate with `uv run pytest tests/test_x.py::test_name -q`; run the whole suite once before finishing.
- Use hypothesis only where the repo already does or the input space is large.

## Library docs
- Check third-party APIs with context7 at the version pinned in the lockfile before using unfamiliar calls.
