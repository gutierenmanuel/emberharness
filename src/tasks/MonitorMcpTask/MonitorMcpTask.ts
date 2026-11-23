// Placeholder for the WebSocket/MCP flavour of Monitor (task type 'monitor_mcp').
// The Monitor tool shipped in EmberHarness runs shell commands, which are plain
// LocalShellTask entries with kind 'monitor'; no task of this type is ever
// created yet. The module exists so the shared task dispatch, the tasks dialog
// and runAgent's cleanup have a real, compiling target when MONITOR_TOOL is on.

import type { AppState } from '../../state/AppState.js'
import type { Task, TaskStateBase } from '../../Task.js'
import type { AgentId } from '../../types/ids.js'

export type MonitorMcpTaskState = TaskStateBase & {
  type: 'monitor_mcp'
  /** Agent that started the watch, so it can be stopped with that agent. */
  agentId?: AgentId
}

type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

export function killMonitorMcp(taskId: string, setAppState: SetAppStateFn): void {
  setAppState(prev => {
    const task = prev.tasks?.[taskId]
    if (!task || task.type !== 'monitor_mcp' || task.status !== 'running') {
      return prev
    }
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: { ...task, status: 'killed', notified: true, endTime: Date.now() },
      },
    }
  })
}

export function killMonitorMcpTasksForAgent(
  agentId: AgentId,
  getAppState: () => AppState,
  setAppState: SetAppStateFn,
): void {
  for (const [id, task] of Object.entries(getAppState().tasks ?? {})) {
    if (
      task.type === 'monitor_mcp' &&
      task.status === 'running' &&
      (task as MonitorMcpTaskState).agentId === agentId
    ) {
      killMonitorMcp(id, setAppState)
    }
  }
}

export const MonitorMcpTask: Task = {
  name: 'MonitorMcpTask',
  type: 'monitor_mcp',
  async kill(taskId, setAppState) {
    killMonitorMcp(taskId, setAppState)
  },
}
