# Background jobs

The TUI consumes the backend `background_job_start`, `background_job_output`, `background_job_status`, and `background_job_end` events.

Each job renders as a dedicated transcript block containing its `bg_id`, command, lifecycle status, exit code, and the latest output lines. Output updates do not set the main agent run to blocked, so assistant/tool activity can continue while a server or watcher runs.

The backend owns process execution and lifecycle. The TUI only reduces and renders events; it does not spawn commands itself.
