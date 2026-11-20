# Simple DeepSeek for Obsidian

一个仅支持 Obsidian 桌面版的插件，提供 DeepSeek 对话、可选的 Jupyter Notebook 协作，以及 MinerU 文件转 Markdown。界面默认英文，可切换简体中文。

[English README](README.md)

## 功能

- 使用 Obsidian 原生 Markdown 和公式渲染，选取段落可复制为 Markdown。代码块和围栏文本块的顶部、底部均可复制整块内容。
- 保存、重命名和切换多个对话，查看上下文占用与缓存命中统计，可手动压缩上下文，接近 80 万 tokens 时自动压缩。
- 选择、拖入或粘贴图片与文件，通过 DeepSeek Flash 进行问答。
- 使用 DeepSeek 语音服务输入消息或朗读回复。
- 使用 MinerU 将 PDF 和图片转为 Markdown，并复制或保存结果。
- 使用 `@` 引用本地文献库，并支持 arXiv 论文入库。
- 使用同一 DeepSeek 密钥搜索和读取公开网页。
- 可选的本地 Jupyter Notebook 协作：预览单元格、同步修改、运行代码，并将文字输出保存为 `result.json`。
- 协作编辑 Jupyter Notebook 时，请在运行前自行核对 AI 给出的代码。

## 安装

需要使用 **Obsidian 桌面版 1.12.7 或更高版本**。可从 [Obsidian 社区插件页面](https://community.obsidian.md/plugins/simple-deepseek)安装，或在「设置 → 第三方插件 → 浏览」中搜索 **Simple DeepSeek**。

手动安装方法：

1. 从 GitHub Release 下载 `main.js`、`manifest.json`、`styles.css`。
2. 将三个文件放入 `<笔记库>/.obsidian/plugins/simple-deepseek/`。
3. 重载 Obsidian，在「设置 → 第三方插件」中启用 **Simple DeepSeek**。

## 配置

在 **Keys and model settings**（密钥与模型设置）中填写 DeepSeek API Key，使用「文件转 Markdown」时另填 MinerU Token。默认模型是 `deepseek-flash`，名称可修改，思考强度默认低。

修改模型后，下一次请求生效。插件会读取模型提供的上下文长度、输出上限和思考强度选项。图片和文件问答请使用 DeepSeek Flash。

上下文使用率以 1,000,000 tokens 为显示基准。多步联网回复可能返回合计用量，对应的上下文估计会标记为上界，可能提前触发压缩。压缩会用摘要替换后续发送给模型的上下文，界面和存档仍保留原始对话。

可直接粘贴 HTTP 或 HTTPS 链接，写成 `@[https://example.com/page]`，也可让模型搜索。**Search / Fetch** 默认开启，开关从下一条消息起生效。网页来源显示在回复下方。Flash 普通对话使用 DeepSeek 内置联网工具，搜索和回答产生的模型 token 按用量计费。启用 Notebook 工具或选用 DeepSeek Pro 等模型时，插件使用独立 Search 和 Fetch 接口，按成功请求次数另行计费。[DeepSeek 计费说明](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)

## 图片、文件与语音

附件在点击「发送」后上传到 DeepSeek，并通过文件 ID 加入对话。PDF、Word 和 PowerPoint 使用包含文字与检测到的插图的版面解析。解析可能遗漏插图，需要核对某张图时可单独上传该图。聊天上传的文件独立于本地文献库保存。[DeepSeek 文件解析](https://api-docs.deepseek.com/guides/document_parsing/)

上传文件的有效期为 30 天，对话保存文件 ID、名称、哈希和过期时间。聊天附件过期或不可用时，请重新附加原文件。对于 Notebook 输出图片，如果已连接的笔记本里仍有相同图片，且开启了增量或全量反馈，插件可自动重新上传。更换 DeepSeek 账户也可能使历史文件不可用。本地会话存档排除上传文件字节和 Base64 数据。

点击麦克风开始录音，再次点击后将语音转写到输入框，编辑后即可发送。录音最长 120 秒。回复旁的朗读按钮用于播放正文，再次点击即可停止。录音和合成音频仅在内存中暂存。[DeepSeek 语音输入](https://api-docs.deepseek.com/guides/asr/)、[DeepSeek 语音输出](https://api-docs.deepseek.com/guides/tts/)

## 文件转 Markdown

选择「文件转 Markdown」，使用 MinerU 提取 PDF 或图片，转换结果直接显示在对话中，并提供复制和保存操作。大 PDF 会在本地拆分并行处理，再按页序汇总文字。

转换结果随对话保存，点击结果下方的垃圾桶图标可单独删除这一条。需要将其用于后续 AI 问答时，可附加保存的 Markdown。结果排除解析出的图片文件与内嵌图片数据。

## Notebook

Notebook 模式需要在同一 Python 环境中安装 JupyterLab、实时协作扩展和 Kernel：

```sh
python -m pip install jupyterlab jupyter-collaboration ipykernel
```

之后在插件中填写该环境的 Jupyter 启动程序完整路径，以及目标 `.ipynb` 文件完整路径。文件不存在时插件会新建；Jupyter 仅监听本机 `127.0.0.1`，并在系统默认浏览器打开该笔记本。关闭 Notebook 模式只停止该面板启动的 Jupyter，不会停止复用的现有服务。

每轮可选「不发」「发增量」（默认）或「发全部」。点击发送时，插件按所选范围提交单元格源码与文字输出。代码单元格的显示或执行结果中含有 PNG、JPEG、GIF 或 WebP 图片时，插件将图片作为独立文件交给 DeepSeek 识图，对话保存文件引用和文字。AI 准备修改时，你仍可编辑和运行笔记本。

关闭 Notebook 模式或选择「不发」时，本轮不提供 Notebook 读取和编辑工具。此前已发送的文字和图片引用，只要仍在当前上下文中，就可继续用于问答。

点击「检查并应用 Notebook 修改」，确认后才通过 RTC 写入。应用修改不会运行代码；有冲突的修改会被阻止，可基于最新笔记本重新生成。

「全量运行」会重启 Kernel、清除旧输出并从头运行；成功完成后，可将该次运行的文字结果导出为 `result.json`。

未完成的修改可在重新连接同一笔记本后「继续生成」，或「放弃暂存」并保留对话。无法恢复的任务需要重新生成。删除对话轮次可能使依赖它的待应用修改失效，不会撤销已经写入笔记本的修改。如果回复标为「已提交，未确认同步」，请先在 Jupyter 中核对实际内容；此时重复应用已禁用。

## 纯文字引用

文献库 TeX 和 Markdown 引用提供过滤内嵌图片数据后的文字，需要识图时请另行附加插图。MinerU 转换提供纯文本 Markdown。Notebook 的文字反馈会过滤图片编码、SVG 输出、单元格附件和 widget，`result.json` 仅导出过滤后的文字输出。需要让 DeepSeek 读取支持的输出图片时，在聊天中发送 Notebook 增量或全部内容即可。

## 文献库规范

在「密钥与模型设置」里自行填写文献库路径，插件不预填目录；文献库可以在笔记库之外。已有内容的文献库需要 `OVERVIEW.md`，目录按 `arxiv/`、`book/`、`otherpaper/` 分类。完全空白的目录会在首次 arXiv 入库时自动建立这些文件和分类。

```text
<文献库>/
  OVERVIEW.md
  arxiv/arXiv-number/source.tex
  book/ISBN-number/example-book.pdf
  otherpaper/doi-number/example-paper.pdf
```

`OVERVIEW.md` 使用 `### ARXIV`、`### BOOK`、`### OTHER PAPER` 三个分区。条目标题为 `#### 编号 | 标题`，下一段用引用行写作者，并可放 PDF、网页等链接，例如：

```markdown
### ARXIV

#### 2601.XXXXX | Example paper

> First Author, Second Author
>
> [web](https://arxiv.org/abs/2601.XXXXX)
```

对话里用 `@[编号]` 引用，候选也可按标题和作者搜索；引用文字进入隐藏上下文。arXiv 接受数字编号与旧式 `分类/编号`，文件夹使用不带版本的编号，并将 `/` 换为 `_`。

每个条目依次读取 **`source.tex`、PDF、唯一的 `markdown_*.md`**。同一目录有多份 PDF 时，在 `OVERVIEW.md` 对应条目中链接要引用的那一份，例如 `[[book/ISBN-number/example-book.pdf|pdf]]`。PDF 通过 DeepSeek 文件接口读取。仅有 Markdown 时读取正文，并提示建议补充 PDF 原件。arXiv 版本记录在总目录的 HTML 注释中。

自动入库支持 arXiv，未知的 `@[arXiv 编号]` 优先获取 TeX，否则下载并保留 PDF。不带版本的引用会检查更新，本地已是最新版或离线时复用可用的本地文件。ISBN 和 DOI 引用使用库内现有条目。超过约 100k tokens 的文字引用可选发送范围，能识别标题的 TeX 可按章节选择。PDF 作为完整文件交由 DeepSeek 处理。

引用特定 arXiv 版本时，在编号末尾加上 `v1` 等版本号。已有条目会读取版本匹配的正文，或该版本单独保留的 PDF。若已登记的版本不同且找不到所需版本的 PDF，这次引用会提示版本错误。条目没有版本记录时，插件读取本地文件并提示版本待核实。

## 隐私与存储

- API 密钥和各电脑自己的路径使用操作系统账户的安全存储加密，保存在笔记库之外，不写入共享的 `.obsidian` 配置。
- 对话原文、思考、隐藏引用、原始工具交互及可恢复的 Notebook 任务（含单元格源码与过滤后的文字输出）以**明文 JSON** 保存在 `<笔记库>/.obsidian/plugins/simple-deepseek/conversations/`，会随笔记库同步。清空会话会将文件移入系统回收站；还原文件并重载插件即可恢复。
- 共享设置、对话名称和轻量会话索引保存在 `data.json`。启动时只恢复当前会话，其他历史在选择时加载；重命名对话不改变 JSON 文件名。
- 保存时如果发现会话文件已被外部修改，当前内容会另存为本地副本，外部文件保留；此检查针对已经同步到这台电脑的变化。
- 聊天、文件问答、网页与语音请求发往 DeepSeek，明确选择的文件转 Markdown 使用 MinerU，arXiv 入库会访问 arxiv.org。启用工具的请求会将相关的历史思考与工具交互计入上下文和用量。Jupyter 连接仅在本机进行。
- Obsidian 可能加载已显示 Markdown 中的外部图片，这些图片不会自动加入 AI 上下文。
- 插件没有遥测或独立本地日志。

完整数据流与存储说明见 [PRIVACY.md](PRIVACY.md)。

项目采用 [MIT 许可证](LICENSE)，所用依赖的声明见 [THIRD-PARTY-LICENSE.txt](THIRD-PARTY-LICENSE.txt)。
