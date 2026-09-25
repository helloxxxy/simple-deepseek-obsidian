# Simple DeepSeek 0.1.0

Simple DeepSeek brings DeepSeek conversations, image understanding, MinerU PDF extraction, local paper references, and optional Jupyter Notebook collaboration into an Obsidian side panel.

The interface defaults to English and can be switched to Simplified Chinese in settings. Thinking is collapsed by default and can be opened or closed while a response is being generated. Local display speed defaults to unlimited and reasoning effort to low. Completed replies show average output tokens per second, measured from the API request duration rather than the local display speed.

Install the three assets `main.js`, `manifest.json`, and `styles.css` in `<vault>/.obsidian/plugins/simple-deepseek/`, reload Obsidian, and enable **Simple DeepSeek** in Community plugins. Obsidian Desktop 1.12.7 or later is required.

Conversations are plain JSON inside the vault and may sync with it. API keys and machine-specific paths are encrypted outside the vault for the current operating-system user. Chat and image requests go to DeepSeek; PDFs selected for extraction go to MinerU. Notebook collaboration connects to a local Jupyter server. See the [privacy disclosure](https://github.com/helloxxxy/simple-deepseek-obsidian/blob/main/PRIVACY.md) for details.
