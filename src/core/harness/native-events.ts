// Every native hook event of each host, as its docs and source name them. A binding in canonical/hooks.yaml may name only these.

export const CLAUDE_CLASSIC_EVENTS: readonly string[] = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'PermissionDenied', 'Notification', 'UserPromptSubmit',
  'UserPromptExpansion', 'SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact',
  'PostCompact', 'PreModelSwitch', 'PostModelSwitch', 'PermissionRequest', 'Setup', 'TeammateIdle', 'TaskCreated',
  'TaskCompleted', 'Elicitation', 'ElicitationResult', 'ConfigChange', 'InstructionsLoaded', 'WorktreeCreate', 'WorktreeRemove',
  'CwdChanged', 'FileChanged', 'DirectoryAdded', 'MessageDisplay',
]

export const CLAUDE_ENGINE_EVENTS: readonly string[] = [
  'tool.call', 'tool.check', 'tool.describe',
  'prompt.submit', 'prompt.fill', 'prompt.suggest', 'prompt.edit', 'prompt.autocomplete', 'prompt.section', 'prompt.context',
  'prompt.compose', 'prompt.attachment', 'prompt.mention',
  'skill.prompt', 'attribution.text', 'command.run', 'command.describe', 'config.set', 'config.describe', 'agent.offer', 'agent.spawn',
  'session.start', 'session.end', 'session.compact', 'session.receive', 'session.send', 'session.append', 'session.attach',
  'session.detach', 'session.measure',
  'turn.start', 'turn.step', 'turn.complete',
  'ui.render', 'ui.resolve', 'ui.press', 'ui.input', 'ui.select', 'ui.message', 'ui.fault', 'ui.scroll', 'ui.focus',
  'plugin.register', 'engine.create', 'telemetry.log', 'telemetry.mark',
]

export const CODEX_EVENTS: readonly string[] = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
  'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt',
]

export const OPENCODE_EVENTS: readonly string[] = [
  'setup',
  'session.prompt', 'session.context', 'session.compaction', 'session.generate', 'session.title', 'session.model.request',
  'session.http.request', 'session.http.response', 'session.retry', 'permission.evaluate', 'shell.create.before',
  'tool.execute.before', 'tool.execute.after',
  'session.created', 'session.deleted', 'session.idle', 'session.status', 'session.execution.started', 'session.execution.succeeded',
  'session.execution.failed', 'session.execution.interrupted', 'session.compaction.started', 'session.compaction.delta',
  'session.compaction.ended', 'session.compaction.failed', 'session.usage.updated', 'session.tool.called', 'session.tool.success',
  'session.tool.failed', 'session.skill.activated', 'session.instructions.updated', 'permission.asked', 'permission.replied',
  'file.edited', 'vcs.branch.updated', 'mcp.status.changed', 'mcp.tools.changed', 'plugin.updated', 'worktree.ready', 'worktree.failed',
]

export const OMP_EVENTS: readonly string[] = [
  'resources_discover', 'session_start', 'session_before_switch', 'session_switch', 'session_before_branch', 'session_branch',
  'session_before_compact', 'session.compacting', 'cache_warming_decision', 'session_compact', 'session_shutdown',
  'session_before_tree', 'session_tree', 'context', 'before_provider_request', 'after_provider_response', 'before_agent_start',
  'before_subagent_spawn', 'agent_start', 'agent_end', 'session_stop', 'turn_start', 'turn_end', 'message_start', 'message_update',
  'message_end', 'assistant_message', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'auto_compaction_start',
  'auto_compaction_end', 'auto_retry_start', 'auto_retry_end', 'retry_fallback_applied', 'retry_fallback_succeeded', 'ttsr_triggered',
  'todo_reminder', 'goal_updated', 'credential_disabled', 'input', 'tool_approval_requested', 'tool_approval_resolved', 'tool_call',
  'tool_result', 'user_bash', 'user_python', 'mcp_notification',
]
