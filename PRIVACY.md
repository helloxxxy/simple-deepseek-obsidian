# Privacy and data flow

Simple DeepSeek for Obsidian has no telemetry, advertising, or separate log file. It makes these network requests when you use the corresponding feature:

| Action | Destination | Data sent |
| --- | --- | --- |
| Send a message or compress context | `api.deepseek.com` | The effective conversation context, including relevant extracted text, authenticated with your DeepSeek API key. |
| Recognize or reread attached images | `api.deepseek.com` | The image question and selected images or crops, authenticated with your DeepSeek API key. |
| Check model capabilities | `api.deepseek.com` | Your DeepSeek API key; no conversation content. |
| Search or read web pages | `api.deepseek.com` | Search terms or public page URLs, authenticated with your DeepSeek API key. The plugin sends this key only to DeepSeek. |
| Parse a PDF | `mineru.net` and its signed upload/download URLs | The selected PDF and parsing options. Your MinerU token authenticates API requests. |
| Import or refresh an arXiv reference | `arxiv.org` and linked download hosts | The arXiv identifier and ordinary request metadata. Source or PDF files are downloaded for processing. |
| Use Notebook mode | A Jupyter server on `127.0.0.1` | Cell edits, execution requests, and results, authenticated with a local Jupyter token. |
| Display external Markdown media | URLs in the displayed Markdown | Obsidian may request external resources with ordinary network metadata. The plugin does not attach API keys. |

Images are staged locally until you press Send, then sent with your question for recognition. The resulting text enters hidden conversation context. Later chat requests use that text; the model can also request another look at an original or crop while it remains available in memory, sending those bytes to DeepSeek again. Image recognition is independent of the Search / Fetch switch.

Original images and recognition results are cached in memory, with a 128 MiB image limit. Previously sent originals may be evicted. Switching or clearing a conversation or closing the panel releases the originals and recognition cache; unavailable originals must be attached again. Uploaded image bytes, their Base64 encoding, and temporary image URLs are not saved in plugin files or ordinary text context. Conversation files retain image names, identifiers, recognition text, and related tool interactions.

Obsidian's native Markdown renderer may load external media directly from its URL and manage its own rendering cache. Displaying an image does not send it for recognition or add its bytes to AI context or conversation files. Its Markdown URL can remain in the conversation archive.

Each chat turn includes the current time, local date, and time zone in hidden context to help interpret relative dates. These fields are sent to DeepSeek and saved with the conversation.

Web tools retrieve text only. Page text or summaries and source metadata are hidden from the chat body but saved in context and the conversation archive; page links appear in chat. Embedded image data is filtered locally. Fetch accepts public HTTP or HTTPS URLs without embedded credentials. Web response caches last only for the current turn.

[DeepSeek bills Search and Fetch per successful request](https://api-docs.deepseek.com/guides/search/). Retrieved text and image recognition results included in chat count as model input. Requests using tools also resend relevant earlier thinking and tool interactions, which contribute to context and usage. Image recognition and rereads are separate model requests.

PDF processing keeps MinerU's extracted Markdown text, without its image files or embedded image data. The library reader does not open LaTeX figures or images linked in Markdown. Filtering existing references does not change their source files or PDFs. Notebook context includes source code and filtered text outputs, excluding embedded image data, image/SVG outputs, attachments, and widgets. `result.json` contains filtered outputs without cell source. These images are not automatically sent for recognition; visual inspection requires a separate attachment.

API keys, configured machine-specific paths, and Jupyter connection details are encrypted using the operating system account's secure storage outside the vault. If secure storage is unavailable or saving fails, newly entered values remain in memory for that run. These settings are not written to the vault's plugin configuration.

Conversation files in `.obsidian/plugins/simple-deepseek/conversations/` contain **plain-text** prompts, replies, thinking, hidden document/image/web text, and original tool calls and results. Restorable Notebook checkpoints in the same JSON can contain a text-only base notebook, staged code, incomplete source parts, filtered outputs, and progress. Checkpoints identify the configured notebook by a hash rather than storing its local path. Syncing or sharing the vault also shares these files.

Custom conversation names are saved as plain text in both the conversation JSON and `.obsidian/plugins/simple-deepseek/data.json`. Clearing a conversation moves its JSON to the system trash; if that fails, the conversation is kept. Trash contents remain recoverable until emptied through the operating system. Clearing does not delete source documents or notebooks.

The library and Notebook locations may be outside the vault. The plugin can save imported reference text and update the library overview. Notebook mode can launch your configured Jupyter executable, create the requested notebook, apply reviewed cell edits, run code on request, and write `result.json` beside the notebook.

Notebook edits are staged until you review and confirm them; applying code does not run it. Unfinished edits can be saved with the conversation and explicitly resumed after reconnecting the same notebook. Resuming sends the relevant task state and notebook changes to DeepSeek. If a text-only checkpoint cannot be saved, the task remains available only in memory. Discarding staged edits preserves the original chat and tool records.

Manual edits and filtered execution results observed during generation enter subsequent model requests and the conversation archive. Before applying AI edits, the plugin checks for conflicts with the live notebook. If edits have been submitted but server confirmation fails, they are marked unconfirmed and repeat application is disabled.

Opening a notebook in the default browser includes its local Jupyter authentication token in the `127.0.0.1` URL, which the browser may retain in history.

External services process data under their own terms and may charge for requests. See the [DeepSeek privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html) and [MinerU documentation](https://mineru.net/apiManage/docs).
