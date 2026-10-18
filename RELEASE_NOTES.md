# Simple DeepSeek 0.1.2

Changes since 0.1.1.

- Add DeepSeek Search and Fetch with the existing API key, enabled by default with a Search / Fetch switch. Support explicit HTTP and HTTPS page references. Retrieved text enters context, with page links collapsed in chat.
- Analyze multiple attached images together with your question when you press Send. Support rereading originals or crops while they remain in memory.
- Read the selected model's context window, output limit, and supported reasoning levels automatically when available.
- Add resumable, chunked Notebook edits for large insertions and cell rewrites. Save unfinished edits with the conversation and offer Resume generation and Discard staged edits.
- Merge compatible manual Notebook changes when applying staged AI edits; overlapping or uncertain changes remain blocked.
- Fix execution results being written to the wrong cell when cells move during execution.
- Render thinking text on demand to reduce rendering work in long conversations.
- Copy selected rendered passages as Markdown, including formulas, code, and source links.
- Move cleared conversations to the system trash.

Search and Fetch use billable API requests. Tool-enabled requests also include earlier thinking and tool interactions in context and usage.

Updating from 0.1.1 uses the existing conversation files and local settings. Version 0.1.1 does not support the new tool histories or resumable Notebook tasks.

Requires Obsidian Desktop 1.12.7 or later.
