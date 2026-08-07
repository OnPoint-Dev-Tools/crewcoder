# Code intelligence tools

CrewCoder includes built-in LSP query tools and an AST-aware symbol body editor.

## LSP bridge

Tools:

- `lsp_definition`: definition lookup at a one-based line and zero-based UTF-16 character.
- `lsp_hover`: type and documentation lookup at a source position.
- `lsp_diagnostics`: diagnostics published after opening a file.

CrewCoder starts a language server per tool call, initializes it at the workspace root, opens the requested file, performs the query, and shuts it down. Source paths remain restricted to the workspace.

Server commands must be available on `PATH`:

| Files | Command |
| --- | --- |
| `.ts`, `.tsx`, `.js`, `.jsx` | `typescript-language-server --stdio` (the LSP adapter over `tsserver`) |
| `.py` | `pyright-langserver --stdio` |
| `.go` | `gopls` |

The bridge does not install language servers automatically. A missing server returns a tool error. The current per-call lifecycle favors isolation and correctness over low latency; persistent project server pooling is a later optimization.

## `edit_symbol`

`edit_symbol` replaces the body of a named function while preserving all source text outside that body. It uses the TypeScript compiler AST rather than text or regular-expression matching and validates syntax before writing.

Supported files in this first parser slice:

- TypeScript: `.ts`, `.tsx`
- JavaScript: `.js`, `.jsx`

Supported symbols include function declarations, block-bodied function/arrow variables, class methods, getters, and setters. Use `ClassName.method` to disambiguate methods with the same name. The `body` argument contains statements without outer braces.

The tool refuses missing or ambiguous symbols, unsupported languages, files with existing parse errors, and replacements that introduce syntax errors. Successful edits participate in mutation logging, approval policy, checkpoints, file-change events, hooks, and audit logging like other mutation tools.
