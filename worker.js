/**
 * Thesis CRM — Cloudflare Worker
 *
 * Endpoints:
 *   POST /generate-link          { total, advance } → logs link, returns { link }
 *   GET  /f/:token               → redirects to form.html with token
 *   POST /submit                 { token, name, phone, address, thesis } → creates Ticket, returns { success, trackerLink }
 *   GET  /lookup?phone=          → finds ticket by phone, returns ticket + payments
 *   GET  /ticket?token=          → fetches specific ticket + payments by tracker token
 *   POST /ticket/stage           { token, pin, stage } → updates Order Status (admin only)
 *   GET  /ticket/comments?token= → fetches comments for a ticket
 *   POST /ticket/comment         { token, message, pin?, clientName? } → posts a comment
 */

const BASE_ID      = 'appXfVVzb9jzX3jmx';
const WORKER_BASE  = 'https://thesis-crm-worker.srijancrm.workers.dev';
const PAGES_BASE   = 'https://srijan908.github.io/thesis-crm-tools';
const VALID_STAGES = ['Intake', 'Introduction and Literature Review', 'Data Analysis and Results', 'Discussion Conclusion Summary', 'Revision', 'Delivered', 'Closed'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function airtable(env, table, params = '', options = {}) {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(table)}${params}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return res.json();
}

async function airtableComments(env, recordId, options = {}) {
  const url = `https://api.airtable.com/v0/${BASE_ID}/Tickets/${recordId}/comments`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  return res.json();
}

function digitsOnly(str) { return str.replace(/\D/g, ''); }
function selectName(f)   { return f ? (typeof f === 'object' ? f.name : f) : null; }

// ── Pricing token (for /f/ short links) ─────────────────────────────────────
function makeToken(total, advance) {
  return btoa(`${total}:${advance}`).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function parseToken(token) {
  try {
    const b64 = token.replace(/-/g,'+').replace(/_/g,'/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - b64.length % 4);
    const decoded = atob(b64 + pad);
    const [total, advance] = decoded.split(':').map(Number);
    if (!total || !advance || isNaN(total) || isNaN(advance)) return null;
    return { total, advance };
  } catch { return null; }
}

// ── Tracker token (encodes Airtable record ID opaquely) ──────────────────────
function makeTicketToken(recordId) {
  return btoa(recordId).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function parseTicketToken(token) {
  try {
    const b64 = token.replace(/-/g,'+').replace(/_/g,'/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - b64.length % 4);
    const decoded = atob(b64 + pad);
    if (!decoded.startsWith('rec')) return null;
    return decoded;
  } catch { return null; }
}

// ── Shared ticket + payments fetcher ────────────────────────────────────────
async function fetchTicketData(env, recordId) {
  const ticketRes = await airtable(env, 'Tickets', `/${recordId}`);
  if (ticketRes.error) return null;

  const f = ticketRes.fields;
  const paymentLinks = f['Payments'] || [];
  let payments = [];

  if (paymentLinks.length > 0) {
    const ids = paymentLinks.map(p => typeof p === 'object' ? p.id : p);
    const orFormula = encodeURIComponent(`OR(${ids.map(id => `RECORD_ID()='${id}'`).join(',')})`);
    const payResult = await airtable(env, 'Payments', `?filterByFormula=${orFormula}`);
    payments = (payResult.records || []).map(r => ({
      milestone: selectName(r.fields['Milestone Name']),
      amount:    r.fields['Amount Due'],
      status:    selectName(r.fields['Status']),
    }));
  }

  return {
    ticket: {
      id:                f['Ticket  ID'],
      recordId,
      clientName:        f['Client Name'],
      phone:             f['Phone Number'],
      thesisDetails:     f['Thesis details'],
      orderStatus:       selectName(f['Order status']),
      totalPaid:         f['Total Paid'] || 0,
      remainingBalance:  f['Remaining Balance'] || 0,
      totalProjectValue: f['Total project value'] || 0,
    },
    payments,
  };
}

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {

      // ── POST /generate-link ──────────────────────────────────────────────
      if (pathname === '/generate-link' && request.method === 'POST') {
        const { total, advance } = await request.json();
        if (!total || !advance || advance <= 0 || advance > total)
          return json({ error: 'Invalid input' }, 400);

        await airtable(env, 'Link Generator', '', {
          method: 'POST',
          body: JSON.stringify({ fields: { 'Total Amount': Number(total), 'Advance amount': Number(advance) } }),
        });

        return json({ link: `${WORKER_BASE}/f/${makeToken(total, advance)}` });
      }

      // ── GET /f/:token → redirect to form.html ───────────────────────────
      if (pathname.startsWith('/f/')) {
        const token = pathname.slice(3);
        if (!parseToken(token)) return new Response('Invalid or expired link.', { status: 400 });
        return Response.redirect(`${PAGES_BASE}/form.html?token=${token}`, 302);
      }

      // ── POST /submit ─────────────────────────────────────────────────────
      if (pathname === '/submit' && request.method === 'POST') {
        const { token, name, phone, address, thesis } = await request.json();

        if (!token || !name || !phone || !thesis)
          return json({ error: 'Please fill in all required fields.' }, 400);

        const parsed = parseToken(token);
        if (!parsed) return json({ error: 'Invalid or expired link.' }, 400);

        const { total, advance } = parsed;

        const result = await airtable(env, 'Tickets', '', {
          method: 'POST',
          body: JSON.stringify({
            fields: {
              'Client Name':         name,
              'Phone Number':        phone,
              'Client Address':      address || '',
              'Thesis details':      thesis,
              'Total project value': total,
              'Advance Expected':    advance,
              'Order status':        'Intake',
            },
          }),
        });

        if (result.error) return json({ error: 'Could not save your request. Please try again.' }, 500);

        const trackerToken = makeTicketToken(result.id);
        return json({
          success:     true,
          trackerLink: `${PAGES_BASE}/tracker.html?token=${trackerToken}`,
        });
      }

      // ── GET /lookup?phone= ───────────────────────────────────────────────
      if (pathname === '/lookup' && request.method === 'GET') {
        const digits = digitsOnly(searchParams.get('phone') || '');
        if (digits.length < 6) return json({ error: 'Please enter a valid phone number' }, 400);

        const formula = encodeURIComponent(
          `SEARCH("${digits}",SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({Phone Number},"(",""),")",""),"-","")," ",""),"+",""))`
        );
        const ticketResult = await airtable(env, 'Tickets', `?filterByFormula=${formula}`);
        if (!ticketResult.records?.length) return json({ found: false });

        const data = await fetchTicketData(env, ticketResult.records[0].id);
        if (!data) return json({ found: false });

        return json({ found: true, ...data });
      }

      // ── GET /ticket?token= ───────────────────────────────────────────────
      if (pathname === '/ticket' && request.method === 'GET') {
        const token = searchParams.get('token');
        const recordId = parseTicketToken(token);
        if (!recordId) return json({ error: 'Invalid link.' }, 400);

        const data = await fetchTicketData(env, recordId);
        if (!data) return json({ error: 'Ticket not found.' }, 404);

        return json(data);
      }

      // ── POST /ticket/stage ───────────────────────────────────────────────
      if (pathname === '/ticket/stage' && request.method === 'POST') {
        const { token, pin, stage } = await request.json();
        if (!pin || pin !== env.ADMIN_PIN) return json({ error: 'Unauthorized.' }, 401);
        if (!VALID_STAGES.includes(stage)) return json({ error: 'Invalid stage.' }, 400);

        const recordId = parseTicketToken(token);
        if (!recordId) return json({ error: 'Invalid link.' }, 400);

        const result = await airtable(env, 'Tickets', `/${recordId}`, {
          method: 'PATCH',
          body: JSON.stringify({ fields: { 'Order status': stage } }),
        });

        if (result.error) return json({ error: 'Could not update stage.' }, 500);
        return json({ success: true, stage });
      }

      // ── GET /ticket/comments?token= ──────────────────────────────────────
      if (pathname === '/ticket/comments' && request.method === 'GET') {
        const token = searchParams.get('token');
        const recordId = parseTicketToken(token);
        if (!recordId) return json({ error: 'Invalid link.' }, 400);

        const data = await airtableComments(env, recordId);
        const comments = (data.comments || []).map(c => {
          const text = c.text || '';
          const match = text.match(/^\[([^\]]+)\] ([\s\S]*)/);
          const isTeam = match && match[1] === 'Team';
          return {
            id:        c.id,
            isTeam,
            author:    match ? match[1] : 'Customer',
            message:   match ? match[2] : text,
            timestamp: c.createdTime,
          };
        });

        return json({ comments });
      }

      // ── POST /ticket/comment ─────────────────────────────────────────────
      if (pathname === '/ticket/comment' && request.method === 'POST') {
        const { token, message, pin, clientName } = await request.json();
        if (!token || !message?.trim()) return json({ error: 'Message cannot be empty.' }, 400);

        const recordId = parseTicketToken(token);
        if (!recordId) return json({ error: 'Invalid link.' }, 400);

        const isTeam = pin && pin === env.ADMIN_PIN;
        const author = isTeam ? 'Team' : (clientName || 'Customer');
        const text   = `[${author}] ${message.trim()}`;

        const data = await airtableComments(env, recordId, {
          method: 'POST',
          body: JSON.stringify({ text }),
        });

        if (data.error) return json({ error: 'Could not post comment.' }, 500);
        return json({ success: true });
      }

      return new Response('Not found', { status: 404, headers: CORS });

    } catch (err) {
      return json({ error: 'Internal server error', detail: err.message }, 500);
    }
  },
};
