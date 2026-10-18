const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requestTimeContext } = require('./src/request-context');
const parse = value => JSON.parse(value.slice('\n\n[Request context]\n'.length));

test('request time metadata uses UTC instants and local calendar dates across day boundaries', () => {
  const now = Date.parse('2026-10-17T00:30:00.123Z');
  assert.deepEqual(parse(requestTimeContext({ now, timeZone: 'Asia/Shanghai' })), { current_time: '2026-10-17T00:30:00.123Z', local_date: '2026-10-17', time_zone: 'Asia/Shanghai' });
  assert.deepEqual(parse(requestTimeContext({ now, timeZone: 'America/Los_Angeles' })), { current_time: '2026-10-17T00:30:00.123Z', local_date: '2026-10-16', time_zone: 'America/Los_Angeles' });
  assert.equal(parse(requestTimeContext({ now: Date.parse('2026-12-31T23:30:00Z'), timeZone: 'Asia/Shanghai' })).local_date, '2027-01-01');
});

test('invalid or missing time zones fall back to an explicitly labeled UTC date', () => {
  for (const timeZone of ['not/a_zone', '', null, 42]) {
    assert.deepEqual(parse(requestTimeContext({ now: Date.parse('2026-10-17T23:30:00Z'), timeZone })), { current_time: '2026-10-17T23:30:00.000Z', local_date: '2026-10-17', time_zone: 'UTC' });
  }
});

test('request timestamps append only to a new user message without changing the cached prefix', () => {
  const firstTime = requestTimeContext({ now: Date.parse('2026-10-17T00:00:00Z'), timeZone: 'UTC' });
  const secondTime = requestTimeContext({ now: Date.parse('2026-10-17T01:00:00Z'), timeZone: 'UTC' });
  const first = [{ role: 'system', content: 'Stable instructions.' }, { role: 'user', content: 'First question' + firstTime }];
  const prefix = JSON.stringify(first), next = [...first, { role: 'assistant', content: 'First answer.' }, { role: 'user', content: 'Next question' + secondTime }];
  assert.equal(JSON.stringify(next.slice(0, first.length)), prefix);
  assert.equal(next.at(-1).content, 'Next question' + secondTime);
  assert.notEqual(firstTime, secondTime);
});
