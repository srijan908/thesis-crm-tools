/**
 * Thesis CRM — Cloudflare Worker
 * Proxies Airtable API calls so the API key stays secret.
 *
 * Endpoints:
 *   POST /generate-link  { total, advance } → logs to Airtable + returns { link }
 *   GET  /lookup?phone=  → returns ticket + payment details
 *
 * Deploy:
 *   1. wrangler secret put AIRTABLE_API_KEY
 *   2. wrangler deploy
 */

const BASE_ID = 'appXfVVzb9jzX3jmx';
const FORM_URL = `https://airtable.com/${BASE_ID}/pagJGC0XwkBjgCVMV/form`;

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

function digitsOnly(str) {
  return str.replace(/\D/g, '');
}

function selectName(field) {
  if (!field) return null;
  return typeof field === 'object' ? field.name : field;
}

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    try {
      // ── POST /generate-link ────────────────────────────────────────────────
      if (pathname === '/generate-link' && request.method === 'POST') {
        const { total, advance } = await request.json();

        if (!total || !advance || advance <= 0 || advance > total) {
          return json({ error: 'Invalid input' }, 400);
        }

        // Log to Link Generator table
        await airtable(env, 'Link Generator', '', {
          method: 'POST',
          body: JSON.stringify({
            fields: {
              'Total Amount': Number(total),
              'Advance amount': Number(advance),
            },
          }),
        });

        const link =
          `${FORM_URL}` +
          `?prefill_Total+project+value=${total}` +
          `&hide_Total+project+value=true` +
          `&prefill_Advance+Expected=${advance}` +
          `&hide_Advance+Expected=true`;

        return json({ link });
      }

      // ── GET /lookup?phone= ─────────────────────────────────────────────────
      if (pathname === '/lookup' && request.method === 'GET') {
        const rawPhone = searchParams.get('phone') || '';
        const digits = digitsOnly(rawPhone);

        if (digits.length < 6) {
          return json({ error: 'Please enter a valid phone number' }, 400);
        }

        // Strip formatting from stored numbers before comparing
        const formula = encodeURIComponent(
          `SEARCH("${digits}",SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({Phone Number},"(",""),")",""),"-","")," ",""),"+",""))`
        );

        const ticketResult = await airtable(env, 'Tickets', `?filterByFormula=${formula}`);

        if (!ticketResult.records || ticketResult.records.length === 0) {
          return json({ found: false });
        }

        const ticket = ticketResult.records[0];
        const f = ticket.fields;
        const paymentLinks = f['Payments'] || [];

        let payments = [];
        if (paymentLinks.length > 0) {
          const orFormula = encodeURIComponent(
            `OR(${paymentLinks.map(p => `RECORD_ID()='${p.id}'`).join(',')})`
          );
          const payResult = await airtable(env, 'Payments', `?filterByFormula=${orFormula}`);
          payments = (payResult.records || []).map(r => ({
            milestone: selectName(r.fields['Milestone Name']),
            amount: r.fields['Amount Due'],
            status: selectName(r.fields['Status']),
          }));
        }

        return json({
          found: true,
          ticket: {
            id: f['Ticket  ID'],
            clientName: f['Client Name'],
            thesisDetails: f['Thesis details'],
            orderStatus: selectName(f['Order status']),
            totalPaid: f['Total Paid'] || 0,
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
