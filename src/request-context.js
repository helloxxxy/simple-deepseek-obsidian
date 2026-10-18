function requestTimeContext({ now = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const date = new Date(now);
  const currentTime = date.toISOString();
  let formatter;
  try {
    if (typeof timeZone !== 'string' || !timeZone.trim()) throw new RangeError('Invalid time zone');
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return '\n\n[Request context]\n' + JSON.stringify({ current_time: currentTime, local_date: parts.year.padStart(4, '0') + '-' + parts.month + '-' + parts.day, time_zone: formatter.resolvedOptions().timeZone });
}
module.exports = { requestTimeContext };
