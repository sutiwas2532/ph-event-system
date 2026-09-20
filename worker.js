export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
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
