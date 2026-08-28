# Crew task sidebar

The right sidebar shows only tasks attached to the active CrewCoder session.

## Numbering

Each agent session numbers its own tasks from `1`. Those labels are presentation-only and stay stable when status changes reorder the list, so an in-progress task labeled `2` can render above pending task `1`.

A new session does not continue the previous session's counter. Inside a session, creating a task after every current task is `completed` retires that finished list so the next plan also starts at `1` instead of rolling to `11`.

## Refresh behavior

The widget reads the workspace `.crewcoder/tasks/tasks.json` store while rendering, filters records by the active session ID, and reflects newly created or updated tasks without restarting the TUI.
