const { chat, check } = require('./core');
const { estimateText, outputBudget } = require('./context');
const { copyMessage } = require('./history');
const { webTools, safeWebText } = require('./web');
const { safeNotebook } = require('./notebook');
const { TOOL_PROTOCOL_MESSAGES, textualToolRequest, ProtocolTextBuffer } = require('./tool-protocol');
const DEFAULT_BATCH_TOKENS = 4096, MIN_BATCH_TOKENS = 512, MAX_RECOVERY_FAILURES = 3, MAX_SOURCE_READ = 12000, MAX_INDEX_PREVIEW = 200;

const notebookTool = {
  type: 'function', function: {
    name: 'stage_notebook_edits',
    description: 'Stage a complete JSON batch of notebook edits for user review. This does not modify or run the notebook. Only use when the user requests edits and a Notebook delta or unfinished edit task is attached. Use the latest returned currentHash as the next baseHash. Prefer replace_text for small changes; do not repeat source in your explanation. Follow recommendedBatchTokens, which is guidance for each batch, not the response limit. Split large new cells or full rewrites into consecutive source_chunk operations: chunkId, part (0-based), source; part 0 also includes operation:{type:"insert_cell",index?,cellType,cellId?} or {type:"set_source",cellId}. Supply totalParts if known, otherwise omit it and finish the last part with final:true. Finish the pending chunk before other edits; use the returned taskId, revision and nextPart as receipts. Set done:false until all work is staged, then done:true. Never output partial JSON or repair a truncated JSON fragment. Edits await user confirmation.',
    parameters: { type: 'object', properties: {
      baseHash: {type:'string'}, done: {type:'boolean'}, operations: {type:'array',items:{type:'object',properties:{
        type:{type:'string',enum:['set_source','insert_cell','delete_cell','replace_text','source_chunk']},
        cellId:{type:'string'},index:{type:'integer'},cellType:{type:'string',enum:['code','markdown','raw']},source:{type:'string'},oldText:{type:'string'},newText:{type:'string'},chunkId:{type:'string'},part:{type:'integer'},totalParts:{type:'integer'},final:{type:'boolean'},
        operation:{type:'object',properties:{type:{type:'string',enum:['insert_cell','set_source']},index:{type:'integer'},cellType:{type:'string',enum:['code','markdown','raw']},cellId:{type:'string'}},required:['type'],additionalProperties:false}
      },required:['type'],additionalProperties:false}}
    },required:['baseHash','operations','done'],additionalProperties:false}
  }
};
const readNotebookTool = {
  type: 'function', function: {
    name: 'read_notebook',
    description: 'Read the virtual notebook and completed staged edits without modifying files or running code. Omit parameters for the cell index, IDs, types, sourceLength and a firstLine preview of at most 200 characters; firstLineTruncated indicates omitted first-line text. Read complete source with cellIds, which also returns text-only outputs, or page one cell with sourceRange:{offset?,limit?}. pendingSource:{offset?,limit?} instead reads the unfinished source chunk and task progress, including after a context checkpoint; do not combine it with cellIds or sourceRange. Offsets count source characters from zero; paged reads are at most 12000 characters. Images, attachments, binary data and widgets are removed. currentHash identifies staging state.',
    parameters: { type: 'object', properties: {
      cellIds: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
      sourceRange: {type:'object',properties:{offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:MAX_SOURCE_READ}},additionalProperties:false},
      pendingSource: {type:'object',properties:{offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:MAX_SOURCE_READ}},additionalProperties:false}
    }, additionalProperties: false }
  }
};
const readImageTool = {
  type: 'function', function: {
    name: 'read_image',
    description: 'Reexamine one or more previously attached images for a specific question, using their image IDs. Use only when the existing description lacks details needed for the task or the question requires comparing images. For small labels or axes, optionally crop one image using region coordinates normalized to the original image: x/y at the top-left, width/height, all in [0,1]. Originals are held only in this session memory and may no longer be available; ask the user to reattach missing images. Returns text only. This tool does not open image URLs or read files.',
    parameters: { type: 'object', properties: {
      imageIds: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, uniqueItems: true },
      question: { type: 'string', minLength: 1 },
      region: { type: 'object', properties: { x: {type:'number',minimum:0,maximum:1}, y: {type:'number',minimum:0,maximum:1}, width: {type:'number',exclusiveMinimum:0,maximum:1}, height: {type:'number',exclusiveMinimum:0,maximum:1} }, required: ['x','y','width','height'], additionalProperties: false }
    }, required: ['imageIds','question'], additionalProperties: false }
  }
};
function turnTools(notebook, webEnabled = true, images = null, batchTokens = DEFAULT_BATCH_TOKENS) {
  const stage = {...notebookTool,function:{...notebookTool.function,description:notebookTool.function.description+' Current recommendedBatchTokens: '+batchTokens+'.'}};
  return [...(webEnabled ? webTools : []), ...(notebook ? [stage, readNotebookTool] : []), ...(images ? [readImageTool] : [])];
}
function imageArguments(args) {
  if (Object.keys(args).some(name => !['imageIds','question','region'].includes(name)) || !Array.isArray(args.imageIds) || !args.imageIds.length || args.imageIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(args.imageIds).size !== args.imageIds.length || typeof args.question !== 'string' || !args.question.trim()) throw Error('read_image requires unique nonempty imageIds and a nonempty question.');
  if (args.region !== undefined) {
    const region = args.region;
    if (args.imageIds.length !== 1 || !region || typeof region !== 'object' || Array.isArray(region) || Object.keys(region).some(name => !['x','y','width','height'].includes(name)) || ['x','y','width','height'].some(name => !Number.isFinite(region[name]) || region[name] < 0 || region[name] > 1) || !region.width || !region.height || region.x + region.width > 1 || region.y + region.height > 1) throw Error('read_image region requires one image and a nonempty normalized rectangle within its original bounds.');
  }
  return args;
}
function imageResult(result) {
  if (typeof result === 'string') return safeWebText(result);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('read_image returned an invalid text result.');
  const visited = new Set(), pending = [result];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || (typeof Blob === 'function' && value instanceof Blob)) throw Error('read_image returned binary data instead of a text result.');
    visited.add(value); pending.push(...Object.values(value));
  }
  return JSON.stringify(result, (key, value) => typeof value === 'string' ? safeWebText(value) : value);
}
function readNotebook(notebook, args) {
  if (Object.keys(args).some(name => !['cellIds','pendingSource','sourceRange'].includes(name)) || (args.cellIds !== undefined && (!Array.isArray(args.cellIds) || args.cellIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(args.cellIds).size !== args.cellIds.length))) throw Error('read_notebook 的 cellIds 必须是不重复的非空字符串数组');
  if (args.pendingSource !== undefined) {
    if (args.cellIds !== undefined || args.sourceRange !== undefined || typeof notebook.readPending !== 'function') throw Error('read_notebook pendingSource cannot be combined with cellIds or sourceRange.');
    return {...notebook.readPending(sourceRange(args.pendingSource)),kind:'notebook_pending_source',currentHash:notebook.currentHash};
  }
  const range = args.sourceRange === undefined ? null : sourceRange(args.sourceRange);
  if (range && args.cellIds?.length !== 1) throw Error('read_notebook sourceRange requires exactly one cellId.');
  const safe = safeNotebook(notebook.read());
  if (args.cellIds === undefined) return { kind: 'notebook_index', currentHash: safe.notebookHash, cells: safe.cells.map(cell => {
    const firstLine = cell.source.split(/\r?\n/,1)[0];
    const preview = firstLine.slice(0,MAX_INDEX_PREVIEW).replace(/[\uD800-\uDBFF]$/,'');
    return {cellId:cell.cellId,index:cell.index,cellType:cell.cellType,firstLine:preview,sourceLength:cell.source.length,firstLineTruncated:preview.length<firstLine.length};
  }) };
  const cells = new Map(safe.cells.map(cell => [cell.cellId, cell]));
  if (args.cellIds.some(id => !cells.has(id))) throw Error('read_notebook 包含未知单元格 ID，请重新读取 Notebook 索引');
  if (range) {
    const cell = cells.get(args.cellIds[0]), end = Math.min(cell.source.length,range.offset+range.limit);
    return {kind:'notebook_source',currentHash:safe.notebookHash,cells:[{cellId:cell.cellId,index:cell.index,cellType:cell.cellType,source:cell.source.slice(range.offset,end),offset:range.offset,totalSourceLength:cell.source.length,nextOffset:end,hasMore:end<cell.source.length}]};
  }
  return { kind: 'notebook_cells', currentHash: safe.notebookHash, cells: args.cellIds.map(id => cells.get(id)) };
}
function sourceRange(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['offset','limit'].includes(key)) || (value.offset !== undefined && (!Number.isSafeInteger(value.offset) || value.offset < 0)) || (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > MAX_SOURCE_READ))) throw Error('read_notebook source offsets must be nonnegative integers and limits must be between 1 and 12000.');
  return {offset:value.offset ?? 0,limit:value.limit ?? MAX_SOURCE_READ};
}
function stagingProgress(before, after) {
  if (!before || !after) return false;
  if (!before.done && after.done) return true;
  if (Number.isFinite(before.progress) && Number.isFinite(after.progress)) return after.progress > before.progress;
  return before.currentHash !== after.currentHash || (after.nextPart || 0) > (before.nextPart || 0) || (after.operations || 0) > (before.operations || 0);
}
function addUsage(total, usage) {
  if (!usage) return total;
  total ||= {};
  for (const field of ['prompt_tokens','completion_tokens','prompt_cache_hit_tokens','prompt_cache_miss_tokens','total_tokens']) if (Number.isFinite(usage[field])) total[field] = (total[field] || 0) + usage[field];
  if (Number.isFinite(usage.completion_tokens_details?.reasoning_tokens)) total.completion_tokens_details = {reasoning_tokens:(total.completion_tokens_details?.reasoning_tokens || 0)+usage.completion_tokens_details.reasoning_tokens};
  return total;
}
function resultProgressKey(name, result) {
  const ignored = name === 'stage_notebook_edits' ? ['replayed','recommendedBatchTokens'] : name === 'read_image' ? ['cached'] : ['search_web','fetch_page'].includes(name) ? ['retrieved_at'] : null;
  if (!ignored) return result;
  try { return JSON.stringify(JSON.parse(result),(key,value) => ignored.includes(key) ? undefined : value); }
  catch { return result; }
}
function canonicalArguments(value) {
  if (Array.isArray(value)) return '['+value.map(canonicalArguments).join(',')+']';
  if (value && typeof value === 'object') return '{'+Object.keys(value).sort().map(key => JSON.stringify(key)+':'+canonicalArguments(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
function toolSignature(call, args) {
  const original = call.function.name+'\n'+call.function.arguments;
  try {
    if (args === undefined) args = JSON.parse(call.function.arguments);
    return call.function.name+'\n'+canonicalArguments(args);
  } catch { return original; }
}
function unavailableBatch(error, tools) {
  if (error?.category !== 'unavailable_tool' || error.incomplete !== false || error.finishReason !== 'tool_calls' || !Array.isArray(error.toolCalls) || !error.toolCalls.length) return null;
  const available = new Set(tools.map(tool => tool.function.name)), ids = new Set();
  for (const call of error.toolCalls) {
    if (!call || typeof call.id !== 'string' || !call.id || ids.has(call.id) || call.type !== 'function' || typeof call.function?.name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(call.function.name) || typeof call.function.arguments !== 'string') return null;
    ids.add(call.id);
    let args;
    try { args = JSON.parse(call.function.arguments); } catch { return null; }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  }
  const unavailableTools = [...new Set(error.toolCalls.filter(call => !available.has(call.function.name)).map(call => call.function.name))];
  if (!unavailableTools.length) return null;
  return { calls: copyMessage({role:'assistant',content:'',tool_calls:error.toolCalls}).tool_calls, unavailableTools, availableTools:[...available] };
}
async function runToolTurn({ key, session, signal, model, reasoningEffort, systemPrompt, capabilities, web, webEnabled = true, notebook = null, notebookAvailable = () => true, images = null, userText,
  send = chat, onRawText = () => {}, onText = () => {}, onThinking = () => {}, onToolProgress = () => {}, onMessage = () => {}, onRecord = () => {}, onUsage = () => {}, onStatus = () => {}, onProtocolIssue = () => {}, onCheckpoint = async () => {}, beforeRequest = async () => {} }) {
  let recommendedBatchTokens = DEFAULT_BATCH_TOKENS, lengthFailures = 0, toolFailures = 0;
  let notebookRevoked = false;
  const currentNotebook = () => {
    if (!notebook || notebookRevoked) return null;
    try { notebookRevoked = !notebookAvailable(); } catch { notebookRevoked = true; }
    return notebookRevoked ? null : notebook;
  };
  let tools = turnTools(currentNotebook(), webEnabled, images, recommendedBatchTokens);
  const metadata = {model,systemPrompt,includeReasoning:tools.length > 0};
  const originalRequest = userText ?? [...session.messages].reverse().find(message => message.role === 'user')?.content ?? '';
  let totalUsage = null, hasText = false, observedCompactions = session.compactions || 0;
  let protocolAttempts = 0, protocolCorrectionUsed = false, recoveryPending = false, unavailableAttempts = 0;
  const failures = new Set(), truncations = new Set();
  const rejectedRequests = new Set();
  const successfulResults = new Map();
  const append = message => { session.messages.push(message); onMessage(message); return message; };
  const finishPatch = () => { if (!notebook) return null; try { return notebook.result(); } catch { return null; } };
  const checkpoint = async () => { if (notebook && typeof notebook.exportState === 'function') await onCheckpoint(notebook.exportState()); };
  const stagingStatus = () => notebook?.status ? notebook.status() : {currentHash:notebook?.currentHash};
  try { while (true) {
    check(signal);
    const notebookForRequest = currentNotebook();
    tools = turnTools(notebookForRequest, webEnabled, images, recommendedBatchTokens);
    let schemaTokens = tools.length ? estimateText(JSON.stringify(tools)) + 16 : 0;
    await beforeRequest(schemaTokens); check(signal);
    if (notebookForRequest !== currentNotebook()) {
      tools = turnTools(null, webEnabled, images, recommendedBatchTokens);
      schemaTokens = tools.length ? estimateText(JSON.stringify(tools)) + 16 : 0;
    }
    metadata.includeReasoning = tools.length > 0;
    if ((session.compactions || 0) !== observedCompactions) { successfulResults.clear(); observedCompactions = session.compactions || 0; }
    const prior = session.messages.map(message => { const copy = copyMessage(message); if (!tools.length) delete copy.reasoning_content; return copy; }), assistant = {role:'assistant',content:'',reasoning_content:''};
    let attached = false, calls = [], usage, failure, requested = false, accepting = true;
    const attach = () => { if (!attached) { append(assistant); attached = true; } };
    const visible = new ProtocolTextBuffer({userText:originalRequest,onText:delta => { if (!signal?.aborted) { hasText = true; onText(delta); } }});
    try {
      const maxOutputTokens = outputBudget(session, schemaTokens, capabilities, metadata);
      requested = true;
      usage = await send(key, [{role:'system',content:systemPrompt}, ...prior], signal, delta => {
        if (!accepting || signal?.aborted || !delta) return; attach(); assistant.content += delta; onRawText(delta); visible.push(delta);
      }, undefined, {
        model, reasoningEffort, tools, maxOutputTokens,
        onThinking: delta => { if (!accepting || signal?.aborted || !delta) return; attach(); assistant.reasoning_content = (assistant.reasoning_content || '') + delta; onThinking(delta); },
        onToolProgress: progress => { if (accepting && !signal?.aborted) onToolProgress(progress); },
        onToolCalls: value => { if (accepting && !signal?.aborted) calls = value; }
      });
      check(signal);
    } catch (error) { failure = error; usage = error.usage || usage; }
    finally { accepting = false; }
    const protocol = visible.end();
    const rejected = unavailableBatch(failure,tools);
    const rejection = rejected ? failure : null;
    if (rejected) { calls = rejected.calls; failure = null; }
    if (calls.length && !failure) { attach(); assistant.tool_calls = calls; }
    if (attached || failure) onRecord({type:'response',message:copyMessage(assistant),...(failure ? {error:failure.message,finishReason:failure.finishReason,unfinishedToolCalls:failure.toolCalls || []} : {}),...(rejected ? {rejectedToolCalls:copyMessage(assistant).tool_calls,rejection:{category:rejection.category,error:rejection.message,finishReason:rejection.finishReason,unavailableTools:rejected.unavailableTools}} : {})});
    if (requested) { totalUsage = addUsage(totalUsage, usage); onUsage(usage, assistant, {includeReasoning:metadata.includeReasoning}); }
    if (rejected) {
      let repeated = false;
      for (const call of calls) {
        const signature = toolSignature(call);
        if (rejectedRequests.has(signature)) repeated = true;
        rejectedRequests.add(signature);
        const message = append({role:'tool',tool_call_id:call.id,content:JSON.stringify({error:'本次工具调用包含未提供的工具，整批未执行；请仅使用当前可用工具，或直接回答',code:'tool_unavailable',executed:false,batchRejected:true,availableTools:rejected.availableTools,unavailableTools:rejected.unavailableTools})});
        onRecord({type:'tool_result',name:call.function.name,message:copyMessage(message)});
      }
      unavailableAttempts++;
      await checkpoint(); check(signal);
      if (repeated || unavailableAttempts >= MAX_RECOVERY_FAILURES) throw Object.assign(Error('模型反复调用本次未提供的工具，已停止自动继续；这些工具未执行'),{category:'unavailable_tool',incomplete:false,retryable:false,recoveryLimitReached:true,finishReason:'tool_calls',unavailableTools:rejected.unavailableTools,toolCalls:calls,cause:rejection});
      append({role:'user',content:'The previous native tool-call batch was not executed because it requested a tool not available in this request. Available tools: '+JSON.stringify(rejected.availableTools)+'. Continue the original request using only these tools, or answer normally without tools. Tools used in previous turns do not imply access now.'});
      onStatus('模型调用了本次未提供的工具，正在按当前可用范围继续…');
      continue;
    }
    if (failure) {
      if (!signal.aborted && notebook && failure.finishReason === 'length' && failure.toolCalls?.some(call => call.function?.name === 'stage_notebook_edits')) {
        if (!currentNotebook()) {
          if (++unavailableAttempts < MAX_RECOVERY_FAILURES) {
            await checkpoint(); check(signal);
            append({role:'user',content:'The previous Notebook edit argument stream was truncated. None of that incomplete call was executed or staged. The Notebook connection for this turn is no longer available; do not continue Notebook edits or regenerate the unfinished call. Earlier accepted edits remain staged and unapplied. Continue the original question using only these remaining tools, or answer normally in chat: '+JSON.stringify(turnTools(null,webEnabled,images,recommendedBatchTokens).map(tool=>tool.function.name))+'. Current saved task state: '+JSON.stringify(stagingStatus())});
            onStatus('Notebook 连接已失效，未完成的工具请求未执行；正在继续对话…');
            continue;
          }
          failure.recoveryLimitReached = true;
          throw failure;
        }
        const signature = JSON.stringify(failure.toolCalls.map(call => ({name:call.function?.name,arguments:call.function?.arguments})));
        lengthFailures++;
        recommendedBatchTokens = Math.max(MIN_BATCH_TOKENS,Math.floor(recommendedBatchTokens/2));
        if (lengthFailures < MAX_RECOVERY_FAILURES && !truncations.has(signature)) {
          truncations.add(signature);
          const instruction = {role:'user',content:'The previous edit call was truncated and none of its operations were staged. Continue the original requested task using smaller complete JSON batches. Do not concatenate or repair the truncated arguments, or repeat accepted parts. Keep the next batch near or below '+recommendedBatchTokens+' tokens (recommendedBatchTokens). For large new cells or full rewrites use source_chunk; omit totalParts when unknown and end with final:true. Read pendingSource if earlier accepted source must be checked. Current staging state: '+JSON.stringify(stagingStatus())};
          append(instruction); onStatus('代码输出已截断，正在以更小批次继续…'); continue;
        }
        failure.recoveryLimitReached = true;
      }
      throw failure;
    }
    if (protocol.leaked) {
      protocolAttempts++;
      if (calls.length) {
        recoveryPending = false; onProtocolIssue({recovered:true,attempt:protocolAttempts});
      } else {
        const issue = !webEnabled && protocol.webOnly ? 'web_disabled' : 'invalid_tool_protocol';
        onProtocolIssue({recovered:false,attempt:protocolAttempts}); check(signal);
        if (tools.length && !protocolCorrectionUsed && issue !== 'web_disabled') {
          protocolCorrectionUsed = true; recoveryPending = true;
          append({role:'user',content:'The previous response wrote a tool request as ordinary text; it was not executed. Continue the original task using an available native tool call, or give a normal answer. Do not write tool protocol markup in the answer.'});
          continue;
        }
        throw Object.assign(Error(TOOL_PROTOCOL_MESSAGES[issue]),{toolProtocolError:issue});
      }
    } else if (recoveryPending) {
      if (!calls.length && !assistant.content.trim()) {
        onProtocolIssue({recovered:false,attempt:protocolAttempts+1});
        throw Object.assign(Error(TOOL_PROTOCOL_MESSAGES.invalid_tool_protocol),{toolProtocolError:'invalid_tool_protocol'});
      }
      recoveryPending = false; onProtocolIssue({recovered:true,attempt:protocolAttempts});
    }
    if (!calls.length) {
      if (currentNotebook() && !finishPatch()) {
        const status = notebook.status ? notebook.status() : null;
        if (status?.pendingChunks || status?.started) {
          const signature = JSON.stringify(status);
          if (failures.has(signature)) throw Object.assign(Error('Notebook 修改尚未完整收齐，未提供应用操作；请继续生成'),{turnUsage:totalUsage});
          failures.add(signature);
          append({role:'user',content:'The notebook edit task is unfinished. Continue staging the remaining complete operations, then call stage_notebook_edits with done:true. Nothing has been applied. Current staging state: '+signature});
          continue;
        }
      }
      await checkpoint(); check(signal);
      return {usage:totalUsage,patch:finishPatch(),hasText};
    }
    let fatal = null;
    for (const call of calls) {
      if (!fatal && notebook && ['stage_notebook_edits','read_notebook'].includes(call.function.name) && !currentNotebook()) {
        const message = append({role:'tool',tool_call_id:call.id,content:JSON.stringify({error:'本次 Notebook 连接已失效，工具未执行；重新连接后可在下一轮继续',code:'notebook_unavailable',executed:false,applied:false,...stagingStatus()})});
        onRecord({type:'tool_result',name:call.function.name,message:copyMessage(message)});
        continue;
      }
      let result, acceptedProgress = false, noProgress = false;
      try {
        if (fatal) throw fatal;
        check(signal);
        const args = JSON.parse(call.function.arguments);
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('工具参数必须是 JSON 对象');
        if (call.function.name === 'stage_notebook_edits' && notebook) {
          onStatus('正在收集并验证 Notebook 修改…');
          const before = stagingStatus(), status = notebook.stage(args);
          acceptedProgress = stagingProgress(before,status);
          if (acceptedProgress) { lengthFailures = 0; toolFailures = 0; truncations.clear(); }
          try { await checkpoint(); } catch (error) { throw Object.assign(error,{checkpointFailure:true,stageAccepted:true}); }
          result = JSON.stringify({status:'staged_for_review',...status,recommendedBatchTokens,applied:false});
          noProgress = !acceptedProgress;
        } else if (call.function.name === 'read_notebook' && notebook) result = JSON.stringify(readNotebook(notebook,args));
        else if (call.function.name === 'read_image' && images) {
          imageArguments(args);
          let acceptingUsage = true;
          try {
            result = imageResult(await images.execute(args, { onUsage: usage => {
              if (!acceptingUsage) return;
              totalUsage = addUsage(totalUsage, usage);
              onUsage(usage, null, {auxiliary:true,kind:'image'});
            } }));
          } finally { acceptingUsage = false; }
        }
        else if (webEnabled && web && ['search_web','fetch_page'].includes(call.function.name)) result = await web.execute(call.function.name,args);
        else throw Error('工具不可用');
        const signature = toolSignature(call,args);
        const progress = resultProgressKey(call.function.name,result);
        let observed = successfulResults.get(signature);
        if (observed?.has(progress)) {
          const error = Error('工具重复返回相同结果，没有新的进展；请使用已有结果回答，或更改请求');
          if (!['search_web','fetch_page'].includes(call.function.name)) throw error;
          if (failures.has(signature)) fatal ||= error;
          failures.add(signature); onStatus(error.message); noProgress = true;
        }
        if (!observed) { observed = new Set(); successfulResults.set(signature, observed); }
        observed.add(progress);
        if (noProgress) {
          if (++toolFailures >= MAX_RECOVERY_FAILURES) throw Error('工具重复返回相同结果，没有新的进展；请使用已有结果回答，或更改请求');
        } else toolFailures = 0;
      } catch (error) {
        const signature = toolSignature(call);
        if (!noProgress) toolFailures++;
        if (signal.aborted || error.authExpired || error.httpStatus === 402 || error.checkpointFailure || toolFailures >= MAX_RECOVERY_FAILURES || failures.has(signature)) fatal ||= error;
        failures.add(signature);
        result = JSON.stringify({error:error.message,executed:!!error.stageAccepted,...(error.stageAccepted ? {staged:true,applied:false,...stagingStatus()} : {}),...(notebook ? {recommendedBatchTokens} : {})});
      }
      const message = append({role:'tool',tool_call_id:call.id,content:result});
      onRecord({type:'tool_result',name:call.function.name,message:copyMessage(message)});
    }
    if (fatal) throw fatal;
    check(signal);
  } } catch (error) {
    try { await checkpoint(); } catch (checkpointError) { error.checkpointError = checkpointError.message; }
    error.turnUsage = totalUsage; error.stagedPatch = finishPatch(); throw error;
  }
}
module.exports = { notebookTool, readNotebookTool, readImageTool, turnTools, runToolTurn, addUsage, textualToolRequest, TOOL_PROTOCOL_MESSAGES, DEFAULT_BATCH_TOKENS, MIN_BATCH_TOKENS, MAX_RECOVERY_FAILURES };
