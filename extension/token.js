// SelSup displays this timestamp in the browser's local timezone.
globalThis.SelSupToken = {
  parse(text) {
    const m = text.trim().match(/^Токен\s+успешно\s+получен\s*:\s*(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/iu);
    if (!m) return null;
    const [day, month, year, hour, minute, second] = m.slice(1).map(Number);
    const d = new Date(year, month - 1, day, hour, minute, second);
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day || d.getHours() !== hour || d.getMinutes() !== minute || d.getSeconds() !== second) return null;
    return d.getTime();
  },
  fresh(timestamp, now = Date.now()) { return timestamp !== null && Math.abs(timestamp - now) <= 5 * 60 * 1000; }
};
