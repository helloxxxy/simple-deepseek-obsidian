# Privacy and data flow

Simple DeepSeek for Obsidian has no telemetry service, advertising, or separate log file. It makes the following network requests only when you use the corresponding feature:

| Action | Destination | Data sent |
| --- | --- | --- |
| Send a chat message, compress context, or recognize a manually supplied image | `api.deepseek.com` | Your effective conversation context, relevant extracted text, and the selected image for a vision request. Your DeepSeek API key authenticates the request. |
| Parse a PDF | `mineru.net` and its signed upload/download URLs | The selected PDF bytes and parsing options. Your MinerU token authenticates the API request. |
| Import or refresh an arXiv reference | `arxiv.org` and its linked download hosts | The requested arXiv identifier and ordinary HTTP request metadata. Source or PDF is downloaded to process the reference. |
| Use Notebook mode | A Jupyter server bound to `127.0.0.1` | Notebook cell edits, execution requests, and results. The local Jupyter token authenticates this connection. |

Uploaded image bytes are carried only in that one DeepSeek vision request. The resulting text description may be retained in the current conversation as hidden context. Notebook output images are not automatically uploaded.

For PDFs, the plugin keeps only the `full.md` text from MinerU's result package, not its extracted image files. LaTeX figure files and image links inside library Markdown are not opened by the library reader. Notebook context includes cell source and text outputs; image data URIs and long base64-like strings in source are redacted, while image/SVG outputs, attachments, and widgets are filtered. `result.json` contains the filtered outputs, not cell source. Upload a figure or screenshot separately if you want the AI to inspect it visually.

The plugin stores API keys and machine-specific paths encrypted using the operating system account's secure storage, outside the vault. If secure storage is unavailable, it uses those values only in memory. It does not put them in `.obsidian/plugins/simple-deepseek/data.json`.

Conversation files under `.obsidian/plugins/simple-deepseek/conversations/` contain **plain-text** prompts, responses, thinking text, and any document or image descriptions added to context. Syncing or publishing a vault can copy these files to another device or person. You can delete a conversation from the plugin interface. The plugin does not delete your source documents or notebooks when a conversation is cleared.

Custom conversation names are stored as plain text in `.obsidian/plugins/simple-deepseek/data.json`, which is also part of the shared vault configuration. The individual conversation JSON filenames remain identifier-based.

The local paper library and Notebook path are chosen by you and may be outside the vault. The paper-library feature can write imported text and update its overview. Notebook mode can create the requested `.ipynb`, launch the Jupyter executable path you provide, modify notebook cells through Jupyter RTC, and write `result.json` beside that notebook on request.

When the plugin opens a notebook in the default browser, its local Jupyter authentication token is included in the `127.0.0.1` URL. Your browser may retain that local URL in its history.

External services process data under their own terms. Review the [DeepSeek privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html) and [MinerU documentation](https://mineru.net/apiManage/docs) before sending private material.
