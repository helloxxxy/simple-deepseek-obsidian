const test = require('node:test');
const assert = require('node:assert/strict');
const {advance,TextPacer} = require('./src/pacing');

test('unlimited advancement checks only the tail instead of scanning a large received burst', t => {
  const text = 'A🌱中文\n'.repeat(100000);
  const originalPoint = String.prototype.codePointAt, originalUnit = String.prototype.charCodeAt;
  let units = 0, points = 0;
  String.prototype.codePointAt = function(index) { points++; return originalPoint.call(this,index); };
  String.prototype.charCodeAt = function(index) { units++; return originalUnit.call(this,index); };
  t.after(() => { String.prototype.codePointAt = originalPoint; String.prototype.charCodeAt = originalUnit; });
  assert.deepEqual(advance(text,0,Infinity),{end:text.length,credit:Infinity});
  assert.equal(points,0); assert.ok(units <= 1,'unlimited display should perform constant work per burst');
});

test('unlimited advancement preserves complete Unicode and holds only an unfinished trailing surrogate', () => {
  for (const text of ['', 'ASCII', '🌱中文', '\ud83c', 'A\ud83c', 'A\ud83c\udf31', 'A\udf31']) {
    for (const ended of [false,true]) {
      const tail = text.charCodeAt(text.length-1), held = !ended && tail >= 0xd800 && tail <= 0xdbff;
      for (const start of [0,text.length]) assert.deepEqual(advance(text,start,Infinity,ended),{end:Math.max(start,text.length-(held ? 1 : 0)),credit:Infinity});
    }
  }
  assert.equal(advance('🌱',0,0.5,true).end,0);
  assert.equal(advance('🌱',0,0.6,true).end,2);
});

test('unlimited incremental playback keeps split Unicode intact and emits later arrivals exactly once', async () => {
  const frames = [], controller = new AbortController(); let slept = 0;
  const pacer = new TextPacer({incremental:true,getRate:() => 0,signal:controller.signal,
    sleep:async () => { slept++; pacer.push('\udf31 next'); pacer.finish(); },
    onFrame:chunk => frames.push(chunk)});
  pacer.push('First \ud83c'); await pacer.run();
  assert.deepEqual(frames,['First ','🌱 next']); assert.equal(slept,1);
});
