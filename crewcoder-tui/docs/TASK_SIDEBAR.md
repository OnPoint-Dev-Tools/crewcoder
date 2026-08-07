# Crew task sidebar

The right sidebar shows only tasks attached to the active CrewCoder session.

## Numbering

Task labels in the sidebar restart at `1` for every session. The labels follow task creation order and remain stable when task status changes reorder the visible list. For example, an in-progress task labeled `2` may render above a pending task labeled `1`.

Sidebar labels are presentation-only. Crew task storage and the `TaskGet`, `TaskUpdate`, and `TaskDelete` tools continue to use project-wide durable task IDs so persisted tasks and dependency edges remain unambiguous across sessions.

## Refresh behavior

The widget reads the workspace `.crewcoder/tasks/tasks.json` store while rendering, filters records by the active session ID, and reflects newly created or updated tasks without restarting the TUI.
