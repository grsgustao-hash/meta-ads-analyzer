// ============================================================
// POST /api/transcrever
// Aceita dois modos:
//   1. JSON { videoUrl } → baixa o vídeo server-side e transcreve
//   2. multipart/form-data com campo "file" → transcreve o arquivo enviado
// ============================================================

const { OpenAI } = require('openai');
const Busboy     = require('busboy');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');

const openai = new OpenAI(); // lê OPENAI_API_KEY do ambiente automaticamente

// ─── helpers ────────────────────────────────────────────────

/** Lê o body de uma requisição JSON e retorna o objeto parseado */
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

/** Parseia multipart/form-data e salva o primeiro arquivo em /tmp */
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

/** Apaga arquivo temporário sem bloquear a resposta */
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
    if (contentType.includes('application/json')) {
      // ── MODO 1: recebe { videoUrl } e baixa o vídeo server-side ──
      const body = await parseJsonBody(req);
      if (!body.videoUrl) return res.status(400).json({ error: 'Campo "videoUrl" é obrigatório.' });

      // Baixa o vídeo diretamente da URL (CDN da Meta)
      const videoResp = await fetch(body.videoUrl);
      if (!videoResp.ok) throw new Error(`Falha ao baixar vídeo da Meta: HTTP ${videoResp.status}`);

      const buffer = Buffer.from(await videoResp.arrayBuffer());
      if (buffer.length > 25 * 1024 * 1024) {
        return res.status(413).json({ error: 'Vídeo muito grande. Limite do Whisper: 25 MB.' });
      }

      tmpPath = path.join(os.tmpdir(), `whisper_${Date.now()}.mp4`);
      fs.writeFileSync(tmpPath, buffer);

    } else if (contentType.includes('multipart/form-data')) {
      // ── MODO 2: recebe arquivo via multipart/form-data ──
      tmpPath = await salvarArquivoTemp(req);

    } else {
      return res.status(400).json({ error: 'Content-Type deve ser application/json ou multipart/form-data.' });
    }

    // Envia para o Whisper
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
