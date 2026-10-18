# Simple DeepSeek for Obsidian

[简体中文说明](README.zh-CN.md)

A desktop-only Obsidian plugin for DeepSeek conversations, PDF extraction with MinerU, and optional Jupyter notebook collaboration. The interface defaults to English and can be switched to Simplified Chinese.

## Features

- Render Markdown and math with Obsidian's renderer, and copy selected passages as Markdown.
- Save, rename, and switch between conversations. View context usage and cache-hit statistics; compress context manually or automatically near 800,000 tokens.
- Paste, select, or drag images and PDFs into chat. DeepSeek Flash recognizes images; MinerU extracts PDF text.
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

Open the plugin panel from the ribbon or the **Open chat** command. Enter your DeepSeek API key in **Keys and model settings**, and add a MinerU token for PDF parsing. The model name is editable; the default is `deepseek-flash`. Local display speed defaults to unlimited and reasoning effort to low.

Model changes take effect on the next request. The selected model's context window, output limit, and supported reasoning levels are read automatically when available; built-in defaults are used when model information is unavailable.

The context meter uses 1,000,000 tokens as its display baseline. Compression replaces the context sent to the model with a summary while keeping the original conversation in chat and its archive.

For web references, write `@[https://example.com/page]` or ask the model to search. **Search / Fetch** is enabled by default; turning it off disables new web requests from the next message and treats explicit references as ordinary URLs. Existing references remain available. Page links are collapsed by default, while retrieved text is kept in hidden context. [Search and Fetch are charged per successful request](https://api-docs.deepseek.com/guides/search/); retrieved text also counts as model input.

## Notebook

Notebook mode is optional. Install `jupyterlab`, `jupyter-collaboration`, and `ipykernel` into the **same Python environment**. Enter the full path to that environment's Jupyter launcher and the full path to a `.ipynb` file. The plugin creates the notebook if absent, starts Jupyter bound to `127.0.0.1`, and opens the notebook in your default browser. Closing Notebook mode stops only a Jupyter process launched by that panel; it will not stop an existing server it reused.

```sh
python -m pip install jupyterlab jupyter-collaboration ipykernel
```

Each turn can include no notebook content, only changes (the default), or all cell source and text outputs. You can keep editing and running the notebook while the AI prepares changes.

When Notebook mode is off or **Do not send** is selected, Notebook read and edit tools are unavailable for that turn. Previously shared text remains in context.

Choose **Review and apply Notebook edits** to review proposed changes before they are written through RTC. Applying edits does not run the code. Conflicting edits are blocked and can be regenerated from the latest notebook.

**Run all** restarts the kernel, clears old outputs, and reruns the notebook. After it succeeds, export that run's text results to `result.json`.

Unfinished edits can be resumed after reconnecting the same notebook, or discarded while keeping the conversation. If a task cannot be restored, regenerate it. Deleting chat turns can invalidate dependent pending edits; it does not undo changes already applied to the notebook. If a reply is marked **Submitted; synchronization unconfirmed**, check the notebook in Jupyter before proceeding; repeat application is disabled.

## Images in documents and notebooks

Attached images wait until Send and are examined together with your question. Recognition text enters hidden context; the model can reread an available original or crop. Image requests work independently of **Search / Fetch** and are included in usage statistics.

Originals share a 128 MiB in-memory cache and are released when you switch or clear a conversation or close the panel. An original may also be evicted when space is needed. Attach it again if it is no longer available. Uploaded image bytes and their Base64 encoding are not saved in conversation files or ordinary text context.

These readers provide text without automatically recognizing their images:

- **PDFs:** MinerU text is retained; extracted image files are not kept, and embedded image data is filtered. This also applies to long PDFs and arXiv PDF imports. A PDF uploaded in chat is not automatically added to the paper library.
- **Library TeX and Markdown:** figure files and image links are not followed; embedded image data is removed from the reference text without changing the source file.
- **Web pages:** Search and Fetch provide text, with embedded image data removed.
- **Notebooks:** only cell source and text outputs enter context. Embedded image data is filtered from source; image and SVG outputs, attachments, and widgets are excluded. `result.json` contains filtered text outputs without cell source. This filtering does not modify the original notebook.

Upload a figure or screenshot separately when you want the AI to inspect it.

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

For arXiv entries, `source.tex` takes priority over a single `markdown_*.md`; book and other-paper entries use a single `markdown_*.md`. If no suitable text exists, a single indexed PDF can be parsed with MinerU and its Markdown saved beside it. The overview keeps arXiv versions and PDF hashes in HTML comments, so changed PDFs can be parsed again. New arXiv entries are sorted by identifier date.

Automatic import supports arXiv only: an unknown `@[arXiv ID]` fetches TeX when available, otherwise converts the PDF to Markdown and keeps only the text file. Unversioned references check for updates and reuse available local text when current or offline. ISBN and DOI references use existing library entries. References over about 100k tokens offer range selection, or chapter selection for recognized TeX headings.

## Data and network access

- API keys and machine-specific paths are encrypted with the current OS user's secure storage and kept outside the vault. They are not written to the shared `.obsidian` configuration.
- Conversation text, thinking, hidden references, original tool interactions, and restorable Notebook tasks (including cell source and filtered text outputs) are stored as **plain JSON** in `<vault>/.obsidian/plugins/simple-deepseek/conversations/` and travel with vault sync. Clearing a conversation moves its file to the system trash; restore the file and reload the plugin to recover it.
- Shared settings and conversation names are saved in `data.json`. Renaming a conversation keeps its JSON filename.
- Chat, image recognition, and web requests go to DeepSeek; PDFs go to MinerU, and arXiv imports contact arxiv.org. Tool-enabled requests include earlier thinking and tool interactions in their context and token usage. Jupyter connections stay on the local machine.
- Obsidian may load external images embedded in displayed Markdown from their own URLs. Those images are not automatically added to AI context.
- There is no plugin telemetry or separate local log file.

See [PRIVACY.md](PRIVACY.md) for the full data flow and storage details.

## License

MIT. See [LICENSE](LICENSE) and the separate [third-party notices](THIRD-PARTY-LICENSE.txt).
