const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function parseQuiet(text) {
  if (!text?.trim()) return null;
  const parts = text.trim().split('-').map((p) => p.trim());
  const times = parts.map((p) => TIME.exec(p));
  if (parts.length !== 2 || times.some((t) => !t)) throw new Error(`quiet hours should look like 22:00-07:00, not "${text}"`);
  const [from, to] = times.map((t) => Number(t[1]) * 60 + Number(t[2]));
  if (from === to) throw new Error('quiet hours need a different start and end');
  return { from, to };
}

export function isQuiet(range, date = new Date()) {
  if (!range) return false;
  const minute = date.getHours() * 60 + date.getMinutes();
  return range.from < range.to ? minute >= range.from && minute < range.to : minute >= range.from || minute < range.to;
}
