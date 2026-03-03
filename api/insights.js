// ============================================================
// POST /api/insights
// Body: { ad: { nome, spend, roas, revenue, lucro, purchases,
//               cpa, cpm, ctr, cpcLink, hookRate, holdRate,
//               impressions }, periodo }
// Retorna: { diagnostico, pontos: string[], recomendacao }
// ============================================================

const { OpenAI } = require('openai');

const openai = new OpenAI();

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('JSON inválido no body.')); }
    });
    req.on('error', reject);
  });
}

function fmt(n) {
  const v = parseFloat(n);
  return isNaN(v) ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Use POST.' });

  try {
    const { ad, periodo } = await parseJsonBody(req);

    if (!ad) return res.status(400).json({ error: 'Campo "ad" ausente no body.' });

    const sp   = parseFloat(ad.spend     || 0);
    const roas = parseFloat(ad.roas      || 0);
    const rev  = parseFloat(ad.revenue   || 0);
    const luc  = parseFloat(ad.lucro     || 0);
    const pur  = parseFloat(ad.purchases || 0);
    const cpa  = parseFloat(ad.cpa       || 0);
    const cpm  = parseFloat(ad.cpm       || 0);
    const ctr  = parseFloat(ad.ctr       || 0);
    const cpcL = parseFloat(ad.cpcLink   || 0);
    const hook = ad.hookRate !== null && ad.hookRate !== undefined ? parseFloat(ad.hookRate) : null;
    const hold = ad.holdRate !== null && ad.holdRate !== undefined ? parseFloat(ad.holdRate) : null;
    const imp  = parseInt(ad.impressions || 0);

    const hookStr = hook !== null ? `${fmt(hook)}% (referência: ≥30% bom, ≥20% ok, <20% ruim)` : 'sem dados de vídeo';
    const holdStr = hold !== null ? `${fmt(hold)}% (referência: ≥20% bom, ≥12% ok, <12% ruim)` : 'sem dados de vídeo';

    const prompt = `Você é um analista sênior de tráfego pago especializado em Meta Ads. Analise a performance deste anúncio e forneça um diagnóstico objetivo e prático em português.

ANÚNCIO: ${ad.nome || 'N/D'}
PERÍODO: ${periodo || 'últimos 7 dias'}

MÉTRICAS:
- Gasto: R$ ${fmt(sp)}
- Impressões: ${imp.toLocaleString('pt-BR')}
- CPM: R$ ${fmt(cpm)} (referência: <R$20 bom, <R$40 ok, >R$40 alto)
- CTR: ${fmt(ctr)}% (referência: ≥2% bom, ≥1% ok, <1% ruim)
- CPC Link: R$ ${fmt(cpcL)}
- Hook Rate: ${hookStr}
- Hold Rate: ${holdStr}
- Compras: ${pur > 0 ? pur : 'sem dados'}
- CPA: ${cpa > 0 ? 'R$ ' + fmt(cpa) : 'sem dados'}
- ROAS: ${roas > 0 ? fmt(roas) + 'x (referência: ≥2x bom, ≥1x ok, <1x prejuízo)' : 'sem dados'}
- Faturamento: ${rev > 0 ? 'R$ ' + fmt(rev) : 'sem dados'}
- Lucro: ${rev > 0 ? 'R$ ' + fmt(luc) : 'sem dados'}

Responda APENAS com um JSON válido neste formato exato:
{
  "diagnostico": "Diagnóstico geral em 1-2 frases diretas sobre a saúde do criativo",
  "pontos": [
    "✅ ou ⚠️ ou 🔴 + observação concisa e específica sobre uma métrica",
    "✅ ou ⚠️ ou 🔴 + observação concisa e específica sobre uma métrica",
    "✅ ou ⚠️ ou 🔴 + observação concisa e específica sobre uma métrica"
  ],
  "recomendacao": "Uma ação específica e prática que o gestor deve tomar"
}

Use ✅ para métricas boas, ⚠️ para métricas medianas e 🔴 para métricas ruins. Seja direto e prático, foque no que mais impacta o resultado.`;

    const completion = await openai.chat.completions.create({
      model          : 'gpt-4o-mini',
      messages       : [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens     : 400,
      temperature    : 0.3,
    });

    const raw  = completion.choices[0].message.content;
    const data = JSON.parse(raw);

    console.log('[insights] gerado para:', ad.nome?.slice(0, 40));
    return res.status(200).json(data);

  } catch (err) {
    console.error('[insights] erro:', err.message);
    if (err.status === 401) return res.status(401).json({ error: 'OPENAI_API_KEY inválida ou ausente.' });
    return res.status(500).json({ error: err.message || 'Erro ao gerar insights.' });
  }
};
