const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../src/core');
const {normalizeMath} = require('../src/markdown');
const {JSDOM}=require('jsdom');
function ui(mockChat, mockParse, options={}) {
  const dom=new JSDOM('<!doctype html><div id="root"></div>');const doc=dom.window.document;
  if(options.IntersectionObserver)dom.window.IntersectionObserver=options.IntersectionObserver;
  const proto=dom.window.HTMLElement.prototype;
  proto.empty=function(){this.replaceChildren();};proto.addClass=function(cls){this.classList.add(cls);};
  proto.createEl=function(tag,opts={}){const e=doc.createElement(tag);if(opts.cls)e.className=opts.cls;if(opts.text)e.textContent=opts.text;if(opts.type)e.type=opts.type;for(const[k,v]of Object.entries(opts.attr||{}))e.setAttribute(k,v);this.append(e);return e;};
  proto.createDiv=function(opts){return this.createEl('div',opts);};proto.createSpan=function(opts){return this.createEl('span',opts);};
  const saved=[],renders=[],copies=[],notices=[],opened=[];let stored=options.saved === undefined ? {uiLanguage:'zh',webEnabled:false} : options.saved;const conversationState=options.conversationState||new Map();
  class Component{constructor(){this.children=new Set();this.unloaded=false;}addChild(c){this.children.add(c);return c;}removeChild(c){this.children.delete(c);c.unload();return c;}unload(){this.unloaded=true;for(const c of this.children)c.unload();this.children.clear();}}
  class Plugin extends Component{registerView(type,factory){this.factory=factory;}addRibbonIcon(){}addCommand(){}async loadData(){return stored;}async saveData(data){if(options.save)await options.save(data);stored=JSON.parse(JSON.stringify(data));saved.push(stored);}}
  class ItemView extends Component{constructor(){super();this.contentEl=doc.querySelector('#root');this.app={};}}
  const MarkdownRenderer={async render(app,text,el,path,component){renders.push({text,component});if(options.renderMarkdown)return options.renderMarkdown(text,el,component);if(options.render)await options.render(text);const node=doc.createElement(text.startsWith('# ')?'h1':'p');node.textContent=text;el.append(node);}};
  const {TextPacer}=require('../src/pacing');
  class TestPacer extends TextPacer { constructor(config) { super({...config,getRate:()=>options.pacingRate ?? 0}); } }
  const keyState=options.keyState || {deepseek:'',mineru:'',libraryPath:''};
  const secretApi={createKeyStore:()=>{if(options.noSecure)throw Error('unavailable');return {load:async()=>({...keyState}),save:async keys=>{Object.assign(keyState,JSON.parse(JSON.stringify(keys)));}};}};
  const conversationApi={prepareConversationRecord:require('../src/conversations').prepareConversationRecord,validId:id=>typeof id==='string'&&/^conversation-[a-z0-9-]{8,120}$/i.test(id),createConversationStore:()=>({load:async()=>({items:[...conversationState.values()].map(value=>JSON.parse(JSON.stringify(value))),errors:[]}),save:async item=>{const {version,updatedAt,...record}=item.body?JSON.parse(item.body):JSON.parse(JSON.stringify(item));conversationState.set(item.id,record);},remove:options.trashConversation || (async id=>conversationState.delete(id))})};
  const module={exports:{}};
  const RealImageStore=require('../src/images').ImageStore;
  const imageApi={ImageStore:class extends RealImageStore {constructor(){super({decodeDimensions:async()=>({width:640,height:480}),send:options.visionSend || (async(key,messages,signal,onText,_http,config)=>{onText(options.describeImage ? await options.describeImage(null,key,signal,()=>{},undefined,config) : 'Image description');return options.imageUsage;}),...options.imageStoreOptions});}}};
  const fileUploads=[];
  const deepseekFiles={...require('../src/deepseek-files'),uploadFile:async(file,_key,signal)=>{
    core.check(signal);const bytes=Buffer.from(await file.arrayBuffer());core.check(signal);
    const hash=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    const metadata={id:'file-api-'+hash.slice(0,24),name:file.name,hash,bytes:bytes.length,purpose:require('../src/deepseek-files').fileOptions(file.name).purpose,expiresAt:Math.floor(Date.now()/1000)+2592000};
    fileUploads.push(metadata);return metadata;
  },validateFiles:async(_messages,_key,signal)=>{core.check(signal);return[];},...options.deepseekFiles};
  const chatFileModule={exports:{}};
  vm.runInNewContext(fs.readFileSync(__dirname+'/../src/chat-files.js','utf8'),{module:chatFileModule,require:name=>name==='./deepseek-files'?deepseekFiles:name==='./core'?core:require(name),Uint8Array,Date});
  const chatFiles={...chatFileModule.exports,...options.chatFiles};
  vm.runInNewContext(fs.readFileSync(__dirname+'/../src/main.js','utf8'),{module,require:name=>name==='obsidian'?{Plugin,ItemView,Component,MarkdownRenderer,requestUrl:async()=>({status:200,json:{}}),setIcon:(el,name)=>{const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('data-icon',name);el.append(svg);},Notice:class{constructor(s){notices.push(s);}}}:name==='electron'?{shell:{openExternal:url=>{opened.push(url);return Promise.resolve();}},clipboard:options.clipboard}:name==='./chat-files'?chatFiles:name==='./deepseek-files'?deepseekFiles:name==='./speech'?require('../src/speech'):name==='./text-safety'?require('../src/text-safety'):name==='./message-renderer'?require('../src/message-renderer'):name==='./thinking-view'?require('../src/thinking-view'):name==='./source-list'?require('../src/source-list'):name==='./notebook-patch-view'?require('../src/notebook-patch-view'):name==='./images'?imageApi:name==='./image-context'?require('../src/image-context'):name==='./library'?(options.libraryApi || require('../src/library')):name==='./secrets'?secretApi:name==='./conversations'?(options.conversationApi || conversationApi):name==='./jupyter-local'?(options.jupyterLocalApi || require('../src/jupyter-local')):name==='./clipboard'?require('../src/clipboard'):name==='./notebook-merge'?require('../src/notebook-merge'):name==='./notebook'?(options.notebookApi || require('../src/notebook')):name==='./request-context'?{requestTimeContext:options.requestTimeContext || (()=>'')}:name==='./turn-context'?require('../src/turn-context'):name==='./prompts'?require('../src/prompts'):name==='./history'?require('../src/history'):name==='./web'?require('../src/web'):name==='./tool-turn'?require('../src/tool-turn'):name==='./models'?require('../src/models'):name==='./selection-copy'?require('../src/selection-copy'):name==='./markdown'?require('../src/markdown'):name==='./i18n'?require('../src/i18n'):name==='./context'?require('../src/context'):name==='./outline'?require('../src/outline'):name==='./pacing'?{TextPacer:options.TextPacer || TestPacer}:{chat:mockChat,listModels:options.listModels,describeImage:options.describeImage || core.describeImage,parseFile:mockParse,check:core.check,abortableTask:core.abortableTask},AbortController,setTimeout,clearTimeout,confirm:options.confirm || (()=>true),navigator:{clipboard:{writeText:async s=>copies.push(s)}}});
  const plugin=new module.exports();plugin.webHttp=options.webHttp || (async()=>{throw Error('Unexpected network access in UI test');});return{plugin,dom,doc,saved,renders,copies,notices,opened,keyState,conversationState,fileUploads};
}
module.exports = {ui};
