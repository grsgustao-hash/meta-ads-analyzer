const crypto = require('crypto');

function makeToken(secret) {
  return crypto.createHmac('sha256', secret).update('meta-ads-access').digest('hex');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return res.status(500).json({ error: 'DASHBOARD_PASSWORD não configurado' });

  const secret = process.env.DASHBOARD_SECRET || password;

  // GET /api/auth?token=xxx  →  verifica se token é válido
  if (req.method === 'GET') {
    const { token } = req.query;
    const valid = token && token === makeToken(secret);
    return res.status(200).json({ ok: valid });
  }

  // POST /api/auth  { password }  →  valida senha, retorna token
  if (req.method === 'POST') {
    const body = req.body || {};
    if (!body.password || body.password !== password) {
      return res.status(401).json({ error: 'Senha incorreta' });
    }
    return res.status(200).json({ token: makeToken(secret) });
  }

  return res.status(405).end();
};
