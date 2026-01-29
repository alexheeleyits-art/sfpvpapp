const { kv } = require('@vercel/kv');

module.exports = async (req, res) => {
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
