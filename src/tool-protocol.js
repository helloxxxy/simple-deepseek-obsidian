const TOOL_PROTOCOL_MESSAGES = Object.freeze({
  invalid_tool_protocol: '模型把工具请求写成了普通文字，未通过原生工具通道执行；请重试',
  web_disabled: 'Search / Fetch 已关闭；这段文字形式的工具请求未执行。开启复选框后重新发送，即可查询实时信息。'
});
const OPENING = /^(?:<tool_calls?\b|<[|｜]{1,2}DSML[|｜]{1,2}\s+(?:calls|invoke|parameter)\b)/i;
const INTRODUCERS = ['<tool_call', '<tool_calls'];
for (const left of ['|', '||']) for (const right of ['|', '||']) for (const name of ['calls', 'invoke', 'parameter']) INTRODUCERS.push(`<${left}dsml${right} ${name}`);
const normalizePrefix = value => value.toLowerCase().replace(/｜/g, '|').replace(/\s+/g, ' ');

const markdownState = () => ({fence:null,line:'',overflow:false,inlineTicks:0,tickRun:0});
const copyMarkdown = state => ({...state,fence:state.fence && {...state.fence}});
function flushTicks(state) {
  if (state.tickRun && !state.fence && !/^[ \t]{0,3}`{3,}$/.test(state.line)) {
    if (!state.inlineTicks) state.inlineTicks = state.tickRun;
    else if (state.inlineTicks === state.tickRun) state.inlineTicks = 0;
  }
  state.tickRun = 0;
}
function advanceMarkdown(state, character) {
  if (character === '\n') {
    if (!state.overflow) {
      const fence = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/.exec(state.line);
      if (fence) {
        if (!state.fence) state.fence = {character:fence[1][0],length:fence[1].length,language:fence[2].trim().toLowerCase()};
        else if (fence[1][0] === state.fence.character && fence[1].length >= state.fence.length && !fence[2].trim()) state.fence = null;
      }
    }
    state.line = ''; state.overflow = false; state.inlineTicks = 0; state.tickRun = 0; return;
  }
  if (character === '`') state.tickRun++;
  else flushTicks(state);
  if (state.line.length < 512) state.line += character; else state.overflow = true;
}
function protocolPosition(state) {
  flushTicks(state);
  if (state.inlineTicks || /^[ \t]{0,3}>/.test(state.line)) return false;
  if (!state.fence) return true;
  // XML/JSON/DSML may wrap an actual leaked request. Source-code fences and
  // strings inside a structured example are ordinary notebook/chat content.
  return /^(?:xml|json|dsml|text)?$/.test(state.fence.language) && !state.line.trim();
}
function scanProtocol(text, initial = markdownState()) {
  const state = copyMarkdown(initial);
  let partial = text.length;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '<' && protocolPosition(state)) {
      if (OPENING.test(text.slice(index,index+80))) return {index,partial};
      if (index >= text.length - 80 && INTRODUCERS.some(value => value.startsWith(normalizePrefix(text.slice(index))))) partial = Math.min(partial,index);
    }
    advanceMarkdown(state,text[index]);
  }
  return {index:-1,partial};
}

function exampleRequest(userText = '') {
  return /\b(?:DSML|tool_calls?)\b|<\/?tool_calls?>|(?:\b(?:explain|show|describe|example|syntax|format|markup|protocol)\b[\s\S]{0,100}\b(?:XML|DSML|tool|syntax|format|wrapper|markup|example|protocol)\b)|(?:\b(?:XML|DSML|tool|syntax|format|markup|protocol)\b[\s\S]{0,100}\b(?:example|syntax|format|mean|explain)\b)|(?:解释|说明|展示|举例|示例|格式|语法|标记|标签|协议)[\s\S]{0,80}(?:DSML|XML|工具|调用|格式|示例|语法|标记|标签|协议)/i.test(userText);
}
function exampleIntroduction(text) {
  return /(?:\b(?:example|syntax|markup|format|protocol|literal|quoted)\b|(?:示例|语法|格式|协议|字面|引用的|代码样例))[^\n]*:?\s*(?:\n\s*(?:`{3,}|~{3,})[^\n]*)?\s*$/i.test(text.slice(-300));
}
function protocolRequestInfo(text, userText = '') {
  if (exampleRequest(userText)) return { leaked: false, webOnly: false };
  const match = scanProtocol(text);
  if (match.index < 0 || exampleIntroduction(text.slice(0, match.index))) return { leaked: false, webOnly: false };
  const names = [...text.slice(match.index).matchAll(/\binvoke\b[^>\r\n]*\bname\s*=\s*["']([a-zA-Z0-9_-]+)|"name"\s*:\s*"([a-zA-Z0-9_-]+)/g)].map(item => item[1] || item[2]);
  return { leaked: true, webOnly: names.length > 0 && names.every(name => ['search_web', 'fetch_page'].includes(name)) };
}
function textualToolRequest(text, userText = '') { return protocolRequestInfo(text, userText).leaked; }

// During ordinary output, retain only a short unfinished marker or wrapper fence.
// A detected protocol body stays out of the visible stream; raw history is separate.
class ProtocolTextBuffer {
  constructor({ userText = '', onText = () => {} } = {}) {
    this.userText = userText; this.onText = onText; this.exempt = exampleRequest(userText);
    this.pending = ''; this.prefix = ''; this.hidden = ''; this.leaked = false; this.ended = false; this.markdown = markdownState();
  }
  emit(text) {
    if (!text) return;
    this.prefix = (this.prefix + text).slice(-300); for (const character of text) advanceMarkdown(this.markdown,character); this.onText(text);
  }
  push(delta) {
    if (this.ended || !delta) return;
    if (this.exempt) { this.emit(delta); return; }
    if (this.leaked) { this.hidden += delta; return; }
    const text = this.pending + delta; this.pending = '';
    const opening = scanProtocol(text,this.markdown);
    if (opening.index >= 0) {
      let start = opening.index;
      const wrapper = /(?:^|\n)[ \t]*(?:`{3,}|~{3,})[\w-]{0,32}[ \t]*\r?\n[ \t]*$/i.exec(text.slice(0, start));
      if (wrapper) {
        const beforeWrapper = copyMarkdown(this.markdown);
        for (const character of text.slice(0,wrapper.index)) advanceMarkdown(beforeWrapper,character);
        if (!beforeWrapper.fence) start = wrapper.index;
      }
      if (exampleIntroduction(this.prefix + text.slice(0, start))) { this.exempt = true; this.emit(text); return; }
      this.emit(text.slice(0, start)); this.hidden = text.slice(start); this.leaked = true; return;
    }
    let cut = opening.partial;
    const wrapper = /(?:^|\n)[ \t]*(?:`{1,}|~{1,})[\w-]{0,32}[ \t]*(?:\r?\n[ \t]*)?$/i.exec(text.slice(0, cut));
    if (wrapper && text.length - wrapper.index <= 100) cut = wrapper.index;
    this.emit(text.slice(0, cut)); this.pending = text.slice(cut);
  }
  end() {
    if (!this.ended) {
      this.ended = true;
      if (!this.leaked && /<[|｜]{1,2}DSML\b/i.test(this.pending)) { this.leaked = true; this.hidden = this.pending; }
      if (!this.leaked) this.emit(this.pending);
      this.pending = '';
    }
    return this.leaked ? {...protocolRequestInfo(this.hidden, this.userText),leaked:true} : { leaked: false, webOnly: false };
  }
}
module.exports = { TOOL_PROTOCOL_MESSAGES, textualToolRequest, protocolRequestInfo, ProtocolTextBuffer };
