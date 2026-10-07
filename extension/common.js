export const URL = 'https://selsup.ru/application/integration/crpt';
export const DEFAULTS = { enabled: false, time: '07:00', delay: 5, timeout: 60,
  organizations: ['ИП Труфанов Вячеслав Федорович', 'Тест FBS'],
  stepEnabled: [true, true, true, true, true], categoryEnabled: true, tokenStatusEnabled: true,
  selectors: ['', '', '', '', ''], categorySelector: '', categoryOptionSelector: '', tokenStatusSelector: '' };
export function validate(s) {
  if (typeof s.enabled !== 'boolean' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) throw Error('Укажите время ЧЧ:ММ.');
  if (!Number.isInteger(s.delay) || s.delay < 1 || s.delay > 60) throw Error('Пауза: от 1 до 60 секунд.');
  if (!Number.isInteger(s.timeout) || s.timeout < 10 || s.timeout > 180) throw Error('Ожидание кнопки: от 10 до 180 секунд.');
  if (!Array.isArray(s.organizations) || s.organizations.length !== 2 || s.organizations.some(x => typeof x !== 'string') || (s.stepEnabled?.[4] !== false && (s.organizations.some(x => !x.trim()) || s.organizations[0] === s.organizations[1]))) throw Error('Нужны два разных названия организаций.');
  if (!Array.isArray(s.selectors) || s.selectors.length !== 5 || s.selectors.some(x => typeof x !== 'string')) throw Error('Некорректные CSS-селекторы.');
  for (const key of ['categorySelector', 'categoryOptionSelector', 'tokenStatusSelector']) if (s[key] !== undefined && typeof s[key] !== 'string') throw Error('Некорректные дополнительные селекторы.');
  const steps = s.stepEnabled ?? DEFAULTS.stepEnabled;
  if (!Array.isArray(steps) || steps.length !== 5 || steps.some(value => typeof value !== 'boolean')) throw Error('Некорректные переключатели шагов.');
  for (const key of ['categoryEnabled', 'tokenStatusEnabled']) if (s[key] !== undefined && typeof s[key] !== 'boolean') throw Error('Некорректные переключатели проверок.');
  if (!steps.some(Boolean) && s.categoryEnabled === false) throw Error('Включите хотя бы одно действие.');
  return { ...s, stepEnabled: [...steps], categoryEnabled: s.categoryEnabled ?? true, tokenStatusEnabled: s.tokenStatusEnabled ?? true };
}
export function nextRun(time, now = new Date()) {
  const [h, m] = time.split(':').map(Number);
  const next = new Date(now); next.setHours(h, m, 0, 0);
  if (next <= now) { next.setDate(next.getDate() + 1); next.setHours(h, m, 0, 0); }
  return next.getTime();
}
export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
