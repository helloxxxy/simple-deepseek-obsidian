# Simple DeepSeek for Obsidian

[简体中文说明](README.zh-CN.md)

A desktop-only Obsidian plugin for DeepSeek chat, optional Jupyter notebook collaboration, and file-to-Markdown conversion with MinerU. The interface defaults to English and can be switched to Simplified Chinese.

## Features

- Render Markdown and math with Obsidian's renderer, copy selected passages as Markdown, or copy a fenced code or text block from either end.
- Save, rename, and switch between conversations. View context usage and cache-hit statistics, and compress context manually or automatically near 800,000 tokens.
- Paste, select, or drag images and documents into chat for questions with DeepSeek Flash.
- Dictate a message with the microphone or read a reply aloud with DeepSeek speech services.
- Convert PDFs and images to Markdown with MinerU, then copy or save the result.
- Reference a local paper library with `@` and import arXiv papers.
- Search and read public web pages with the same DeepSeek API key.
- Optionally collaborate on a local Jupyter notebook: preview cells, synchronize edits, run code, and export text outputs to `result.json`.
- When collaborating on a Jupyter notebook, review AI-generated code yourself before running it.

## Install

This plugin requires **Obsidian Desktop 1.12.7 or later**. Install it from the [Obsidian Community directory](https://community.obsidian.md/plugins/simple-deepseek), or search for **Simple DeepSeek** under **Settings → Community plugins → Browse**.

For manual installation:

1. Download the latest GitHub Release assets: `main.js`, `manifest.json`, and `styles.css`.
2. Put those three files in `<vault>/.obsidian/plugins/simple-deepseek/`.
3. Reload Obsidian and enable **Simple DeepSeek** under **Settings → Community plugins**.

## Configure

Open the plugin panel from the ribbon or the **Open chat** command. Enter your DeepSeek API key in **Keys and model settings**. Add a MinerU token when using **File to Markdown**. The model name is editable and defaults to `deepseek-flash`. Reasoning effort defaults to low.

Model changes take effect on the next request. The plugin reads the model's context window, output limit, and reasoning levels when available. Use DeepSeek Flash for image and file questions.

The context meter uses 1,000,000 tokens as its display baseline. Multi-step web replies can report aggregate usage, so their context estimate is marked as an upper bound and can trigger compression early. Compression replaces the context sent to the model with a summary while keeping the original conversation in chat and its archive.

Paste an HTTP or HTTPS link, use `@[https://example.com/page]`, or ask the model to search. **Search / Fetch** is enabled by default and can be switched for the next message. Source links appear below the reply. Flash chat uses DeepSeek's built-in web tools. DeepSeek charges for the model tokens used during the search and reply. Turns using Notebook tools or a model such as DeepSeek Pro use the standalone Search and Fetch APIs, which carry a fee per successful request. [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/)

## Images, files, and voice

Attachments wait locally until you press **Send**. Images and documents are uploaded to DeepSeek and referenced in the conversation by file ID. PDF, Word, and PowerPoint documents use rich-layout parsing, which includes text and detected figures. Figure detection can miss images, so attach a figure separately when you need it examined. Chat uploads stay separate from the local paper library. [DeepSeek file parsing](https://api-docs.deepseek.com/guides/document_parsing/)

Uploaded files expire after 30 days. The conversation stores file IDs, names, hashes, and expiration metadata. Reattach the original if a chat attachment expires or becomes unavailable. For a Notebook image, the plugin can upload it again automatically when the same output is still available in the connected notebook and Notebook feedback is enabled. Changing DeepSeek accounts can also make earlier files unavailable. Uploaded file bytes and Base64 data are excluded from local conversation archives.

Click the microphone to record, then click it again to transcribe into the message box. You can edit the text before sending. Recording stops after 120 seconds. The read-aloud button on a reply plays its text, and clicking it again stops playback. Recordings and synthesized audio are held in memory only. [DeepSeek speech input](https://api-docs.deepseek.com/guides/asr/), [DeepSeek speech output](https://api-docs.deepseek.com/guides/tts/)

## File to Markdown

Choose **File to Markdown** to extract a PDF or image with MinerU. The resulting Markdown appears in the conversation with copy and save actions. Large PDFs are split locally for parallel processing and their text is combined in page order.

Conversion results are saved with the conversation. The trash icon below a result removes that conversion from the conversation. Attach the saved Markdown when you want to use it in a later AI request. Extracted image files and embedded image data are excluded from the Markdown result.

## Notebook

Notebook mode is optional. Install `jupyterlab`, `jupyter-collaboration`, and `ipykernel` into the **same Python environment**. Enter the full path to that environment's Jupyter launcher and the full path to a `.ipynb` file. The plugin creates the notebook if absent, starts Jupyter bound to `127.0.0.1`, and opens the notebook in your default browser. Closing Notebook mode stops only a Jupyter process launched by that panel; it will not stop an existing server it reused.

```sh
python -m pip install jupyterlab jupyter-collaboration ipykernel
```

Choose **Send changes** (the default), **Send all**, or **Do not send** for each turn. When you press Send, the selected notebook changes or full notebook include cell source and text outputs. PNG, JPEG, GIF, and WebP images in the selected code cells' display or execution results go to DeepSeek as image files for visual questions. The conversation stores file references and text. You can keep editing and running the notebook while the AI prepares changes.

When Notebook mode is off or **Do not send** is selected, Notebook read and edit tools are unavailable for that turn. Earlier text and image references remain available while they are part of the conversation context.

Choose **Review and apply Notebook edits** to review proposed changes before they are written through RTC. Applying edits does not run the code. Conflicting edits are blocked and can be regenerated from the latest notebook.

**Run all** restarts the kernel, clears old outputs, and reruns the notebook. After it succeeds, export that run's text results to `result.json`.

Unfinished edits can be resumed after reconnecting the same notebook, or discarded while keeping the conversation. If a task cannot be restored, regenerate it. Deleting chat turns can invalidate dependent pending edits; it does not undo changes already applied to the notebook. If a reply is marked **Submitted; synchronization unconfirmed**, check the notebook in Jupyter before proceeding; repeat application is disabled.

## Text-only references

Library TeX and Markdown references include their text, with embedded image data filtered. Figure files and linked images need a separate attachment for visual questions. MinerU conversion produces text-only Markdown. Notebook text excludes binary image data, SVG outputs, cell attachments, and widgets. `result.json` exports filtered text outputs. To ask about a supported image output, send the notebook changes or the full notebook in chat.

## Paper library format

Set the paper-library path yourself in **Keys and model settings**; no location is filled in by default. The selected directory may be outside the vault. A populated library needs `OVERVIEW.md` and the `arxiv/`, `book/`, and `otherpaper/` categories. An entirely empty directory is initialized with this layout on its first arXiv import.

```text
<library>/
  OVERVIEW.md
  arxiv/arXiv-number/source.tex
  book/ISBN-number/example-book.pdf
  otherpaper/doi-number/example-paper.pdf
```

`OVERVIEW.md` uses the sections `### ARXIV`, `### BOOK`, and `### OTHER PAPER`. Each indexed item uses a `#### identifier | title` heading, an author quote line, and any PDF or web links. For example:

```markdown
### ARXIV

#### 2601.XXXXX | Example paper

> First Author, Second Author
>
> [web](https://arxiv.org/abs/2601.XXXXX)
```

Use `@[identifier]` in chat; suggestions also match titles and authors. Referenced text enters hidden context. arXiv accepts numeric IDs and older `category/number` IDs; folders use the versionless ID with `/` replaced by `_`.

For each entry the plugin reads **`source.tex` first, then a PDF, then a single `markdown_*.md`**. If the folder contains several PDFs, link the intended file in its `OVERVIEW.md` entry, for example `[[book/ISBN-number/example-book.pdf|pdf]]`. PDF references use the DeepSeek Files API. When only Markdown is available, the plugin reads it and suggests adding the original PDF. HTML comments in the overview record arXiv versions.

Automatic import supports arXiv. An unknown `@[arXiv ID]` fetches TeX when available, otherwise downloads and retains the PDF. Unversioned references check for updates and reuse available local sources when current or offline. ISBN and DOI references use existing library entries. Text references over about 100k tokens offer range selection, or chapter selection for recognized TeX headings. PDF references are processed as complete files by DeepSeek.

To cite a particular arXiv revision, include its version suffix, such as `v1`. In an existing entry the plugin uses a matching source or a PDF saved for that revision. If the recorded revision differs and the requested PDF is missing, the reference stops with a version error. For an entry with no version record, the plugin reads the available file and flags the version as unverified.

## Data and network access

- API keys and machine-specific paths are encrypted with the current OS user's secure storage and kept outside the vault. They are not written to the shared `.obsidian` configuration.
- Conversation text, thinking, hidden references, original tool interactions, and restorable Notebook tasks (including cell source and filtered text outputs) are stored as **plain JSON** in `<vault>/.obsidian/plugins/simple-deepseek/conversations/` and travel with vault sync. Clearing a conversation moves its file to the system trash; restore the file and reload the plugin to recover it.
- Shared settings, conversation names, and a lightweight conversation index are saved in `data.json`. Only the current conversation is restored at startup; other histories load when selected. Renaming a conversation keeps its JSON filename.
- If a conversation file has changed externally before a save, the current conversation is saved as a separate local copy. The external file is preserved; this check applies to changes already present on this computer.
- Chat, file questions, web requests, and speech use DeepSeek. Explicit file-to-Markdown conversion uses MinerU, and arXiv imports contact arxiv.org. Tool-enabled requests include relevant earlier thinking and tool interactions in their context and token usage. Jupyter connections stay on the local machine.
- Obsidian may load external images embedded in displayed Markdown from their own URLs. Those images are not automatically added to AI context.
- There is no plugin telemetry or separate local log file.

See [PRIVACY.md](PRIVACY.md) for the full data flow and storage details.

## License

MIT. See [LICENSE](LICENSE) and the separate [third-party notices](THIRD-PARTY-LICENSE.txt).
