const test = require('node:test');
const assert = require('node:assert/strict');
const {TurnContext} = require('./src/turn-context');

function context(options = {}) {
  let reads = 0;
  const client = {connected:true,closed:false,read:() => {reads++;return {cells:[{id:'original',source:'Original notebook'}]};}};
  const state = {client,identity:'original-path',epoch:1};
  const input = {session:{messages:[]},model:'deepseek-flash',reasoningEffort:'max',webEnabled:true,imagesEnabled:false,notebookMode:true,notebookSendMode:'delta',notebookClient:client,notebookIdentity:state.identity,notebookEpoch:state.epoch,currentNotebook:() => state,...options};
  const turn = new TurnContext(input);
  return {turn,state,input,client,get reads(){return reads;}};
}

test('a turn freezes its configuration while preserving the original session identity',()=>{
  const {turn,input}=context();input.webEnabled=false;input.model='changed';input.notebookSendMode='none';
  assert.equal(turn.webEnabled,true);assert.equal(turn.model,'deepseek-flash');assert.equal(turn.notebookSendMode,'delta');assert.equal(Object.isFrozen(turn),true);
  turn.session.messages.push({role:'user',content:'Append only'});assert.equal(input.session.messages.length,1);
});

test('a newly connected Notebook cannot join a turn that began without access',()=>{
  for(const options of [{notebookClient:null},{notebookMode:false},{notebookSendMode:'none'},{notebookClient:{connected:false}}]){
    const f=context(options);assert.equal(f.turn.notebookAvailable,false);f.state.client=f.client;f.client.connected=true;assert.equal(f.turn.notebookAvailable,false);assert.equal(f.turn.readNotebook(),null);assert.equal(f.reads,0);
  }
});

test('disconnect path change and client replacement revoke the Notebook for the rest of one turn',()=>{
  for(const mutate of [f=>f.state.epoch++,f=>f.state.identity='new-path',f=>f.state.client={...f.client},f=>f.client.closed=true,f=>f.client.connected=false]){
    const f=context({webEnabled:false});assert.equal(f.turn.includeReasoning,true);assert.equal(f.turn.readNotebook().cells[0].id,'original');mutate(f);
    assert.equal(f.turn.notebookAvailable,false);assert.equal(f.turn.includeReasoning,false);Object.assign(f.state,{client:f.client,identity:'original-path',epoch:1});Object.assign(f.client,{closed:false,connected:true});
    assert.equal(f.turn.readNotebook(),null);assert.equal(f.reads,1);assert.equal(f.turn.notebookAvailable,false);
  }
});

test('a failed Notebook read revokes only that resource and cannot touch a replacement client',()=>{
  const f=context();f.client.read=()=>{throw Error('Connection closed');};assert.equal(f.turn.readNotebook(),null);f.state.client={connected:true,read:()=>assert.fail('The replacement belongs to a new turn')};assert.equal(f.turn.readNotebook(),null);assert.equal(f.turn.webEnabled,true);assert.equal(f.turn.includeReasoning,true);
});
