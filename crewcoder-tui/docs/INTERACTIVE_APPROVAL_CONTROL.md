# Interactive Approval Control

By default, the TUI runs CrewCoder with `--json-events --approval review` and resolves pending backend approval gates through stdin control messages. `/full-access on` switches future runs in the current TUI session to `--approval full-access`, bypassing approval prompts and dangerous-command blocking until `/full-access off` or `/new`.

When the backend emits `approval_required`, the TUI opens a focused approval popup over the conversation. The underlying approval card remains in the viewport so the decision is still visible after the popup closes.

## Popup Keys

- `y` or `a`: approve.
- `n` or `d`: deny.
- `up` / `down` or `left` / `right`: choose Approve or Deny.
- `enter`: resolve with the selected choice.
- `esc`: dismiss the popup and leave the approval pending.

## Commands

- `/approve`: Approves the latest pending approval card.
- `/approve <approvalId>`: Approves a specific pending approval.
- `/deny`: Denies the latest pending approval card.
- `/deny <approvalId>`: Denies a specific pending approval.
- `/full-access on`: Bypass future approval prompts and allow dangerous commands in this TUI session.
- `/full-access off`: Restore normal review approval behavior.

Approval cards show the backend `approvalId`, tool name, risk, reason, and arguments. When the backend emits `approval_resolved`, the card changes from `pending` to `approved` or `denied`.
