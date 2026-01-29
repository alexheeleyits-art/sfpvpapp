const { kv } = require('@vercel/kv');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const totals = (await kv.hgetall('battle:totals')) || {};
  const sweetRevenue = Number(totals.sweet || 0);
  const savouryRevenue = Number(totals.savoury || 0);
  const lastUpdated = totals.lastUpdated || new Date().toISOString();

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(200).json({
    sweetRevenue,
    savouryRevenue,
    lastUpdated,
  });
};
