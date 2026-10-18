# Simple DeepSeek for Obsidian

一个仅支持 Obsidian 桌面版的插件：使用 DeepSeek 对话、通过 MinerU 解析 PDF，并可选连接本地 Jupyter Notebook 实时协作。界面默认英文，可切换简体中文。

[English README](README.md)

## 功能

- 使用 Obsidian 原生 Markdown 和公式渲染，选取局部内容可复制为 Markdown。
- 保存、重命名和切换多个对话，查看上下文占用与缓存命中统计；可手动压缩上下文，接近 80 万 tokens 时自动压缩。
- 选择、拖入或粘贴图片与 PDF：DeepSeek Flash 负责识图，MinerU 提取 PDF 文字。
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

在 **Keys and model settings**（密钥与模型设置）中填写 DeepSeek API Key，解析 PDF 时另填 MinerU Token。默认模型是 `deepseek-flash`，名称可修改。本地显示速度默认不限速，思考强度默认低。

修改模型后，下一次请求生效。可用时自动读取所选模型的上下文、输出和思考强度限制；无法获取模型信息时使用内置默认值。

上下文使用率以 1,000,000 tokens 为显示基准。压缩会用摘要替换后续发送给模型的上下文，界面和存档仍保留原始对话。

网页引用可写为 `@[https://example.com/page]`，也可直接让模型搜索。**Search / Fetch** 默认开启；关闭后从下一条消息起停止新的网页请求，显式引用按普通网址处理，此前的引用仍会保留。网页链接默认折叠，读取的文字进入隐藏上下文。[Search、Fetch 按成功请求计费](https://api-docs.deepseek.com/zh-cn/guides/search/)，网页文字也会计入模型输入。

## Notebook

Notebook 模式需要在同一 Python 环境中安装 JupyterLab、实时协作扩展和 Kernel：

```sh
python -m pip install jupyterlab jupyter-collaboration ipykernel
```

之后在插件中填写该环境的 Jupyter 启动程序完整路径，以及目标 `.ipynb` 文件完整路径。文件不存在时插件会新建；Jupyter 仅监听本机 `127.0.0.1`，并在系统默认浏览器打开该笔记本。关闭 Notebook 模式只停止该面板启动的 Jupyter，不会停止复用的现有服务。

每轮可选不发送 Notebook 内容、发送增量（默认）或发送全部单元格源码与文字输出。AI 准备修改时，你仍可编辑和运行笔记本。

关闭 Notebook 模式或选择「不发」时，本轮不提供 Notebook 读取和编辑工具，此前已发送的文字仍在上下文中。

点击「检查并应用 Notebook 修改」，确认后才通过 RTC 写入。应用修改不会运行代码；有冲突的修改会被阻止，可基于最新笔记本重新生成。

「全量运行」会重启 Kernel、清除旧输出并从头运行；成功完成后，可将该次运行的文字结果导出为 `result.json`。

未完成的修改可在重新连接同一笔记本后「继续生成」，或「放弃暂存」并保留对话。无法恢复的任务需要重新生成。删除对话轮次可能使依赖它的待应用修改失效，不会撤销已经写入笔记本的修改。如果回复标为「已提交，未确认同步」，请先在 Jupyter 中核对实际内容；此时重复应用已禁用。

## 图片在哪些环节不会保留

附加的图片在发送时结合问题一起识别，识别文字进入隐藏上下文；需要细节时，模型可重看仍可用的原图或局部。识图独立于 **Search / Fetch**，并计入用量统计。

原图共用一个 128 MiB 的内存缓存，切换或清空会话、关闭面板时释放，空间不足时也可能被淘汰。原图不可用时需重新附加。上传原图的字节及其 Base64 编码不写入会话文件或普通文字上下文。

以下读取环节只提供文字，不会自动识别其中的图片：

- **PDF：** 保留 MinerU 提取的文字，不保留解析图片文件，过滤内嵌图片数据；长 PDF 与 arXiv PDF 入库也遵循此规则。聊天上传的 PDF 不会自动加入文献库。
- **文献库 TeX 和 Markdown：** 不读取插图文件或图片链接，引用文字中的内嵌图片数据会被过滤，源文件保持原样。
- **网页：** Search、Fetch 提供文字，过滤内嵌图片数据。
- **Notebook：** 只将单元格源码和文字输出加入上下文。源码中的内嵌图片数据会被过滤，图片与 SVG 输出、附件和 widget 不进入上下文。`result.json` 包含过滤后的文字输出，不含单元格源码。过滤不会修改原始笔记本。

需要 AI 看图时，请单独上传图片或截图。

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

arXiv 条目优先使用 `source.tex`，否则读取唯一的 `markdown_*.md`；书籍和其他论文条目也使用唯一的 `markdown_*.md`。没有合适文字文件时，有索引且唯一的 PDF 可经 MinerU 解析，Markdown 保存在 PDF 旁边。overview 用 HTML 注释维护 arXiv 版本和 PDF 哈希，PDF 变化时可重新解析。新 arXiv 条目按编号对应日期排序。

自动入库**只支持 arXiv**：未知的 `@[arXiv 编号]` 优先获取 TeX，否则将 PDF 转为 Markdown 并仅保留文字文件。不带版本的引用会检查更新；本地已是最新版或离线时复用已有文字。ISBN 和 DOI 引用使用库内现有条目。超过约 100k tokens 的引用可选发送范围，能识别标题的 TeX 可按章节选择。

## 隐私与存储

- API 密钥和各电脑自己的路径使用操作系统账户的安全存储加密，保存在笔记库之外，不写入共享的 `.obsidian` 配置。
- 对话原文、思考、隐藏引用、原始工具交互及可恢复的 Notebook 任务（含单元格源码与过滤后的文字输出）以**明文 JSON** 保存在 `<笔记库>/.obsidian/plugins/simple-deepseek/conversations/`，会随笔记库同步。清空会话会将文件移入系统回收站；还原文件并重载插件即可恢复。
- 共享设置和对话名称保存在 `data.json`，重命名对话不改变 JSON 文件名。
- 聊天、识图与网页请求发往 DeepSeek，PDF 发往 MinerU，arXiv 入库会访问 arxiv.org。启用工具的请求会将此前的思考与工具交互计入上下文和用量。Jupyter 连接仅在本机进行。
- Obsidian 可能加载已显示 Markdown 中的外部图片，这些图片不会自动加入 AI 上下文。
- 插件没有遥测或独立本地日志。

完整数据流与存储说明见 [PRIVACY.md](PRIVACY.md)。

项目采用 [MIT 许可证](LICENSE)，所用依赖的声明见 [THIRD-PARTY-LICENSE.txt](THIRD-PARTY-LICENSE.txt)。
