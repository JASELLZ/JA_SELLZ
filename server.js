const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 4242;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PRODUCTS_FILE = path.join(__dirname, 'products.json');
const IMAGE_DIR = path.join(__dirname, 'images');
const sessions = new Map();

function readProducts() {
  return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
}
function writeProducts(products) {
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2) + '\n');
}
function cleanProduct(p) {
  const stock = Math.max(0, Number.parseInt(p.stock ?? 0, 10) || 0);
  const sizes = {};
  if (p.sizes && typeof p.sizes === 'object') {
    for (const [size, qty] of Object.entries(p.sizes)) sizes[String(size)] = Math.max(0, Number.parseInt(qty, 10) || 0);
  }
  const images = Array.isArray(p.images) && p.images.length ? p.images.filter(Boolean).map(String) : [String(p.image || '')].filter(Boolean);
  return {
    name: String(p.name || '').trim(),
    category: String(p.category || 'Clothes'),
    price: Math.max(0, Number(p.price) || 0),
    stock,
    sizes,
    image: String(p.image || images[0] || ''),
    images
  };
}
function loadProducts() {
  return readProducts().map(cleanProduct);
}

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(body);
}
function json(res, status, value) { send(res, status, JSON.stringify(value), 'application/json; charset=utf-8'); }

function readBody(req, max = 2_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > max) { req.destroy(); reject(new Error('Request too large')); }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}
function getToken(req) {
  const match = String(req.headers.cookie || '').match(/(?:^|; )ja_sellz_admin=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}
function isAdmin(req) { return Boolean(sessions.get(getToken(req))); }
function requireAdmin(req, res) {
  if (!ADMIN_PASSWORD) { json(res, 503, { error: 'Admin is not configured. Add ADMIN_PASSWORD in Render Environment Variables.' }); return false; }
  if (!isAdmin(req)) { json(res, 401, { error: 'Admin login required.' }); return false; }
  return true;
}

async function adminLogin(req, res) {
  if (!ADMIN_PASSWORD) return json(res, 503, { error: 'Add ADMIN_PASSWORD in Render Environment Variables first.' });
  const body = JSON.parse(await readBody(req));
  if (!body.password || body.password !== ADMIN_PASSWORD) return json(res, 401, { error: 'Incorrect password.' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, true);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': `ja_sellz_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Secure`,
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify({ ok: true }));
}

async function adminSaveProducts(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = JSON.parse(await readBody(req));
  if (!Array.isArray(body.products)) return json(res, 400, { error: 'products must be an array.' });
  const products = body.products.map(cleanProduct);
  if (products.some(p => !p.name || !p.image)) return json(res, 400, { error: 'Every product needs a name and image.' });
  writeProducts(products);
  return json(res, 200, { ok: true, products });
}

async function adminUploadImage(req, res) {
  if (!requireAdmin(req, res)) return;
  const body = JSON.parse(await readBody(req, 8_000_000));
  const filename = String(body.filename || '').toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  const data = String(body.data || '');
  if (!/^[-a-z0-9_]+\.(jpg|jpeg|png|webp)$/i.test(filename)) return json(res, 400, { error: 'Use a .jpg, .jpeg, .png, or .webp image filename.' });
  const base64 = data.replace(/^data:image\/[^;]+;base64,/, '');
  if (!base64) return json(res, 400, { error: 'No image data.' });
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  fs.writeFileSync(path.join(IMAGE_DIR, filename), Buffer.from(base64, 'base64'));
  return json(res, 200, { ok: true, filename });
}

async function createCheckoutSession(req, res) {
  if (!STRIPE_SECRET_KEY) return json(res, 500, { error: 'Stripe is not configured yet. Add STRIPE_SECRET_KEY on the server/hosting dashboard.' });
  try {
    const body = JSON.parse(await readBody(req));
    if (!Array.isArray(body.items) || body.items.length === 0) return json(res, 400, { error: 'Your cart is empty.' });
    const products = loadProducts();
    const byName = new Map(products.map(p => [p.name, p]));
    const requested = new Map();
    for (const item of body.items) {
      if (!item || typeof item.name !== 'string') continue;
      const p = byName.get(item.name);
      if (!p) return json(res, 400, { error: 'Invalid product in cart.' });
      const qty = Math.max(1, Math.min(10, Number.parseInt(item.quantity || 1, 10)));
      const size = item.size ? String(item.size) : '';
      const sizeQty = size && Object.keys(p.sizes).length ? (p.sizes[size] ?? 0) : p.stock;
      const key = `${p.name}|||${size}`;
      requested.set(key, { product: p, size, quantity: (requested.get(key)?.quantity || 0) + qty, available: sizeQty });
    }
    for (const x of requested.values()) {
      if (x.available <= 0) return json(res, 409, { error: `${x.product.name}${x.size ? ` (${x.size})` : ''} is out of stock.` });
      if (x.quantity > x.available) return json(res, 409, { error: `Only ${x.available} left for ${x.product.name}${x.size ? ` (${x.size})` : ''}.` });
    }
    const params = new URLSearchParams();
    params.set('mode', 'payment');
    params.set('success_url', `${getBaseUrl(req)}/success.html?session_id={CHECKOUT_SESSION_ID}`);
    params.set('cancel_url', `${getBaseUrl(req)}/?checkout=cancelled`);
    params.set('billing_address_collection', 'auto');
    params.set('shipping_address_collection[allowed_countries][0]', 'US');
    params.set('customer_creation', 'always');
    params.set('submit_type', 'pay');
    params.set('metadata[store]', 'ja_sellz');
    params.set('metadata[refund_policy]', 'ALL SALES ARE FINAL.');
    let index = 0;
    for (const x of requested.values()) {
      const p = x.product;
      params.set(`line_items[${index}][price_data][currency]`, 'usd');
      params.set(`line_items[${index}][price_data][product_data][name]`, x.size ? `${p.name} — Size ${x.size}` : p.name);
      params.set(`line_items[${index}][price_data][unit_amount]`, String(Math.round(p.price * 100)));
      params.set(`line_items[${index}][quantity]`, String(Math.min(x.quantity, 10)));
      index++;
    }
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
    const stripeData = await stripeRes.json();
    if (!stripeRes.ok) { console.error('Stripe error:', stripeData); return json(res, 502, { error: stripeData?.error?.message || 'Stripe could not create checkout.' }); }
    return json(res, 200, { url: stripeData.url });
  } catch (err) { console.error(err); return json(res, 400, { error: 'Could not start checkout.' }); }
}

function getBaseUrl(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = forwardedProto ? String(forwardedProto).split(',')[0] : 'http';
  return `${proto}://${req.headers.host}`;
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
    const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp', '.css':'text/css; charset=utf-8', '.txt':'text/plain; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': pathname === '/products.json' ? 'no-store' : 'public, max-age=300' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'POST' && url.pathname === '/api/admin/login') return adminLogin(req, res);
    if (req.method === 'POST' && url.pathname === '/api/admin/products') return adminSaveProducts(req, res);
    if (req.method === 'POST' && url.pathname === '/api/admin/upload-image') return adminUploadImage(req, res);
    if (req.method === 'POST' && url.pathname === '/api/create-checkout-session') return createCheckoutSession(req, res);
    if (req.method === 'GET' && url.pathname === '/api/products') return json(res, 200, loadProducts());
    if (req.method === 'GET') return serveFile(req, res);
    send(res, 405, 'Method not allowed');
  } catch (err) { console.error(err); json(res, 500, { error: 'Server error.' }); }
});

server.listen(PORT, () => {
  console.log(`ja_sellz running on port ${PORT}`);
  if (!STRIPE_SECRET_KEY) console.log('STRIPE_SECRET_KEY is not set.');
  if (!ADMIN_PASSWORD) console.log('ADMIN_PASSWORD is not set.');
});
