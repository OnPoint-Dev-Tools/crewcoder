# Question dialogs

Question dialogs show the wrapped question and its reply controls. Confirmations
offer Yes/No; selection requests show their supplied reply labels and wrapped
descriptions; input requests show a text field. Internal extension IDs and request
kinds stay out of the dialog.

The dialog measures its height from wrapped content. Long questions and messages
scroll with PageUp/PageDown while keeping room for reply choices and keyboard
hints. Up/Down changes the selected reply; Enter submits it. Clicking a wrapped
option or description submits that option. Escape retains the existing cancellation
behavior.

Codex native approval prompts use the reason as the question without appending
the shell command. Command details remain in the tool transcript. The provider's
Allow once / Allow session / Decline values retain their original meaning.

Regression coverage: `src/tests/extension-ui-overlay.test.ts`.
