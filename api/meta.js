// Vercel serverless proxy — Meta Graph API
// Token stays server-side in env vars, never reaches the browser.
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    return res.status(500).json({ error: { message: 'META_ACCESS_TOKEN not set in environment variables.' } });
  }

  const { path, ...rest } = req.query;
  if (!path) {
    return res.status(400).json({ error: { message: 'Missing required query param: path' } });
  }

  // Forward all query params to Meta, injecting the token server-side
  const params = new URLSearchParams({ ...rest, access_token: token });
  const metaUrl = `https://graph.facebook.com/v21.0/${path}?${params}`;

  try {
    const resp = await fetch(metaUrl);
    const data = await resp.json();
    return res.status(resp.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
};
