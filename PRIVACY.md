# Privacy and data flow

Simple DeepSeek for Obsidian has no telemetry, advertising, or separate log file. It makes these network requests when you use the corresponding feature:

| Action | Destination | Data sent |
| --- | --- | --- |
| Send a message or compress context | `api.deepseek.com` | The effective conversation context, including relevant extracted text, authenticated with your DeepSeek API key. |
| Ask about an image or document | `api.deepseek.com` | The selected file for upload and parsing, then its file ID with the conversation, authenticated with your DeepSeek API key. |
| Check model capabilities | `api.deepseek.com` | Your DeepSeek API key; no conversation content. |
| Search or read web pages | `api.deepseek.com` | Search terms or public page URLs, authenticated with your DeepSeek API key. The plugin sends this key only to DeepSeek. |
| Convert a file to Markdown | `mineru.net` and its signed upload/download URLs | The selected PDF or image and parsing options. Your MinerU token authenticates API requests. |
| Dictate a message | `api.deepseek.com` | The microphone recording, converted locally to WAV, authenticated with your DeepSeek API key. |
| Read a reply aloud | `api.deepseek.com` | The reply text, authenticated with your DeepSeek API key. |
| Send Notebook changes or the full Notebook | `api.deepseek.com` | Cell source, filtered text outputs, and supported images in the selected code-cell outputs. Images are uploaded through the DeepSeek Files API and referenced by file ID. |
| Import or refresh an arXiv reference | `arxiv.org` and linked download hosts | The arXiv identifier and ordinary request metadata. Source or PDF files are downloaded for processing. |
| Use Notebook mode | A Jupyter server on `127.0.0.1` | Cell edits, execution requests, and results, authenticated with a local Jupyter token. |
| Display external Markdown media | URLs in the displayed Markdown | Obsidian may request external resources with ordinary network metadata. The plugin does not attach API keys. |

Images and documents are staged locally until you press Send. DeepSeek's Files API stores the uploaded file in your DeepSeek account, and its file ID is included in the conversation context. PDF, Word, and PowerPoint documents use rich-layout parsing, which supplies text and detected figures to the model. File questions work independently of the Search / Fetch switch.

Uploads are configured to expire after 30 days. File metadata is checked when continuing a conversation. Reattach the original to restore an expired chat attachment. With Notebook feedback enabled, the plugin can automatically upload a matching image again from the connected notebook's outputs to restore an unavailable reference. Files are shared between API keys under the same DeepSeek account. Switching accounts can make earlier references unavailable. Clearing the local conversation leaves cloud files subject to their configured expiration. DeepSeek controls its own data processing and retention policies. [DeepSeek Files API](https://api-docs.deepseek.com/guides/files_api/)

Conversation files retain attachment names, IDs, hashes, purposes, sizes, and expiration metadata. Uploaded file bytes, Base64 encoding, and temporary media URLs are excluded from the archive. Pending attachments are released when the conversation or panel closes.

Microphone recordings stop at 120 seconds and are sent to DeepSeek for transcription. The transcript is inserted into the message draft and becomes conversation content when sent. Reply text is sent to DeepSeek when you choose read aloud. Audio buffers and playback URLs are released after use or cancellation, and audio remains in memory only.

Obsidian's native Markdown renderer may load external media directly from its URL and manage its own rendering cache. Displaying an image does not send it for recognition or add its bytes to AI context or conversation files. Its Markdown URL can remain in the conversation archive.

Each chat turn includes the current time, local date, and time zone in hidden context to help interpret relative dates. These fields are sent to DeepSeek and saved with the conversation.

Flash chat uses DeepSeek's server-side web tools when **Search / Fetch** is enabled. Returned citations, server tool records, and protocol signatures are stored with the reply. DeepSeek controls which retrieved page content is available in subsequent turns. Source links appear in a collapsed section. Turns with Notebook tools or a model such as DeepSeek Pro use DeepSeek's standalone Search and Fetch APIs. The plugin saves their text and source metadata with the conversation and filters embedded image data. Standalone Fetch accepts public HTTP or HTTPS URLs without embedded credentials.

Referenced files and web results contribute to model input usage. DeepSeek charges for model tokens used by its built-in web tools. Its standalone Search and Fetch APIs bill per successful request. Document parsing and speech services have their own rates. [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/)

File-to-Markdown conversion keeps MinerU's extracted text and filters embedded image data. The result is stored with the conversation and can be copied, saved, or removed individually. To use it in AI context, attach the saved Markdown in chat. The library selects TeX source first, then PDF through DeepSeek's Files API, then Markdown. TeX and Markdown references include filtered text, and visual questions about their figures require a separate attachment.

In a connected notebook, sending changes or the full notebook uploads PNG, JPEG, GIF, and WebP images from the selected code cells' display or execution results to DeepSeek. The attachment expiration and storage rules above also apply to these images. The chat request and its local archive use file IDs. Source and output text are filtered to remove embedded image data. SVG outputs, cell attachments, and widgets are excluded. Selecting **Do not send** omits new notebook content from the turn. `result.json` contains filtered text outputs.

API keys, configured machine-specific paths, and Jupyter connection details are encrypted using the operating system account's secure storage outside the vault. If secure storage is unavailable or saving fails, newly entered values remain in memory for that run. These settings are not written to the vault's plugin configuration.

Conversation files in `.obsidian/plugins/simple-deepseek/conversations/` contain **plain-text** prompts, replies, thinking, hidden reference text, attachment metadata, conversion results, citations, protocol signatures, and original tool calls and results. Restorable Notebook checkpoints in the same JSON can contain a text-only base notebook, staged code, incomplete source parts, filtered outputs, and progress. Checkpoints identify the configured notebook by a hash. Syncing or sharing the vault also shares these files.

Custom conversation names are saved as plain text in both the conversation JSON and `.obsidian/plugins/simple-deepseek/data.json`. Clearing a conversation moves its JSON to the system trash; if that fails, the conversation is kept. Trash contents remain recoverable until emptied through the operating system. Clearing does not delete source documents or notebooks.

`data.json` also stores a lightweight index of conversation titles, creation times, file sizes, and modification times so inactive histories can load on demand. Before replacing a conversation file, the plugin checks its last-read contents. A detected external change causes the current contents to be saved under a new conversation ID, preserving the external file. This protects changes already available on the local filesystem; it is not a distributed lock across computers that have not synchronized. Temporary lock files contain a process ID, a hashed machine identifier, and a random ownership token, and are removed after the operation.

The library and Notebook locations may be outside the vault. The plugin can save imported TeX or PDF files and update the library overview. Conversion results can be saved to a location you choose. Notebook mode can launch your configured Jupyter executable, create the requested notebook, apply reviewed cell edits, run code on request, and write `result.json` beside the notebook.

Notebook edits are staged until you review and confirm them; applying code does not run it. Unfinished edits can be saved with the conversation and explicitly resumed after reconnecting the same notebook. Resuming sends the relevant task state and notebook changes to DeepSeek. If a text-only checkpoint cannot be saved, the task remains available only in memory. Discarding staged edits preserves the original chat and tool records.

Manual edits and filtered execution results observed during generation enter subsequent model requests and the conversation archive. Before applying AI edits, the plugin checks for conflicts with the live notebook. If edits have been submitted but server confirmation fails, they are marked unconfirmed and repeat application is disabled.

Opening a notebook in the default browser includes its local Jupyter authentication token in the `127.0.0.1` URL, which the browser may retain in history.

External services process data under their own terms and may charge for requests. See the [DeepSeek privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html) and [MinerU documentation](https://mineru.net/apiManage/docs).
