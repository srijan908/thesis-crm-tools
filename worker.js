/**
 * Thesis CRM — Cloudflare Worker
 *
 * Endpoints:
 *   POST /generate-link   { total, advance } → logs to Airtable, returns { link } short URL
 *   GET  /f/:token        → redirects to custom form page (token in query param, no pricing in URL)
 *   POST /submit          { token, name, phone, address, thesis } → creates Ticket in Airtable
 *   GET  /lookup?phone=   → returns ticket + payments for customer tracker
 */

const BASE_ID      = 'appXfVVzb9jzX3jmx';
const WORKER_BASE  = 'https://thesis-crm-worker.srijancrm.workers.dev';
const PAGES_BASE   = 'https://srijan908.github.io/thesis-crm-tools';

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

function digitsOnly(str) { return str.replace(/\D/g, ''); }
function selectName(f)   { return f ? (typeof f === 'object' ? f.name : f) : null; }

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

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {

      // ── POST /generate-link ───────────────────────────────────────────────
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

      // ── GET /f/:token (short link → redirect to custom form) ──────────────────────
      if (pathname.startsWith('/f/')) {
        const token = pathname.slice(3);
        if (!parseToken(token)) return new Response('Invalid or expired link.', { status: 400 });
        return Response.redirect(`${PAGES_BASE}/form.html?token=${token}`, 302);
      }

      // ── POST /submit ───────────────────────────────────────────────────────────
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
              'Client Name':        name,
              'Phone Number':       phone,
              'Client Address':     address || '',
              'Thesis details':     thesis,
              'Total project value': total,
              'Advance Expected':   advance,
              'Order status':       'Intake',
            },
          }),
        });

        if (result.error) return json({ error: 'Could not save your request. Please try again.' }, 500);
        return json({ success: true });
      }

      // ── GET /lookup?phone= ───────────────────────────────────────────────────────
      if (pathname === '/lookup' && request.method === 'GET') {
        const digits = digitsOnly(searchParams.get('phone') || '');
        if (digits.length < 6) return json({ error: 'Please enter a valid phone number' }, 400);

        const formula = encodeURIComponent(
          `SEARCH("${digits}",SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({Phone Number},"(",""),")",""),"-","")," ",""),"+",""))`
        );
        const ticketResult = await airtable(env, 'Tickets', `?filterByFormula=${formula}`);
        if (!ticketResult.records?.length) return json({ found: false });

        const ticket = ticketResult.records[0];
        const f = ticket.fields;
        const paymentLinks = f['Payments'] || [];

        let payments = [];
        if (paymentLinks.length > 0) {
          const orFormula = encodeURIComponent(`OR(${paymentLinks.map(p => `RECORD_ID()='${p.id}'`).join(',')})`);
          const payResult = await airtable(env, 'Payments', `?filterByFormula=${orFormula}`);
          payments = (payResult.records || []).map(r => ({
            milestone: selectName(r.fields['Milestone Name']),
            amount:    r.fields['Amount Due'],
            status:    selectName(r.fields['Status']),
          }));
        }

        return json({
          found: true,
          ticket: {
            id:               f['Ticket  ID'],
            clientName:       f['Client Name'],
            thesisDetails:    f['Thesis details'],
            orderStatus:      selectName(f['Order status']),
            totalPaid:        f['Total Paid'] || 0,
            remainingBalance: f['Remaining Balance'] || 0,
          },
          payments,
        });
      }

      return new Response('Not found', { status: 404, headers: CORS });

    } catch (err) {
      return json({ error: 'Internal server error', detail: err.message }, 500);
    }
  },
};
