# Simple DeepSeek 0.1.1

- Restore chat input focus after a Notebook run or a regular reply completes, without taking focus away from another control.
- Confirm permanent clearing inside the plugin and restore the composer focus after dialogs and completed actions, including when Obsidian regains focus.
- Show Notebook edit confirmation inside the plugin, in the selected interface language, so closing it does not disrupt keyboard focus.
- Render Notebook operation records in the selected interface language, including existing archived edit summaries, without rewriting conversation files or cell output.
- Preserve the Notebook delta baseline when deleting an unrelated exchange; resend the full notebook only if the deleted exchange contained that baseline.
- Choose whether each Notebook turn sends nothing, only changes (the default), or the full text-only notebook.
- Update the English and Chinese READMEs with current installation instructions and a reminder to review AI-generated Notebook code before running it.

Requires Obsidian Desktop 1.12.7 or later.
