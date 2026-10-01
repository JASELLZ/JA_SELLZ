const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 4242;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

function loadProducts() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'products.json'), 'utf8'));
  return Object.fromEntries(data.map(p => [p.name, { price: Math.round(Number(p.price) * 100), image: p.image }]));
}

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(__dirname, pathname));
  if (!filePath.startsWith(__dirname + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, err.code === 'ENOENT' ? 404 : 500, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.css':'text/css; charset=utf-8', '.txt':'text/plain; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function createCheckoutSession(req, res) {
  if (!STRIPE_SECRET_KEY) {
    return send(res, 500, JSON.stringify({ error: 'Stripe is not configured yet. Add STRIPE_SECRET_KEY on the server/hosting dashboard.' }), 'application/json');
  }

  let raw = '';
  req.on('data', chunk => { raw += chunk; if (raw.length > 200000) req.destroy(); });
  req.on('end', async () => {
    try {
      const body = JSON.parse(raw || '{}');
      if (!Array.isArray(body.items) || body.items.length === 0) {
        return send(res, 400, JSON.stringify({ error: 'Your cart is empty.' }), 'application/json');
      }

      const products = loadProducts();
      const counts = new Map();
      for (const item of body.items) {
        if (!item || typeof item.name !== 'string') continue;
        const product = products[item.name];
        if (!product) return send(res, 400, JSON.stringify({ error: 'Invalid product in cart.' }), 'application/json');
        const qty = Math.max(1, Math.min(10, Number.parseInt(item.quantity || 1, 10)));
        counts.set(item.name, (counts.get(item.name) || 0) + qty);
      }
      if (!counts.size) return send(res, 400, JSON.stringify({ error: 'Your cart is empty.' }), 'application/json');

      const params = new URLSearchParams();
      params.set('mode', 'payment');
      params.set('success_url', `${getBaseUrl(req)}/success.html?session_id={CHECKOUT_SESSION_ID}`);
      params.set('cancel_url', `${getBaseUrl(req)}/?checkout=cancelled`);
      params.set('billing_address_collection', 'auto');
      params.set('shipping_address_collection[allowed_countries][0]', 'US');
      params.set('customer_creation', 'always');
      params.set('submit_type', 'pay');
      params.set('metadata[store]', 'ja_sellz');
      params.set('metadata[refund_policy]', 'All sales final; no returns');

      let index = 0;
      for (const [name, quantity] of counts) {
        const p = products[name];
        params.set(`line_items[${index}][price_data][currency]`, 'usd');
        params.set(`line_items[${index}][price_data][product_data][name]`, name);
        params.set(`line_items[${index}][price_data][unit_amount]`, String(p.price));
        params.set(`line_items[${index}][quantity]`, String(Math.min(quantity, 10)));
        index++;
      }

      const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
      });

      const stripeData = await stripeRes.json();
      if (!stripeRes.ok) {
        console.error('Stripe error:', stripeData);
        return send(res, 502, JSON.stringify({ error: stripeData?.error?.message || 'Stripe could not create checkout.' }), 'application/json');
      }

      return send(res, 200, JSON.stringify({ url: stripeData.url }), 'application/json');
    } catch (err) {
      console.error(err);
      return send(res, 400, JSON.stringify({ error: 'Could not start checkout.' }), 'application/json');
    }
  });
}

function getBaseUrl(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = forwardedProto ? String(forwardedProto).split(',')[0] : 'http';
  return `${proto}://${req.headers.host}`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'POST' && url.pathname === '/api/create-checkout-session') {
    return createCheckoutSession(req, res);
  }
  if (req.method === 'GET') return serveFile(req, res);
  send(res, 405, 'Method not allowed');
});

server.listen(PORT, () => {
  console.log(`ja_sellz running on port ${PORT}`);
  if (!STRIPE_SECRET_KEY) console.log('STRIPE_SECRET_KEY is not set. Add it before accepting payments.');
});
