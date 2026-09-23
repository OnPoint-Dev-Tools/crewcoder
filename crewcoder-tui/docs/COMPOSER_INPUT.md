# Composer input

The TUI enables terminal bracketed paste while it runs. Pasted text arrives as one composer event, including multiline text and CRLF line endings. The composer normalizes pasted CRLF and CR to newlines and keeps the full draft until Enter is pressed. Shift+Enter, Alt+Enter, and Ctrl+J insert a newline.

Terminals that do not support bracketed paste may still send pasted carriage returns as ordinary Enter keys. The TUI cannot distinguish those bytes from a pressed Enter in that mode.
