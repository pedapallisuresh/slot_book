// Usage: BASE=http://localhost:3000 VUS=20 SECS=10 node scripts/loadtest.mjs   (start the server with RATE_LIMIT=1000000)
const BASE = process.env.BASE ?? "http://localhost:3000", VUS = +(process.env.VUS ?? 20), SECS = +(process.env.SECS ?? 10);
const ev = await (await fetch(`${BASE}/api/hosts/demo/events/workshop-60`)).json();
const pool = (await (await fetch(`${BASE}/api/hosts/demo/events/workshop-60/slots`)).json()).slots.slice(0, 40);
const lat = [], c = { "201": 0, "409": 0, other: 0 }; const end = Date.now() + SECS * 1000;
await Promise.all(Array.from({ length: VUS }, async () => { while (Date.now() < end) {
  const s = pool[Math.floor(Math.random() * pool.length)], t = performance.now();
  try { const r = await fetch(`${BASE}/api/holds`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ eventTypeId: ev.id, start: s.start }) });
    lat.push(performance.now() - t); r.status === 201 ? c["201"]++ : r.status === 409 ? c["409"]++ : c.other++; } catch { c.other++; } } }));
lat.sort((a, b) => a - b); const n = lat.length, p = q => lat[Math.min(n - 1, Math.floor(n * q))].toFixed(1);
console.log(JSON.stringify({ vus: VUS, secs: SECS, requests: n, rps: +(n / SECS).toFixed(1), p50_ms: +p(.5), p95_ms: +p(.95), p99_ms: +p(.99), created_201: c["201"], rejected_409: c["409"], unexpected_errors: c.other, unexpected_error_rate: +(c.other / n).toFixed(4) }, null, 1));
