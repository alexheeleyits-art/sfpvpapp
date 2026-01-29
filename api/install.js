const crypto = require('crypto');
const { kv } = require('@vercel/kv');

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL;
const SHOPIFY_SCOPES = process.env.SHOPIFY_SCOPES || 'read_orders,read_products';

const isValidShop = (shop) => {
  if (!shop) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
};

module.exports = async (req, res) => {
  if (!SHOPIFY_API_KEY || !SHOPIFY_APP_URL) {
    res.status(500).send('Missing SHOPIFY_API_KEY or SHOPIFY_APP_URL');
    return;
  }

  const shop = req.query && req.query.shop;
  if (!isValidShop(shop)) {
    res.status(400).send('Invalid shop parameter');
    return;
  }

  const state = crypto.randomBytes(16).toString('hex');
  await kv.set(`battle:oauth:state:${state}`, shop, { ex: 600 });

  const redirectUri = `${SHOPIFY_APP_URL}/api/auth/callback`;
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${encodeURIComponent(
    SHOPIFY_SCOPES
  )}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

  res.writeHead(302, { Location: installUrl });
  res.end();
};
