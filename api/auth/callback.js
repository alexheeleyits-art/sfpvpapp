const crypto = require('crypto');
const { kv } = require('@vercel/kv');

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL;
const SHOPIFY_SCOPES = process.env.SHOPIFY_SCOPES || 'read_orders,read_products';

const isValidShop = (shop) => {
  if (!shop) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
};

const buildQueryString = (params) => {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
};

const verifyHmac = (params, secret) => {
  if (!secret || !params.hmac) return false;
  const { hmac, signature, ...rest } = params;
  const message = buildQueryString(rest);
  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const digestBuffer = Buffer.from(digest, 'utf8');
  const hmacBuffer = Buffer.from(hmac, 'utf8');
  if (digestBuffer.length !== hmacBuffer.length) return false;
  return crypto.timingSafeEqual(digestBuffer, hmacBuffer);
};

const registerWebhook = async (shop, token, topic, address) => {
  const response = await fetch(`https://${shop}/admin/api/2024-01/webhooks.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({
      webhook: {
        topic,
        address,
        format: 'json',
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Webhook create failed: ${response.status} ${text}`);
  }
};

module.exports = async (req, res) => {
  if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET || !SHOPIFY_APP_URL) {
    res.status(500).send('Missing Shopify OAuth environment variables');
    return;
  }

  const params = req.query || {};
  const { shop, code, state } = params;

  if (!isValidShop(shop) || !code || !state) {
    res.status(400).send('Invalid OAuth callback');
    return;
  }

  const savedShop = await kv.get(`battle:oauth:state:${state}`);
  if (!savedShop || savedShop !== shop) {
    res.status(400).send('Invalid OAuth state');
    return;
  }

  if (!verifyHmac(params, SHOPIFY_API_SECRET)) {
    res.status(401).send('Invalid OAuth HMAC');
    return;
  }

  const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code,
    }),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    res.status(500).send(`OAuth token error: ${text}`);
    return;
  }

  const tokenData = await tokenResponse.json();
  if (!tokenData.access_token) {
    res.status(500).send('Missing access token');
    return;
  }

  await kv.set(`battle:shop:${shop}:token`, tokenData.access_token);
  await kv.set(`battle:shop:${shop}:scopes`, SHOPIFY_SCOPES);

  const webhookAddress = `${SHOPIFY_APP_URL}/api/battle-webhook`;
  try {
    await registerWebhook(shop, tokenData.access_token, 'orders/paid', webhookAddress);
    await registerWebhook(shop, tokenData.access_token, 'orders/cancelled', webhookAddress);
    await registerWebhook(shop, tokenData.access_token, 'refunds/create', webhookAddress);
  } catch (error) {
    console.error('[battle-oauth] webhook registration failed', error);
    res.status(500).send('Webhook registration failed');
    return;
  }

  res.status(200).send('App installed. You can close this window.');
};
