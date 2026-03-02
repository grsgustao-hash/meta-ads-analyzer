// ============================================================
// POST /api/transcrever
// Recebe um vídeo mp4 via multipart/form-data,
// envia para o Whisper-1 da OpenAI e retorna o texto transcrito.
// O arquivo temporário é apagado após o uso.
// ============================================================

const { OpenAI }  = require('openai');
const Busboy       = require('busboy');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');

// Instância global reutilizável (usa OPENAI_API_KEY do ambiente automaticamente)
const openai = new OpenAI();

// ─── helpers ────────────────────────────────────────────────

/**
 * Parseia multipart/form-data e salva o primeiro arquivo em /tmp.
 * Retorna o caminho completo do arquivo temporário.
 */
function salvarArquivoTemp(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });

    let tmpPath   = null;
    let gravado   = false;

    bb.on('file', (_field, stream, info) => {
      // Sanitiza o nome para evitar path traversal
      const nomeSeguro = path.basename(info.filename || 'audio.mp4');
      tmpPath = path.join(os.tmpdir(), `whisper_${Date.now()}_${nomeSeguro}`);

      const writer = fs.createWriteStream(tmpPath);
      stream.pipe(writer);

      writer.on('finish', () => {
        gravado = true;
        resolve(tmpPath);
      });
      writer.on('error', reject);
    });

    bb.on('finish', () => {
      if (!gravado) reject(new Error('Nenhum arquivo encontrado na requisição.'));
    });

    bb.on('error', reject);

    req.pipe(bb);
  });
}

/**
 * Remove o arquivo temporário sem bloquear a resposta.
 */
function apagarTemp(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, (err) => {
    if (err) console.warn('[transcrever] falha ao apagar temp:', err.message);
  });
}

// ─── handler ────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // CORS — ajuste a origem conforme necessário em produção
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Método não permitido. Use POST.' });

  // Valida Content-Type antecipadamente para retornar erro claro
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return res.status(400).json({ error: 'Content-Type deve ser multipart/form-data.' });
  }

  let tmpPath = null;

  try {
    // 1. Salva o arquivo recebido em /tmp
    tmpPath = await salvarArquivoTemp(req);

    // 2. Envia para a API do Whisper
    //    file: aceita ReadStream — o SDK monta o form internamente
    const resultado = await openai.audio.transcriptions.create({
      file    : fs.createReadStream(tmpPath),
      model   : 'whisper-1',
      language: 'pt',          // Força idioma português
      // response_format: 'text' // Use 'text' se quiser só a string crua sem JSON
    });

    // 3. Retorna apenas o texto
    return res.status(200).json({ text: resultado.text });

  } catch (err) {
    console.error('[transcrever] erro:', err.message);

    // Mensagens amigáveis para erros conhecidos da OpenAI
    if (err.status === 413 || err.message?.includes('too large')) {
      return res.status(413).json({ error: 'Arquivo muito grande. Limite do Whisper: 25 MB.' });
    }
    if (err.status === 401) {
      return res.status(401).json({ error: 'OPENAI_API_KEY inválida ou ausente.' });
    }

    return res.status(500).json({ error: err.message || 'Erro interno na transcrição.' });

  } finally {
    // 4. Garante a remoção do temp em qualquer cenário (sucesso ou erro)
    apagarTemp(tmpPath);
  }
};
