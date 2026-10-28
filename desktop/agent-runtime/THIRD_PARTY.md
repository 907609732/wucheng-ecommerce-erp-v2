# Model metadata

`codex-model-catalog.json` contains model protocol metadata from OpenAI Codex
`rust-v0.150.1`, commit `90854393966b21e9ebfd21b122334eb09a20c93d`,
`codex-rs/models-manager/models.json` (Apache-2.0).
The upstream coding instruction text is replaced with ERP task instructions.
At process creation the selected catalog model is restricted to ERP MCP tools.
Unknown model names and incompatible engine versions are rejected instead of
falling back to unrestricted model metadata.

Source: https://github.com/openai/codex/tree/rust-v0.150.1
License: https://github.com/openai/codex/blob/rust-v0.150.1/LICENSE
