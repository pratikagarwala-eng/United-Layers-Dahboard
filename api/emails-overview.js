/**
 * GET /api/emails-overview?from=<ISO>&to=<ISO>
 *
 * Serverless function that calls the email platform's reporting API on behalf of
 * the dashboard. The API token lives in the REPLY_API_TOKEN environment variable
 * and is never sent to the browser.
 *
 * GET rather than POST so the response can be cached at the edge — identical
 * range queries are served from cache instead of burning upstream rate limit,
 * which matters because this deployment is publicly reachable.
 */

'use strict';

const UPSTREAM_HOST = 'api.reply.io';
const UPSTREAM_PATH = '/v3/reporting/emails/overview';

/* Fields the dashboard renders. Anything else the upstream returns is dropped
   rather than forwarded, so the response surface stays deliberate. */
const ALLOWED_FIELDS = [
  'contacted', 'delivered', 'opened', 'replied', 'interested',
  'notReached', 'optedOut', 'outOfOffice', 'bounced', 'autoReplied', 'accounts',
  'deliveredPercentage', 'openedPercentage', 'repliedPercentage',
  'interestedPercentage', 'notReachedPercentage', 'optedOutPercentage',
  'outOfOfficePercentage', 'bouncedPercentage', 'autoRepliedPercentage'
];

/* Best-effort per-instance rate limit. Serverless instances are not shared, so
   this throttles a single hot instance rather than the deployment as a whole —
   the edge cache below is what actually protects the upstream quota. */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.reset) {
    hits.set(ip, { count: 1, reset: now + WINDOW_MS });
    if (hits.size > 5000) hits.clear();              // crude unbounded-growth guard
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_PER_WINDOW;
}

/* Only serve browsers that arrived from this same deployment. Origin/Referer can
   be forged by a non-browser client, so treat this as abuse reduction, not
   access control. */
function sameOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return false;
  const src = req.headers.origin || req.headers.referer;
  if (!src) return true;                              // curl/no-Origin: allowed
  try { return new URL(src).host === host; } catch { return false; }
}

const isIso = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s);

function callUpstream(token, payload) {
  return fetch(`https://${UPSTREAM_HOST}${UPSTREAM_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Use GET' });
  }
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Cross-origin requests are not allowed' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Too many requests — try again in a minute' });
  }

  /* Name the missing variable explicitly. The variable *name* is already public in
     the README, so saying it leaks nothing and saves a guessing game — the value
     is of course never echoed. */
  const token = (process.env.REPLY_API_TOKEN || '').trim();
  if (!token) {
    console.error(
      'REPLY_API_TOKEN is missing from this deployment. Add it under Project → ' +
      'Settings → Environment Variables (tick Production, Preview and Development), ' +
      'then redeploy — Vercel only picks up env vars at build time. ' +
      'Environment seen: ' + (process.env.VERCEL_ENV || 'local')
    );
    return res.status(500).json({
      error: 'REPLY_API_TOKEN is not set for this deployment (' +
             (process.env.VERCEL_ENV || 'local') + '). Add it in Vercel → Settings → ' +
             'Environment Variables, then redeploy.'
    });
  }

  const { from, to } = req.query || {};
  if (!isIso(from) || !isIso(to)) {
    return res.status(400).json({ error: 'from and to must be ISO timestamps like 2026-08-01T00:00:00Z' });
  }
  if (Date.parse(from) >= Date.parse(to)) {
    return res.status(400).json({ error: '"from" must be earlier than "to"' });
  }

  try {
    const upstream = await callUpstream(token, { filters: { from, to } });
    const text = await upstream.text();

    if (!upstream.ok) {
      /* Never echo an upstream body verbatim — it can contain the token or
         account internals. Log the detail, return something safe. */
      console.error(`upstream ${upstream.status}: ${text.split(token).join('«redacted»').slice(0, 300)}`);
      return res.status(502).json({ error: `Upstream returned ${upstream.status}` });
    }

    let parsed;
    try { parsed = JSON.parse(text); }
    catch { return res.status(502).json({ error: 'Upstream returned malformed JSON' }); }

    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!row || typeof row !== 'object') return res.status(502).json({ error: 'Unexpected upstream shape' });

    const out = {};
    for (const k of ALLOWED_FIELDS) if (row[k] != null) out[k] = row[k];

    /* Cache identical ranges at the edge for a minute; serve stale briefly while
       revalidating so a burst of viewers costs one upstream call, not hundreds. */
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json(out);
  } catch (err) {
    console.error('request failed:', String(err && err.message).split(token).join('«redacted»'));
    return res.status(502).json({ error: 'Could not reach the reporting API' });
  }
};
