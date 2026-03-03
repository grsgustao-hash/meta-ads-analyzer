// ============================================================
// POST /api/transcrever
// Modos aceitos:
//   1. JSON { videoUrl }          → baixa e transcreve direto
//   2. JSON { creativeId, storyId } → resolve vídeo server-side (page token)
//   3. multipart/form-data file   → transcreve arquivo enviado
// ============================================================

const { OpenAI } = require('openai');
const Busboy     = require('busboy');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');

const openai = new OpenAI();

const META_TOKEN   = process.env.META_ACCESS_TOKEN;
const META_VERSION = 'v21.0';
const META_BASE    = `https://graph.facebook.com/${META_VERSION}`;

// ─── Meta Graph API helpers ──────────────────────────────────

function metaUrl(endpoint, params = {}, token = META_TOKEN) {
  const qs = new URLSearchParams({ ...params, access_token: token });
  return `${META_BASE}/${endpoint}?${qs}`;
}

async function metaGet(endpoint, params = {}, token = META_TOKEN) {
  const r = await fetch(metaUrl(endpoint, params, token));
  return r.json();
}

// ─── Resolve video URL server-side ──────────────────────────

async function resolveVideoUrl(creativeId, storyId) {
  const log = [];

  // 1. Buscar video_id no criativo
  const cData = await metaGet(creativeId, {
    fields: 'video_id,object_story_spec,asset_feed_spec',
  });

  const videoId = cData.video_id
    || cData.object_story_spec?.video_data?.video_id
    || cData.object_story_spec?.link_data?.child_attachments?.[0]?.video_id
    || cData.asset_feed_spec?.videos?.[0]?.video_id;

  log.push(`creative→videoId: ${videoId || 'none'}`);

  let videoUrl = null;

  // 2. Tentar source direto (token principal)
  if (videoId) {
    const vData = await metaGet(videoId, {
      fields: 'source,download_hd_url,download_sd_url,format',
    });
    videoUrl = vData.source || vData.download_hd_url || vData.download_sd_url;

    if (!videoUrl && vData.format?.length) {
      const best = vData.format.find(f => f.source) || vData.format[0];
      if (best?.source) videoUrl = best.source;
    }
    log.push(`direct source: ${videoUrl ? 'ok' : 'none'}`);
  }

  // 3. Tentar page access token → source
  if (!videoUrl && storyId && videoId) {
    const pageId = storyId.split('_')[0];
    const pageData = await metaGet(pageId, { fields: 'access_token' });

    if (pageData.access_token) {
      log.push('page token: obtained');
      const pvData = await metaGet(videoId, {
        fields: 'source,download_hd_url,download_sd_url',
      }, pageData.access_token);
      videoUrl = pvData.source || pvData.download_hd_url || pvData.download_sd_url;
      log.push(`page token source: ${videoUrl ? 'ok' : 'none'}`);
    } else {
      log.push(`page token: not available (${pageData.error?.message || 'no field'})`);
    }
  }

  // 4. Fallback: post attachments (media.source / media.video.source)
  if (!videoUrl && storyId) {
    const sData = await metaGet(storyId, {
      fields: 'attachments{media_type,type,media,subattachments{media_type,type,media}}',
    });

    const allAttach = [];
    (sData.attachments?.data || []).forEach(a => {
      allAttach.push(a);
      (a.subattachments?.data || []).forEach(s => allAttach.push(s));
    });

    for (const a of allAttach) {
      const src = a.media?.source || a.media?.video?.source;
      if (src) { videoUrl = src; break; }
    }
    log.push(`attachments: ${videoUrl ? 'ok' : 'none'}`);
  }

  console.log('[transcrever] resolveVideoUrl:', log.join(' | '));
  return { videoId, videoUrl };
}

// ─── Multipart file helper ───────────────────────────────────

function salvarArquivoTemp(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    let tmpPath = null, gravado = false;

    bb.on('file', (_field, stream, info) => {
      const nomeSeguro = path.basename(info.filename || 'audio.mp4');
      tmpPath = path.join(os.tmpdir(), `whisper_${Date.now()}_${nomeSeguro}`);
      const writer = fs.createWriteStream(tmpPath);
      stream.pipe(writer);
      writer.on('finish', () => { gravado = true; resolve(tmpPath); });
      writer.on('error', reject);
    });

    bb.on('finish', () => { if (!gravado) reject(new Error('Nenhum arquivo encontrado na requisição.')); });
    bb.on('error', reject);
    req.pipe(bb);
  });
}

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

function apagarTemp(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, err => { if (err) console.warn('[transcrever] falha ao apagar temp:', err.message); });
}

// ─── handler ────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Método não permitido. Use POST.' });

  const contentType = req.headers['content-type'] || '';
  let tmpPath = null;

  try {
    if (contentType.includes('multipart/form-data')) {
      // ── MODO 3: arquivo enviado via form ──
      tmpPath = await salvarArquivoTemp(req);

    } else if (contentType.includes('application/json')) {
      const body = await parseJsonBody(req);

      if (body.creativeId) {
        // ── MODO 2: resolve URL server-side via Graph API ──
        if (!META_TOKEN) return res.status(500).json({ error: 'META_ACCESS_TOKEN não configurado no servidor.' });

        const { videoId, videoUrl } = await resolveVideoUrl(body.creativeId, body.storyId || '');

        if (!videoUrl) {
          const why = !videoId
            ? 'criativo não contém vídeo (provavelmente anúncio de imagem)'
            : 'token sem permissão suficiente para acessar o vídeo (video_management necessário)';
          return res.status(422).json({ error: `Vídeo não acessível: ${why}.` });
        }

        // Baixa o vídeo
        const videoResp = await fetch(videoUrl);
        if (!videoResp.ok) throw new Error(`Falha ao baixar vídeo: HTTP ${videoResp.status}`);
        const buffer = Buffer.from(await videoResp.arrayBuffer());
        if (buffer.length > 25 * 1024 * 1024) return res.status(413).json({ error: 'Vídeo muito grande. Limite Whisper: 25 MB.' });

        tmpPath = path.join(os.tmpdir(), `whisper_${Date.now()}.mp4`);
        fs.writeFileSync(tmpPath, buffer);

      } else if (body.videoUrl) {
        // ── MODO 1: URL direta fornecida ──
        const videoResp = await fetch(body.videoUrl);
        if (!videoResp.ok) throw new Error(`Falha ao baixar vídeo: HTTP ${videoResp.status}`);
        const buffer = Buffer.from(await videoResp.arrayBuffer());
        if (buffer.length > 25 * 1024 * 1024) return res.status(413).json({ error: 'Vídeo muito grande. Limite Whisper: 25 MB.' });

        tmpPath = path.join(os.tmpdir(), `whisper_${Date.now()}.mp4`);
        fs.writeFileSync(tmpPath, buffer);

      } else {
        return res.status(400).json({ error: 'Body deve conter "videoUrl" ou "creativeId".' });
      }

    } else {
      return res.status(400).json({ error: 'Content-Type deve ser application/json ou multipart/form-data.' });
    }

    // Whisper
    const resultado = await openai.audio.transcriptions.create({
      file    : fs.createReadStream(tmpPath),
      model   : 'whisper-1',
      language: 'pt',
    });

    return res.status(200).json({ text: resultado.text });

  } catch (err) {
    console.error('[transcrever] erro:', err.message);
    if (err.status === 401) return res.status(401).json({ error: 'OPENAI_API_KEY inválida ou ausente.' });
    return res.status(500).json({ error: err.message || 'Erro interno na transcrição.' });

  } finally {
    apagarTemp(tmpPath);
  }
};
