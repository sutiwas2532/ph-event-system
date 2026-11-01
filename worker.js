import { DurableObject } from 'cloudflare:workers';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/poll' || url.pathname.startsWith('/api/poll/')) {
      return handlePoll(request, env, url);
    }
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const resource = parts[0];
    const kv = env.PHC_KV;
    const qs = url.searchParams;
    const eventId = qs.get('event');
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors } });
    if (!kv) return json({ error: 'ยังไม่ได้ผูก KV namespace ชื่อ PHC_KV' }, 500);
    const evKey = (s) => `event:${eventId}:${s}`;
    const needEvent = () => { if (!eventId) return json({ error: 'missing ?event=<id>' }, 400); return null; };
    async function ensureMigrated() {
      const existing = await kv.get('events');
      if (existing !== null) return;
      const legacySettings = await kv.get('settings');
      if (!legacySettings) { await kv.put('events', JSON.stringify([])); return; }
      const s = JSON.parse(legacySettings);
      const id = 'E' + Date.now().toString(36).toUpperCase();
      const rec = { id, name: s.name || 'งานเดิม', date: s.date || '', venue: s.venue || '', createdAt: new Date().toISOString() };
      await kv.put('events', JSON.stringify([rec]));
      await kv.put(`event:${id}:settings`, legacySettings);
      const legacyHist = await kv.get('history');
      if (legacyHist) await kv.put(`event:${id}:history`, legacyHist);
      const attList = await kv.list({ prefix: 'att:' });
      await Promise.all(attList.keys.map(async k => { const v = await kv.get(k.name); if (v) await kv.put(`event:${id}:${k.name}`, v); }));
    }
    try {
      if (resource === 'ping') return json({ ok: true, ready: true });
      if (resource === 'pin') {
        if (request.method === 'GET') { const v = await kv.get('admin_pin'); return json({ pin: v || '1234' }); }
        if (request.method === 'POST') { const body = await request.json(); await kv.put('admin_pin', String(body.pin || '1234')); return json({ ok: true }); }
      }
      if (resource === 'events') {
        if (request.method === 'GET') { await ensureMigrated(); const v = await kv.get('events'); return json(v ? JSON.parse(v) : []); }
        if (request.method === 'POST') {
          const body = await request.json();
          const v = await kv.get('events'); const list = v ? JSON.parse(v) : [];
          const id = body.id || ('E' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase());
          const rec = { id, name: body.name || 'งานใหม่', date: body.date || '', venue: body.venue || '', createdAt: new Date().toISOString() };
          list.unshift(rec); await kv.put('events', JSON.stringify(list));
          const defSettings = { name: rec.name, date: rec.date, venue: rec.venue, sub: '', org: '', hook: '', agenda: [], logo: '' };
          await kv.put(`event:${id}:settings`, JSON.stringify(defSettings));
          return json(rec);
        }
        if (request.method === 'DELETE') {
          const id = qs.get('id'); if (!id) return json({ error: 'missing id' }, 400);
          const v = await kv.get('events'); const list = (v ? JSON.parse(v) : []).filter(e => e.id !== id);
          await kv.put('events', JSON.stringify(list));
          const attList = await kv.list({ prefix: `event:${id}:att:` });
          await Promise.all(attList.keys.map(k => kv.delete(k.name)));
          await kv.delete(`event:${id}:settings`); await kv.delete(`event:${id}:history`);
          return json({ ok: true });
        }
      }
      if (resource === 'events-summary' && request.method === 'GET') {
        await ensureMigrated();
        const v = await kv.get('events'); const list = v ? JSON.parse(v) : [];
        const out = await Promise.all(list.map(async (e) => {
          const attList = await kv.list({ prefix: `event:${e.id}:att:` });
          const vals = await Promise.all(attList.keys.map(k => kv.get(k.name)));
          const atts = vals.filter(Boolean).map(s => JSON.parse(s));
          return { ...e, total: atts.length, checked: atts.filter(a => a.in).length };
        }));
        return json(out);
      }
      if (resource === 'contacts') {
        if (request.method === 'GET') { const v = await kv.get('contacts'); return json(v ? JSON.parse(v) : []); }
        if (request.method === 'POST') { const body = await request.json(); await kv.put('contacts', JSON.stringify(body || [])); return json({ ok: true }); }
      }
      if (resource === 'settings') {
        const miss = needEvent(); if (miss) return miss;
        if (request.method === 'GET') { const v = await kv.get(evKey('settings')); return json(v ? JSON.parse(v) : null); }
        if (request.method === 'POST') {
          const body = await request.json(); await kv.put(evKey('settings'), JSON.stringify(body));
          const v = await kv.get('events'); const list = v ? JSON.parse(v) : [];
          const idx = list.findIndex(e => e.id === eventId);
          if (idx > -1) { list[idx] = { ...list[idx], name: body.name || list[idx].name, date: body.date || list[idx].date, venue: body.venue || list[idx].venue }; await kv.put('events', JSON.stringify(list)); }
          return json({ ok: true });
        }
      }
      if (resource === 'attendees') {
        const miss = needEvent(); if (miss) return miss;
        if (request.method === 'GET') { const list = await kv.list({ prefix: evKey('att:') }); const vals = await Promise.all(list.keys.map(k => kv.get(k.name))); return json(vals.filter(Boolean).map(s => JSON.parse(s))); }
        if (request.method === 'POST') { const body = await request.json(); if (!body || !body.id) return json({ error: 'missing id' }, 400); await kv.put(evKey('att:' + body.id), JSON.stringify(body)); return json({ ok: true }); }
        if (request.method === 'DELETE') { const id = qs.get('id'); if (!id) return json({ error: 'missing id' }, 400); await kv.delete(evKey('att:' + id)); return json({ ok: true }); }
      }
      if (resource === 'history') {
        const miss = needEvent(); if (miss) return miss;
        if (request.method === 'GET') { const v = await kv.get(evKey('history')); return json(v ? JSON.parse(v) : []); }
        if (request.method === 'POST') { const body = await request.json(); await kv.put(evKey('history'), JSON.stringify(body || [])); return json({ ok: true }); }
      }
      if (resource === 'archive' && request.method === 'POST') {
        const miss = needEvent(); if (miss) return miss;
        const body = await request.json();
        const hv = await kv.get(evKey('history')); const hist = hv ? JSON.parse(hv) : [];
        hist.unshift(body.historyEntry); await kv.put(evKey('history'), JSON.stringify(hist));
        const cv = await kv.get('contacts'); const contacts = cv ? JSON.parse(cv) : [];
        await kv.put('contacts', JSON.stringify(body.contacts || contacts));
        const list = await kv.list({ prefix: evKey('att:') });
        await Promise.all(list.keys.map(k => kv.delete(k.name)));
        return json({ ok: true });
      }
      if (resource === 'clear-attendees' && request.method === 'POST') {
        const miss = needEvent(); if (miss) return miss;
        const list = await kv.list({ prefix: evKey('att:') });
        await Promise.all(list.keys.map(k => kv.delete(k.name)));
        return json({ ok: true });
      }
      if (resource === 'wipe-all' && request.method === 'POST') {
        const miss = needEvent(); if (miss) return miss;
        const list = await kv.list({ prefix: evKey('att:') });
        await Promise.all(list.keys.map(k => kv.delete(k.name)));
        await kv.delete(evKey('history'));
        return json({ ok: true });
      }
      return json({ error: 'not found: ' + resource }, 404);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500);
    }
  }
};

/* ===================== LIVE POLL (Durable Object) =====================
   Routes (all accept ?poll=<id>, default "default"):
   GET  /api/poll/state[?role=screen]      current state snapshot
   GET  /api/poll/ws?role=screen|aud        WebSocket push of state + live counts
   POST /api/poll/vote    {q, choice, voter, round}
   POST /api/poll/check   {pin}             presenter PIN check (same PIN as admin)
   POST /api/poll/control {pin, action:'set'|'reset'|'clearq', idx, phase}
*/
const POLL_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store'
};
const pollJson = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...POLL_CORS } });

async function handlePoll(request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: POLL_CORS });
  if (!env.POLL_ROOM) return pollJson({ error: 'POLL_ROOM binding is missing (check wrangler.jsonc)' }, 500);
  const poll = (url.searchParams.get('poll') || 'default').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'default';
  const stub = env.POLL_ROOM.get(env.POLL_ROOM.idFromName(poll));
  return stub.fetch(request);
}

const POLL_PHASES = ['lobby', 'question', 'results', 'reveal', 'end'];

export class PollRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS votes (
      q INTEGER NOT NULL, voter TEXT NOT NULL, choice INTEGER NOT NULL, ts INTEGER NOT NULL,
      PRIMARY KEY (q, voter))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.timers = { screen: null, aud: null };
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch (e) {}
  }

  getState() {
    const row = this.sql.exec(`SELECT v FROM meta WHERE k = 'state'`).toArray()[0];
    return row ? JSON.parse(row.v) : { idx: 0, phase: 'lobby', round: 'r1', rev: 0 };
  }
  setState(s) {
    this.sql.exec(`INSERT INTO meta (k, v) VALUES ('state', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, JSON.stringify(s));
  }
  allCounts() {
    const out = {};
    for (const r of this.sql.exec(`SELECT q, choice, COUNT(*) AS c FROM votes GROUP BY q, choice`)) {
      const arr = out[r.q] || (out[r.q] = []);
      arr[r.choice] = r.c;
    }
    for (const k of Object.keys(out)) out[k] = Array.from(out[k], v => v || 0);
    return out;
  }
  snapshot(role) {
    const s = this.getState();
    const all = this.allCounts();
    const cur = all[s.idx] || [];
    const total = cur.reduce((a, b) => a + b, 0);
    const base = {
      t: 'state', idx: s.idx, phase: s.phase, round: s.round, rev: s.rev, total,
      joined: this.ctx.getWebSockets('aud').length, ts: Date.now()
    };
    if (role === 'screen') return { ...base, counts: cur, all };
    if (s.phase === 'results' || s.phase === 'reveal') return { ...base, counts: cur };
    return base;
  }
  broadcast(target) {
    const msgs = {};
    for (const ws of this.ctx.getWebSockets()) {
      const role = this.ctx.getTags(ws).includes('screen') ? 'screen' : 'aud';
      if (target && target !== role) continue;
      if (!msgs[role]) msgs[role] = JSON.stringify(this.snapshot(role));
      try { ws.send(msgs[role]); } catch (e) {}
    }
  }
  // Throttled push after votes / joins: presenter every 250 ms, audience every 1 s (only when results are showing)
  schedule(role, ms) {
    if (this.timers[role]) return;
    this.timers[role] = setTimeout(() => { this.timers[role] = null; this.broadcast(role); }, ms);
  }
  afterActivity() {
    this.schedule('screen', 250);
    if (this.getState().phase === 'results') this.schedule('aud', 1000);
  }
  async pinOk(pin) {
    let real = '1234';
    try { real = (await this.env.PHC_KV.get('admin_pin')) || '1234'; } catch (e) {}
    return String(pin || '') === String(real);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const op = url.pathname.replace(/^\/api\/poll\/?/, '');
    try {
      if (op === 'ws') {
        if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
        const role = url.searchParams.get('role') === 'screen' ? 'screen' : 'aud';
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server, [role]);
        server.send(JSON.stringify(this.snapshot(role)));
        if (role === 'aud') this.schedule('screen', 250);
        return new Response(null, { status: 101, webSocket: client });
      }
      if (op === 'state' && request.method === 'GET') {
        return pollJson(this.snapshot(url.searchParams.get('role') === 'screen' ? 'screen' : 'aud'));
      }
      if (op === 'vote' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const s = this.getState();
        const q = Number(b.q), choice = Number(b.choice);
        const voter = String(b.voter || '').slice(0, 64);
        if (!Number.isInteger(q) || !Number.isInteger(choice) || choice < 0 || choice > 9 || voter.length < 6) {
          return pollJson({ ok: false, error: 'bad_request' }, 400);
        }
        if (b.round && b.round !== s.round) return pollJson({ ok: false, error: 'stale_round', state: this.snapshot('aud') }, 409);
        if (!(s.phase === 'question' || s.phase === 'results') || q !== s.idx) {
          return pollJson({ ok: false, error: 'closed', state: this.snapshot('aud') }, 409);
        }
        this.sql.exec(`INSERT INTO votes (q, voter, choice, ts) VALUES (?, ?, ?, ?)
          ON CONFLICT(q, voter) DO UPDATE SET choice = excluded.choice, ts = excluded.ts`, q, voter, choice, Date.now());
        this.afterActivity();
        return pollJson({ ok: true, q, choice, round: s.round });
      }
      if (op === 'check' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        return pollJson({ ok: await this.pinOk(b.pin) });
      }
      if (op === 'control' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        if (!(await this.pinOk(b.pin))) return pollJson({ ok: false, error: 'bad_pin' }, 403);
        const s = this.getState();
        if (b.action === 'set') {
          const idx = Number(b.idx);
          if (!Number.isInteger(idx) || idx < 0 || idx > 49 || !POLL_PHASES.includes(b.phase)) {
            return pollJson({ ok: false, error: 'bad_request' }, 400);
          }
          s.idx = idx; s.phase = b.phase;
        } else if (b.action === 'reset') {
          this.sql.exec(`DELETE FROM votes`);
          s.idx = 0; s.phase = 'lobby'; s.round = 'r' + Date.now().toString(36);
        } else if (b.action === 'clearq') {
          const q = Number(b.idx);
          if (Number.isInteger(q)) this.sql.exec(`DELETE FROM votes WHERE q = ?`, q);
        } else {
          return pollJson({ ok: false, error: 'unknown_action' }, 400);
        }
        s.rev = (s.rev || 0) + 1;
        this.setState(s);
        this.broadcast();
        return pollJson({ ok: true, ...this.snapshot('screen') });
      }
      return pollJson({ error: 'not found' }, 404);
    } catch (err) {
      return pollJson({ error: String(err && err.message ? err.message : err) }, 500);
    }
  }

  webSocketMessage(ws, msg) {
    if (msg === 'ping') { try { ws.send('pong'); } catch (e) {} }
  }
  webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch (e) {}
    this.schedule('screen', 250);
  }
  webSocketError() {
    this.schedule('screen', 250);
  }
}
