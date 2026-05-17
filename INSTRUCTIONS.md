# Thesis CRM — Engineering & Product Instructions

This document defines the non-negotiable standards for every feature built in this project.
Read this before implementing anything. These are not suggestions.

---

## 1. Product Philosophy (Apple Standard)

> “Simplicity is the ultimate sophistication.”

- **One screen, one job.** Every interface element must earn its place. If a feature requires explanation, the design has failed.
- **Build for the user who is in a hurry.** Your sister is running a business. Every interaction should take fewer taps and fewer decisions than you think it needs.
- **Don’t expose internal complexity.** Record IDs, API URLs, field names, pricing parameters — none of this should ever be visible to a client or in a client-facing URL.
- **Defaults should be correct.** Forms, statuses, and fields should default to the most common correct state. Don’t make the admin set things that can be inferred.
- **Polish is not optional.** Loading states, error messages, empty states — every state the user can encounter must be handled gracefully.

---

## 2. Engineering Standards

### Security (non-negotiable)
- **API keys never go in frontend code.** All Airtable calls go through the Cloudflare Worker. No exceptions.
- **No sensitive data in URLs.** Pricing, client details, or internal IDs must never appear in query parameters of client-facing links. Use opaque tokens.
- **The repo is public.** Never commit secrets, tokens, or credentials. Use `wrangler secret put` for Worker secrets.

### Validation (every input, every time)
- **Validate on the way in, not on the way out.** Any field that accepts user input must have validation — required checks, type checks, range checks — before data touches Airtable.
- **Airtable form fields:** Mark all required fields as required in the form builder. Never assume a field will be filled.
- **Worker endpoints:** Validate all request bodies before processing. Return clear 400 errors with human-readable messages.
- **Financial fields:** Always check that amounts are positive, non-zero, and within expected ranges (e.g., advance cannot exceed total).

### Data Integrity
- **Never create orphaned records.** Every Payment record must have a linked Ticket. Every link generated must be logged.
- **Calculated fields stay calculated.** Remaining Balance, Total Paid — these are formula/rollup fields and must never be manually editable.
- **Audit trail matters.** For any record that involves money, there must be a way to know when it changed and to what.

### Code Quality
- **One Worker, all endpoints.** Don’t create multiple Workers for the same project. Extend the existing one.
- **Stateless where possible.** Prefer encoding state in opaque tokens over storing it in new tables or KV, unless persistence is genuinely required.
- **Error handling is not optional.** Every `fetch()` call, every Airtable API call, must have a try/catch with a meaningful fallback or error response.

---

## 3. Pre-Feature Checklist

Before implementing any new feature, answer these questions:

- [ ] **Who uses this?** Admin only, or client-facing? Client-facing features need higher polish and zero internal data exposure.
- [ ] **What can go wrong?** List the failure modes. Handle each one.
- [ ] **What fields are user-editable?** Every editable field needs validation.
- [ ] **Does any URL or UI expose internal data?** If yes, fix the design before building.
- [ ] **Does this create records?** If yes, are all required links and fields populated automatically?
- [ ] **Does this touch money?** If yes, double-check the math, add an audit trail, and validate ranges.
- [ ] **What does the empty state look like?** Design the zero-data state before the happy path.
- [ ] **Can the admin undo this?** If a destructive action is possible, add confirmation or make it reversible.

---

## 4. System Architecture (current)

```
Client (tracker.html on GitHub Pages)
       ↓
Cloudflare Worker  ←— API key stored as Cloudflare secret
       ↓
Airtable API
       ↓
Demo Form base (appXfVVzb9jzX3jmx)
  ├─ Tickets table
  ├─ Payments table
  └─ Link Generator table

Admin (link-generator.html on GitHub Pages)
       ↓
Same Cloudflare Worker
```

**Worker URL:** `https://thesis-crm-worker.srijancrm.workers.dev`
**GitHub Pages:** `https://srijan908.github.io/thesis-crm-tools/`
**Airtable Base:** `https://airtable.com/appXfVVzb9jzX3jmx`

---

## 5. Order Status Pipeline

| Stage | Meaning |
|---|---|
| Intake | Form submitted, work not started |
| In Progress | Actively working on thesis |
| Review | Submitted to client for review |
| Revision | Client requested changes |
| Delivered | Final version delivered |
| Closed | Payment settled, project complete |

---

## 6. Payment Rules

- Payments are milestone-based: Advance → Midway → Final (but not capped — add as many as needed)
- Advance is always auto-created when a Ticket is created (via Airtable automation)
- Subsequent installments are added manually from the Ticket interface
- Status is either **Pending** or **Paid** — no intermediate states
- Remaining Balance = Total Project Value − Total Paid (formula field, never manually edited)
