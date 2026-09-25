# Simple DeepSeek for Obsidian

[简体中文说明](README.zh-CN.md)

A desktop-only Obsidian plugin for DeepSeek conversations, PDF extraction with MinerU, and optional Jupyter notebook collaboration. The interface defaults to English and can be switched to Simplified Chinese.

## Features

- Show DeepSeek answers and collapsible thinking text. Render Markdown and math with Obsidian's renderer.
- Keep multiple conversations in separate files. Show context usage and DeepSeek's reported cache-hit rate. Compress on demand or when context approaches 800,000 tokens.
- Paste, select, or drag images and PDFs into the chat. Uploaded images use DeepSeek Flash vision; PDFs use MinerU. Image bytes are sent only in the one vision request, while its text description can be used in later turns.
- Optionally reference a local paper library with `@`, including arXiv source retrieval and PDF-to-Markdown fallback.
- In Notebook mode, launch a local JupyterLab server, show notebook cells in Obsidian, exchange changes through Jupyter RTC, run cells, and export a text-only `result.json` beside the notebook.

## Install

This plugin requires **Obsidian Desktop 1.12.7 or later**. It is not yet in the Obsidian Community directory.

1. Download the latest GitHub Release assets: `main.js`, `manifest.json`, and `styles.css`.
2. Put those three files in `<vault>/.obsidian/plugins/simple-deepseek/`.
3. Reload Obsidian and enable **Simple DeepSeek** under **Settings → Community plugins**.

## Configure

Open the plugin panel from the ribbon or the **Open chat** command. Enter your DeepSeek API key in **Keys and model settings**. A MinerU token is needed only for PDF parsing and PDF-based library references. The model name is editable; the default is `deepseek-flash`. Local display speed defaults to unlimited and reasoning effort to low.

Notebook mode is optional. Install `jupyterlab`, `jupyter-collaboration`, and `ipykernel` into the **same Python environment**. Enter the full path to that environment's Jupyter launcher and the full path to a `.ipynb` file. The plugin creates the notebook if absent, starts Jupyter bound to `127.0.0.1`, and opens the notebook in your default browser. Closing Notebook mode stops only a Jupyter process launched by that panel; it will not stop an existing server it reused.

```sh
python -m pip install jupyterlab jupyter-collaboration ipykernel
```

## Images in documents and notebooks

- An image pasted, dragged, or selected **as an image** is sent once to DeepSeek for visual description. Later turns use the description as hidden text context; the image bytes are not saved in the conversation or sent again.
- A PDF is converted through MinerU, but the plugin reads only `full.md` from the result package. It does not retain extracted image files. This also applies when a long PDF is split into batches and when an arXiv PDF is used because TeX source is unavailable. A PDF uploaded directly in chat yields Markdown in that conversation; it is not automatically added to the paper library.
- A library `source.tex` is flattened as text; referenced figure files are not loaded. A library Markdown file is read as text; image links in it are not followed. If a library PDF is parsed, the saved Markdown contains text, not a separate figure collection.
- Notebook context includes cell source and text outputs; image data URIs and long base64-like strings in source are redacted. Image and SVG outputs, cell attachments, and widgets are filtered locally. `result.json` contains the filtered text outputs, not the cell source. The original notebook remains unchanged, and the plugin does not ask the AI to inspect its images.

If a chart, diagram, or notebook output image matters to your question, upload that image or a screenshot separately. Text extracted from a PDF may mention a figure, but it is not a substitute for viewing the figure.

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

Use `@[identifier]` in chat to reference a library item; suggestions can also match its title and authors. The referenced text enters AI context without being shown in the chat transcript. For arXiv, both current numeric IDs and older `category/number` IDs are accepted. The folder uses the versionless ID, replacing `/` with `_` for older IDs. The preferred text is `source.tex`; otherwise keep exactly one `markdown_*.md`. If neither exists, a single indexed PDF can be parsed with MinerU and its Markdown saved beside the PDF. A PDF hash is recorded in an invisible `<!-- pdf-sha256: ... -->` comment in the overview, and a changed PDF is parsed again. Imported arXiv text versions use an invisible `<!-- arxiv-version: ... -->` comment. These comments do not change the rendered overview. Automatic arXiv entries are inserted in identifier date order without rewriting the book or other-paper sections.

Only arXiv IDs can be imported automatically: an unknown `@[arXiv ID]` fetches TeX when available, otherwise converts the arXiv PDF to Markdown and keeps only that text file. An unversioned arXiv reference checks for a newer text version; if the local version is current or the network is unavailable, an existing usable local text file is reused. Book ISBNs and other-paper DOIs are read from items you maintain in the library. Large text files prompt you to select a range or, for recognized TeX sections, select chapters before the text enters context.

## Data and network access

- API keys and machine-specific paths are encrypted with the current OS user's secure storage and kept outside the vault. They are not written to the shared `.obsidian` configuration.
- Conversation text, thinking text, and hidden extracted text are stored as **plain JSON** in `<vault>/.obsidian/plugins/simple-deepseek/conversations/`. If you sync or publish the vault, those files travel with it. Clear a conversation in the plugin to remove its saved file.
- Custom conversation names are stored as plain text in the shared `<vault>/.obsidian/plugins/simple-deepseek/data.json`; renaming does not change a conversation file's name or message content.
- Manually uploaded images go to the DeepSeek API for vision processing. Image base64 is never added to later text messages or the conversation archive. Notebook output images are not automatically sent to AI.
- PDFs go to MinerU. Local arXiv references may contact arxiv.org and download source or PDF files. The Jupyter connection stays on the local machine.
- The paper-library directory, Jupyter executable, and notebook file are user-chosen paths that can be **outside the Obsidian vault**. The plugin reads and writes those paths only for the corresponding feature.
- There is no plugin telemetry or separate local log file.

Read the full [privacy and data-flow disclosure](PRIVACY.md) before entering API keys. The plugin uses third-party packages; their license notices are in [THIRD-PARTY-LICENSE.txt](THIRD-PARTY-LICENSE.txt).

## License

MIT. See [LICENSE](LICENSE) and the separate [third-party notices](THIRD-PARTY-LICENSE.txt).
