// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createHandler } from '../api/handler.js';
import { maskNoteEmails } from '../api/privacy.js';

const VIEW = { person: { id: 'I1' }, family: [], relationships: { parents: [], spouses: [], children: [], siblings: [] } };
const call = (handler, path, method = 'GET') => handler(new Request(`https://api.test${path}`, { method }));

describe('api handler', () => {
  it('returns a person view with caching and CORS headers', async () => {
    const query = vi.fn().mockResolvedValue(VIEW);
    const res = await call(createHandler(query), '/person/I1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VIEW);
    expect(query).toHaveBeenCalledWith('I1');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  it('returns 404 for an unknown person', async () => {
    const res = await call(createHandler(vi.fn().mockResolvedValue(null)), '/person/I999');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects malformed ids without querying', async () => {
    const query = vi.fn();
    const res = await call(createHandler(query), '/person/' + encodeURIComponent('I1; drop table'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_id' });
    expect(query).not.toHaveBeenCalled();
  });

  it('answers health checks, unknown routes and preflight', async () => {
    const handler = createHandler(vi.fn());
    expect(await (await call(handler, '/health')).json()).toEqual({ ok: true });
    expect((await call(handler, '/nope')).status).toBe(404);
    expect((await call(handler, '/person/I1', 'POST')).status).toBe(404);
    const preflight = await call(handler, '/person/I1', 'OPTIONS');
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('returns 500 and logs when the query fails', async () => {
    const log = vi.fn();
    const res = await createHandler(vi.fn().mockRejectedValue(new Error('boom')), { log })(new Request('https://api.test/person/I1'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(log).toHaveBeenCalled();
  });
});

describe('email masking', () => {
  const person = {
    id: 'I1', email: 'keep@example.com', birthPlace: 'x@y.com',
    notes: ['From: Jo <jo.smith@example.co.uk>\nSent: Monday'],
    deathNotes: ['mail a.b@c.org'],
    censusRecords: [{ date: '1851', notes: ['c@d.net and e@f.io'] }],
    otherFacts: [{ tag: 'EVEN', value: 'v@w.com', notes: ['g@h.com'] }]
  };
  const view = { person, family: [{ id: 'I2', name: 'n@o.com' }], relationships: { parents: [], spouses: [], children: [], siblings: [] } };

  it('masks addresses in note text only', async () => {
    const res = await call(createHandler(vi.fn().mockResolvedValue(view)), '/person/I1');
    const body = await res.json();
    expect(body.person).toEqual({
      ...person,
      notes: ['From: Jo <[email hidden]>\nSent: Monday'],
      deathNotes: ['mail [email hidden]'],
      censusRecords: [{ date: '1851', notes: ['[email hidden] and [email hidden]'] }],
      otherFacts: [{ tag: 'EVEN', value: 'v@w.com', notes: ['[email hidden]'] }]
    });
    expect(body.family).toEqual(view.family);
  });

  it('does not modify its input', () => {
    const copy = structuredClone(view);
    maskNoteEmails(view);
    expect(view).toEqual(copy);
  });
});
