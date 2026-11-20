# Simple DeepSeek 0.1.3

Changes since 0.1.2.

- Ask DeepSeek Flash about images and documents you attach in chat. Pressing **Send** uploads them to your DeepSeek account for 30 days. Reattach the original to use an expired chat attachment again.
- Search the web and read links with Flash's built-in tools. Click the microphone to dictate a draft, or the speaker on a reply to hear it aloud.
- Choose **File to Markdown** to extract a PDF or image with MinerU. Save, copy, or delete each conversion from its own controls. Large PDFs are split locally for parallel conversion.
- Library references now prefer TeX source, followed by PDF and Markdown. An arXiv import keeps the PDF when TeX is unavailable. A Markdown-only entry remains usable and prompts you to add the original PDF.
- Replies display at the rate they arrive. Long replies reuse rendered Markdown blocks. Copy code and fenced text from either end of the block. Conversation search reveals matches inside folded thinking, and copying from tables preserves code and formulas.
- Ask DeepSeek about plots from a connected Notebook by sending changes or the full notebook. Supported image outputs travel as DeepSeek file references. Notebook execution also handles dynamic output updates and deferred clearing.
- Inactive conversations load when selected. If the saved conversation file changed externally, the plugin keeps the external file and saves your changes in a separate local copy.

Requires Obsidian Desktop 1.12.7 or later.
