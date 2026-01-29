const crypto = require('crypto');
const { kv } = require('@vercel/kv');

const ORDER_KEY_PREFIX = 'battle:order:';
const PRODUCT_KEY_PREFIX = 'battle:product:';

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

const toNumber = (value) => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value.replace(/,/g, ''));
  return 0;
};

const parseMoney = (value) => {
  const number = Number.parseFloat(String(value || '0').replace(/,/g, ''));
  return Number.isNaN(number) ? 0 : number;
};

const normalizeSide = (value) => {
  if (!value) return null;
  const side = String(value).trim().toLowerCase();
  if (side === 'sweet' || side === 'savoury') return side;
  return null;
};

const readRawBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const verifyWebhook = (rawBody, hmacHeader) => {
  if (!SHOPIFY_WEBHOOK_SECRET || !hmacHeader) return false;
  const digest = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(rawBody).digest('base64');
  const digestBuffer = Buffer.from(digest, 'utf8');
  const hmacBuffer = Buffer.from(hmacHeader, 'utf8');
  if (digestBuffer.length !== hmacBuffer.length) return false;
  return crypto.timingSafeEqual(digestBuffer, hmacBuffer);
};

const getShopToken = async (shopDomain) => {
  if (shopDomain) {
    const token = await kv.get(`battle:shop:${shopDomain}:token`);
    if (token) return token;
  }
  return SHOPIFY_ADMIN_TOKEN || null;
};

const shopifyGraphQL = async (shopDomain, token, query, variables) => {
  const shop = shopDomain || SHOPIFY_DOMAIN;
  if (!shop || !token) {
    throw new Error('Missing Shopify shop domain or access token');
  }

  const response = await fetch(`https://${shop}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Shopify GraphQL error: ${response.status}`);
  }

  const json = await response.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
};

const getProductSide = async (productId, shopDomain) => {
  const cacheKey = `${PRODUCT_KEY_PREFIX}${shopDomain || 'default'}:${productId}`;
  const cached = await kv.get(cacheKey);
  if (cached) return cached;

  const gid = `gid://shopify/Product/${productId}`;
  const query = `query ProductSide($id: ID!) {\n  product(id: $id) {\n    tags\n    metafield(namespace: \"battle\", key: \"side\") {\n      value\n    }\n  }\n}`;

  const token = await getShopToken(shopDomain);
  const data = await shopifyGraphQL(shopDomain, token, query, { id: gid });
  const product = data.product;
  if (!product) return null;

  const metaSide = normalizeSide(product.metafield && product.metafield.value);
  if (metaSide) {
    await kv.set(cacheKey, metaSide, { ex: 86400 });
    return metaSide;
  }

  const tags = Array.isArray(product.tags) ? product.tags.map((tag) => tag.toLowerCase()) : [];
  if (tags.includes('sweet')) {
    await kv.set(cacheKey, 'sweet', { ex: 86400 });
    return 'sweet';
  }
  if (tags.includes('savoury')) {
    await kv.set(cacheKey, 'savoury', { ex: 86400 });
    return 'savoury';
  }

  return null;
};

const buildOrderContribution = async (lineItems, shopDomain) => {
  const contribution = {
    sweet: 0,
    savoury: 0,
    lineItems: {},
  };

  for (const item of lineItems || []) {
    if (!item || !item.product_id) continue;
    const side = await getProductSide(item.product_id, shopDomain);
    if (!side) continue;

    const quantity = Number(item.quantity || 0);
    if (quantity <= 0) continue;

    const price = parseMoney(item.price_set && item.price_set.shop_money && item.price_set.shop_money.amount)
      || parseMoney(item.price);
    const totalDiscount = parseMoney(item.total_discount_set && item.total_discount_set.shop_money && item.total_discount_set.shop_money.amount)
      || parseMoney(item.total_discount);

    const lineTotal = Math.max(price * quantity - totalDiscount, 0);

    contribution[side] += lineTotal;
    contribution.lineItems[item.id] = {
      side,
      quantity,
      revenue: lineTotal,
      remaining: lineTotal,
    };
  }

  return contribution;
};

const updateTotals = async (deltaSweet, deltaSavoury) => {
  const pipeline = kv.pipeline();
  pipeline.hincrbyfloat('battle:totals', 'sweet', deltaSweet);
  pipeline.hincrbyfloat('battle:totals', 'savoury', deltaSavoury);
  pipeline.hset('battle:totals', { lastUpdated: new Date().toISOString() });
  await pipeline.exec();
};

const handleOrderPaid = async (payload, shopDomain) => {
  const orderId = payload.id;
  if (!orderId) return;

  const orderKey = `${ORDER_KEY_PREFIX}${orderId}`;
  const exists = await kv.get(orderKey);
  if (exists) return;

  const contribution = await buildOrderContribution(payload.line_items || [], shopDomain);
  if (contribution.sweet === 0 && contribution.savoury === 0) return;

  await updateTotals(contribution.sweet, contribution.savoury);
  await kv.set(orderKey, {
    orderId,
    sweet: contribution.sweet,
    savoury: contribution.savoury,
    lineItems: contribution.lineItems,
  });
};

const handleOrderCancelled = async (payload) => {
  const orderId = payload.id;
  if (!orderId) return;

  const orderKey = `${ORDER_KEY_PREFIX}${orderId}`;
  const record = await kv.get(orderKey);
  if (!record) return;

  await updateTotals(-Number(record.sweet || 0), -Number(record.savoury || 0));
  await kv.del(orderKey);
};

const handleRefundCreate = async (payload) => {
  const orderId = payload.order_id;
  if (!orderId) return;

  const orderKey = `${ORDER_KEY_PREFIX}${orderId}`;
  const record = await kv.get(orderKey);
  if (!record || !record.lineItems) return;

  let deltaSweet = 0;
  let deltaSavoury = 0;

  for (const refundItem of payload.refund_line_items || []) {
    const lineItemId = refundItem.line_item_id;
    const line = record.lineItems[lineItemId];
    if (!line) continue;

    const quantity = Number(refundItem.quantity || 0);
    if (!quantity || !line.quantity) continue;

    const fraction = Math.min(quantity / line.quantity, 1);
    const refundAmount = Math.min(line.remaining || line.revenue, line.revenue * fraction);

    if (line.side === 'sweet') deltaSweet -= refundAmount;
    if (line.side === 'savoury') deltaSavoury -= refundAmount;

    line.remaining = Math.max((line.remaining || line.revenue) - refundAmount, 0);
  }

  if (deltaSweet === 0 && deltaSavoury === 0) return;

  record.sweet = Math.max(Number(record.sweet || 0) + deltaSweet, 0);
  record.savoury = Math.max(Number(record.savoury || 0) + deltaSavoury, 0);

  await updateTotals(deltaSweet, deltaSavoury);
  await kv.set(orderKey, record);
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const rawBody = await readRawBody(req);
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];

  if (!verifyWebhook(rawBody, hmacHeader)) {
    res.status(401).send('Invalid webhook signature');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (error) {
    res.status(400).send('Invalid JSON');
    return;
  }

  const topic = req.headers['x-shopify-topic'];
  const shopDomain = req.headers['x-shopify-shop-domain'];
  try {
    if (topic === 'orders/paid') {
      await handleOrderPaid(payload, shopDomain);
    } else if (topic === 'orders/cancelled') {
      await handleOrderCancelled(payload);
    } else if (topic === 'refunds/create') {
      await handleRefundCreate(payload);
    }
  } catch (error) {
    console.error('[battle-webhook]', error);
    res.status(500).send('Webhook error');
    return;
  }

  res.status(200).send('OK');
};
