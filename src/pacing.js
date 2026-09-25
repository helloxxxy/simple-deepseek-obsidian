const {check,pause}=require('./core');
const FRAME_MS=16;
// Display-only approximation. Never used to change API messages or billed usage.
function charCost(codePoint){return codePoint<128?0.3:0.6;}
function advance(text,start,credit,ended=false){
  let end=start;
  while(end<text.length){
    const first=text.charCodeAt(end);
    if(!ended&&end===text.length-1&&first>=0xd800&&first<=0xdbff)break;
    const point=text.codePointAt(end),cost=charCost(point);
    if(cost>credit+1e-9)break;
    credit-=cost;end+=point>0xffff?2:1;
  }
  return{end,credit};
}
class TextPacer{
  constructor({getRate,onFrame,signal,now=()=>Date.now(),sleep=pause,incremental=false,frameMs=FRAME_MS}){
    this.getRate=getRate;this.onFrame=onFrame;this.signal=signal;this.now=now;this.sleep=sleep;
    this.incremental=incremental;this.frameMs=frameMs;this.text='';this.shown=0;this.ended=false;this.unlimited=false;this.credit=0;this.wake=null;
  }
  push(delta){check(this.signal);this.text+=delta;this.wake?.();}
  finish(){this.ended=true;this.wake?.();}
  skip(){this.unlimited=true;this.wake?.();}
  get pending(){return this.shown<this.text.length;}
  changed(){
    return new Promise((resolve,reject)=>{
      try{check(this.signal);}catch(e){reject(e);return;}
      const cleanup=()=>{this.wake=null;this.signal?.removeEventListener('abort',abort);};
      const abort=()=>{cleanup();try{check(this.signal);}catch(e){reject(e);}};
      this.wake=()=>{cleanup();resolve();};this.signal?.addEventListener('abort',abort,{once:true});
    });
  }
  async run(){
    let last=this.now();
    while(true){
      check(this.signal);
      if(!this.pending){if(this.ended)return;this.credit=0;await this.changed();last=this.now();continue;}
      const rate=Number(this.getRate());
      let next=this.shown;
      if(this.unlimited||rate===0){next=advance(this.text,this.shown,Infinity,this.ended).end;}
      else{
        const time=this.now();this.credit+=Math.max(1,rate)*Math.min(this.frameMs,Math.max(0,time-last))/1000;last=time;
        const step=advance(this.text,this.shown,this.credit,this.ended);next=step.end;this.credit=step.credit;
      }
      if(next>this.shown){
        const previous=this.shown;
        this.shown=next;
        await this.onFrame(this.text.slice(this.incremental?previous:0,next));check(this.signal);
        // Slow renders cannot build up credits and cause a burst on the next frame.
        last=this.now();
      }
      if(!this.pending&&this.ended)return;
      if(this.pending)await this.sleep(this.frameMs,this.signal);
    }
  }
}
module.exports={TextPacer,advance,charCost,FRAME_MS};
