# Simple DeepSeek for Obsidian

一个仅支持 Obsidian 桌面版的插件：使用 DeepSeek 对话、通过 MinerU 解析 PDF，并可选连接本地 Jupyter Notebook 实时协作。界面默认英文，可切换简体中文。

[English README](README.md)

## 功能

- 使用 Obsidian 原生 Markdown 和公式渲染。
- 多对话存档、上下文占用与缓存命中统计；可手动压缩上下文，接近 80 万 tokens 时也会自动压缩。
- 选择、拖入或粘贴图片与 PDF。图片走 DeepSeek Flash 原生识图，PDF 走 MinerU。图片字节只用于当次识图请求，后续对话只携带识别文字。
- 可选的 `@` 本地文献库引用，包括 arXiv 源码获取与 PDF 转 Markdown。
- 可选的 Notebook 模式：启动本地 JupyterLab、在 Obsidian 中查看单元格、通过 RTC 双向同步、运行单元格，并在笔记本同目录输出纯文本 `result.json`。
- 协作编辑 Jupyter Notebook 时，请在运行前自行核对 AI 给出的代码。

## 安装

需要使用 **Obsidian 桌面版 1.12.7 或更高版本**。可从 [Obsidian 社区插件页面](https://community.obsidian.md/plugins/simple-deepseek)安装，或在「设置 → 第三方插件 → 浏览」中搜索 **Simple DeepSeek**。

手动安装方法：

1. 从 GitHub Release 下载 `main.js`、`manifest.json`、`styles.css`。
2. 将三个文件放入 `<笔记库>/.obsidian/plugins/simple-deepseek/`。
3. 重载 Obsidian，在「设置 → 第三方插件」中启用 **Simple DeepSeek**。

## 配置

在「Keys and model settings」中填写 DeepSeek API Key；切换到中文后，该设置显示为「密钥与模型设置」。只有使用 PDF 解析或需要解析文献库 PDF 时才需要 MinerU Token。默认模型是 `deepseek-flash`，名称可修改。本地显示速度默认不限速，思考强度默认低。

Notebook 模式需要在同一 Python 环境中安装 JupyterLab、实时协作扩展和 Kernel：

```sh
python -m pip install jupyterlab jupyter-collaboration ipykernel
```

之后在插件中填写该环境的 Jupyter 启动程序完整路径，以及目标 `.ipynb` 文件完整路径。文件不存在时插件会新建；Jupyter 仅监听本机 `127.0.0.1`，并在系统默认浏览器打开该笔记本。

## 图片在哪些环节不会保留

- 作为**图片文件**粘贴、拖入或选择的图片，会单独发给 DeepSeek 识别一次。后续对话只使用隐藏的识别文字；图片字节不会存入对话记录，也不会随每轮对话重发。
- PDF 交给 MinerU 后，插件只读取结果包里的 `full.md`，不保留解析产生的图片文件。超过 200 页而分批处理的 PDF，以及没有 TeX 源码而回退为 PDF 的 arXiv 论文，也是如此。直接在聊天里上传 PDF 只会在该对话输出并保存 Markdown，不会自动加入文献库。
- 文献库中的 `source.tex` 只按文本展开，不读取它引用的插图文件；Markdown 只按文本读取，不追踪其中的图片链接。库内 PDF 解析后保存的是 Markdown 文字，不另外保存图集。
- Notebook 增量包含单元格源码和文字输出；源码中的图片 data URI 与长段 base64 类字符串会被遮蔽，图片、SVG、附件及 widget 输出会在本地过滤。`result.json` 只保存过滤后的文字输出，不包含单元格源码。原始 Notebook 文件不因此修改，插件也不会让 AI 读取其中的图片。

如果问题依赖图表、示意图或 Notebook 输出的图片，请把那张图片或截图单独上传。PDF 解析文字即使提到了图，也不能代替模型实际看图。

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

对话里用 `@[编号]` 引用；候选也可按标题和作者搜索。引用的正文进入 AI 上下文，但不在聊天记录界面显示。arXiv 同时接受现代数字编号与旧式 `分类/编号`，文件夹用不带版本的编号，旧式编号中的 `/` 换为 `_`。正文优先使用 `source.tex`；否则应只有一份 `markdown_*.md`。两者都没有时，有索引且唯一的 PDF 可经 MinerU 解析，文字 Markdown 保存在 PDF 旁边。解析 PDF 后，插件在 overview 条目里写入不可见的 `<!-- pdf-sha256: ... -->` 注释；PDF 内容变化时重新解析。arXiv 文本版本用不可见的 `<!-- arxiv-version: ... -->` 注释记录。这些注释不影响正常渲染。自动入库的 arXiv 条目按编号对应的日期顺序插入，不重写 BOOK 或 OTHER PAPER 分区。

自动入库**只支持 arXiv**：输入本地不存在的 `@[arXiv 编号]` 时优先获取 TeX；没有可用源码才下载 arXiv PDF 转 Markdown，入库后只保留文字文件。不带版本的 arXiv 引用会检查文本新版本；已是最新版或无法联网时，若本地已有可用文字文件就直接复用。ISBN 和 DOI 只读取你自行维护的现有条目。长文进入上下文前可选取范围；能识别目录的 TeX 可按章节选择。

## 隐私与存储

API 密钥和各电脑自己的路径使用操作系统账户的安全存储加密，放在笔记库之外。对话原文、思考内容及隐藏的图片/文档识别文字以**明文 JSON** 保存在 `<笔记库>/.obsidian/plugins/simple-deepseek/conversations/`；自定义对话名称以明文保存在同一插件目录的 `data.json`。这些内容会随笔记库同步。请勿把包含它们的笔记库直接公开。

用户指定的文献库、Jupyter 启动程序和 Notebook 可以在笔记库之外。聊天与图片识别请求发往 DeepSeek，PDF 发往 MinerU，arXiv 引用会访问 arxiv.org。插件没有遥测或独立本地日志。具体数据流见 [PRIVACY.md](PRIVACY.md)。

项目采用 [MIT 许可证](LICENSE)，所用依赖的声明见 [THIRD-PARTY-LICENSE.txt](THIRD-PARTY-LICENSE.txt)。
