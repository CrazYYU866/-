// Проверка Redis-адаптера Socket.IO на двух экземплярах API (этап 13).
// Запуск на демо-данных: два экземпляра API на :3000 и :3001 с общими БД и Redis, затем
//   node scripts/realtime-check.cjs <папка с логами api.log и api2.log> (коды SMS берутся из логов тестового провайдера).
const { io } = require('socket.io-client');
const fs = require('fs');
const [, , S] = process.argv;
const A = 'http://localhost:3000', B = 'http://localhost:3001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const code = (phone) => { const all = fs.readFileSync(`${S}/api.log`, 'utf8') + fs.readFileSync(`${S}/api2.log`, 'utf8'); const m = [...all.matchAll(new RegExp(`DEV SMS\\] \\${phone}: .*?(\\d{6})`, 'g'))]; return m.at(-1)?.[1]; };
async function call(base, method, path, token, body, org) {
  const h = { 'content-type': 'application/json' }; if (token) h.authorization = `Bearer ${token}`; if (org) h['x-org-id'] = org;
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t}`); return t ? JSON.parse(t) : null;
}
async function login(base, phone, app) {
  await call(base, 'POST', '/auth/otp/request', null, { phone, app }); await sleep(400);
  return (await call(base, 'POST', '/auth/otp/verify', null, { phone, app, code: code(phone) })).accessToken;
}
const connect = (base, token) => new Promise((res, rej) => { const s = io(`${base}/ws`, { auth: { token }, transports: ['websocket'], forceNew: true }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
const waitFor = (s, ev, pred = () => true, ms = 5000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`нет события ${ev}`)), ms); s.on(ev, (d) => { if (pred(d)) { clearTimeout(t); res(d); } }); });
(async () => {
  const results = [];
  const cust = await login(A, '+79000000601', 'client');
  const op = await login(B, '+79000000302', 'partner');
  const order = (await call(A, 'GET', '/client/orders', cust)).find((o) => o.number === 100002);
  const org = (await call(B, 'GET', '/partner/memberships', op))[0].orgId;
  // Заказчик подключён к экземпляру B, машинист — к экземпляру A.
  const sc = await connect(B, cust); const so = await connect(A, op);
  results.push(['подписка на заказ через B', (await sc.emitWithAck('subscribe_order', { orderId: order.id })).ok]);
  results.push(['подписка на заказ через A', (await so.emitWithAck('subscribe_order', { orderId: order.id })).ok]);
  // 1. Чат: машинист пишет через HTTP экземпляра A → заказчик на B получает.
  let w = waitFor(sc, 'chat.message', (m) => m.body === 'Проверка A→B');
  await call(A, 'POST', `/partner/operator/orders/${order.id}/chat`, op, { body: 'Проверка A→B' }, org);
  results.push(['чат A → клиент на B', (await w).body === 'Проверка A→B']);
  // 2. Чат обратно: заказчик пишет через B → машинист на A получает.
  w = waitFor(so, 'chat.message', (m) => m.body === 'Проверка B→A');
  await call(B, 'POST', `/client/orders/${order.id}/chat`, cust, { body: 'Проверка B→A' });
  results.push(['чат B → клиент на A', (await w).body === 'Проверка B→A']);
  // 3. GPS: машинист отправляет координаты через A → заказчик на B видит обновление.
  w = waitFor(sc, 'tracking.update');
  await call(A, 'POST', '/partner/operator/locations', op, { orderId: order.id, points: [{ lat: 55.74, lng: 37.62, recordedAt: new Date().toISOString() }] }, org);
  results.push(['GPS через A → клиент на B', Math.abs((await w).lat - 55.74) < 1e-6]);
  // 4. Личное уведомление (комната пользователя): событие чата создаёт уведомление заказчику — доставляется на B.
  w = waitFor(sc, 'notification');
  await call(A, 'POST', `/partner/operator/orders/${order.id}/chat`, op, { body: 'Уведомление' }, org);
  results.push(['уведомление пользователю на B', Boolean((await w).title)]);
  sc.disconnect(); so.disconnect();
  for (const [name, ok] of results) console.log(`${ok ? 'OK ' : 'FAIL'} ${name}`);
  process.exit(results.every(([, ok]) => ok) ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
