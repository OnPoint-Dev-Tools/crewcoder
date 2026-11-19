# Third-party notices

## termcn

Files under `src/components/ui/`, `src/hooks/`, `src/providers/`, and `src/lib/terminal-themes/`
(compiled into `dist/`) are vendored from [termcn](https://github.com/shadcn-labs/termcn)
at commit `5a02dae79542add57ba392d2b51785138d0c3b6e`, some with local modifications
described in each file header. termcn is distributed under the MIT License:

```text
MIT License

Copyright (c) 2026 Aniket Pawar

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Tree-sitter grammars

Files under `grammars/<filetype>/` are copied unmodified from each grammar's npm package
at the exact version below: the compiled `tree-sitter-*.wasm`, `queries/highlights.scm`
(saved as `highlights.scm`), and the package's `LICENSE`, which ships next to them.
`scripts/update-grammars.mjs` reproduces them; `src/syntax/grammars.ts` pins their
SHA-256 hashes. All are distributed under the MIT License.

| Filetype | Package | Version | Copyright |
| --- | --- | --- | --- |
| python | `tree-sitter-python` | 0.25.0 | (c) 2016 Max Brunsfeld |
| bash | `tree-sitter-bash` | 0.25.1 | (c) 2017 Max Brunsfeld |
| json | `tree-sitter-json` | 0.24.8 | (c) 2014 Max Brunsfeld |
| rust | `tree-sitter-rust` | 0.24.0 | (c) 2017 Maxim Sokolov |
| go | `tree-sitter-go` | 0.25.0 | (c) 2014 Max Brunsfeld |
| yaml | `@tree-sitter-grammars/tree-sitter-yaml` | 0.7.1 | (c) 2024 tree-sitter-grammars contributors |
| css | `tree-sitter-css` | 0.25.0 | (c) 2018 Max Brunsfeld |
| html | `tree-sitter-html` | 0.23.2 | (c) 2014 Max Brunsfeld |
