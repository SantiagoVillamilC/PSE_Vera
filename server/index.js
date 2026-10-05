import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxBody = 64 * 1024;
const maxCentavos = 9223372036854775807n;

export function validPayment(referencia, monto) {
  return typeof referencia === 'string' && referencia.trim().length > 0 && referencia.length <= 128 &&
    typeof monto === 'string' && /^[1-9]\d*$/.test(monto) && BigInt(monto) <= maxCentavos;
}

export function loadConfig(env = process.env) {
  const host = env.CUSTODIO_ADDR || '127.0.0.1';
  const port = Number(env.CUSTODIO_PORT || '8090');
  const token = env.CUSTODIO_TOKEN || '';
  const callbackUrl = env.NUCLEO_CONFIRMACION_URL || '';
  const exposed = env.CUSTODIO_PERMITIR_EXPOSICION === 'true';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !exposed) {
    throw new Error('Para exponer el PSE sin login se exige CUSTODIO_PERMITIR_EXPOSICION=true');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CUSTODIO_PORT inválido');
  if (token.length < 32) throw new Error('CUSTODIO_TOKEN debe tener al menos 32 caracteres');
  let parsed;
  try { parsed = new URL(callbackUrl); } catch { throw new Error('NUCLEO_CONFIRMACION_URL inválida'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('NUCLEO_CONFIRMACION_URL debe usar HTTP(S)');
  return { host, port, token, callbackUrl };
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(body);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function readForm(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') throw Object.assign(new Error('Formulario inválido'), { status: 400 });
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > maxBody) throw Object.assign(new Error('Formulario demasiado grande'), { status: 413 });
  }
  return new URLSearchParams(data);
}

function resultPage(title, message, payment, cus = '') {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · PSE simulado</title><style>body{font:16px system-ui;background:#11142b;color:#f7f7ff;margin:0;padding:40px 22px}main{max-width:520px;margin:12vh auto}h1{font-size:2.5rem}p{line-height:1.6}dl{border-top:1px solid #555}div{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid #555;padding:12px 0}dd{margin:0;overflow-wrap:anywhere}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><dl><div><dt>Referencia</dt><dd>${escapeHtml(payment.referencia)}</dd></div><div><dt>Monto</dt><dd>${escapeHtml(payment.monto)} centavos</dd></div>${cus ? `<div><dt>CUS</dt><dd>${escapeHtml(cus)}</dd></div>` : ''}</dl></main></body></html>`;
}

export function createServer(config, fetcher = fetch, logger = console) {
  const decisions = new Map();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, 'ok');
    if (req.method === 'GET' && url.pathname === '/pse') {
      if (!validPayment(url.searchParams.get('referencia'), url.searchParams.get('monto'))) return send(res, 400, 'Referencia y monto en centavos son obligatorios');
      return send(res, 200, await readFile(path.join(root, 'index.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && ['/vue.js', '/src/main.js', '/src/style.css'].includes(url.pathname)) {
      try {
        const file = await readFile(url.pathname === '/vue.js' ? path.join(root, 'node_modules/vue/dist/vue.global.prod.js') : path.join(root, url.pathname));
        const type = url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
        return send(res, 200, file, type);
      } catch { return send(res, 404, 'No encontrado'); }
    }
    if (req.method === 'POST' && ['/pse/autorizar', '/pse/cancelar'].includes(url.pathname)) {
      const origin = req.headers.origin;
      if (origin) {
        try { if (new URL(origin).host !== req.headers.host) return send(res, 403, 'Origen no permitido'); }
        catch { return send(res, 403, 'Origen no permitido'); }
      }
      let form;
      try { form = await readForm(req); } catch (error) { return send(res, error.status || 400, error.message); }
      const referencia = form.get('referencia')?.trim();
      const monto = form.get('monto');
      if (!validPayment(referencia, monto)) return send(res, 400, 'Referencia y monto en centavos son obligatorios');
      const estado = url.pathname.endsWith('autorizar') ? 'aprobado' : 'rechazado';
      const key = `${referencia}:${monto}`;
      const existing = decisions.get(key);
      if (existing && existing.estado !== estado) return send(res, 409, 'Esta recarga ya fue resuelta');
      const cus = estado === 'aprobado' ? `cus-${createHmac('sha256', config.token).update(key).digest('hex').slice(0, 32)}` : undefined;
      const body = { referencia, estado, monto, moneda: 'COP', ocurrido_en: new Date().toISOString(), ...(cus ? { cus } : {}) };
      try {
        const response = await fetcher(config.callbackUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
          body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
          logger.error({ evento: 'callback_fallido', referencia, estado, backend_status: response.status });
          const status = response.status === 404 || response.status === 409 ? 409 : 502;
          const msg = status === 409 ? 'No se pudo confirmar esta recarga. Verifica la referencia y el monto.' : 'No se pudo contactar al servicio de recargas. Intenta de nuevo.';
          return send(res, status, JSON.stringify({ error: msg }), 'application/json; charset=utf-8');
        }
      } catch (error) {
        logger.error({ evento: 'callback_fallido', referencia, estado, error_name: error?.name, error_code: error?.cause?.code });
        return send(res, 502, JSON.stringify({ error: 'No se pudo contactar al servicio de recargas. Intenta de nuevo.' }), 'application/json; charset=utf-8');
      }
      decisions.set(key, { estado, cus });
      const result = { referencia, monto, estado, ...(cus ? { cus } : {}) };
      if (req.headers.accept?.includes('application/json')) return send(res, 200, JSON.stringify(result), 'application/json; charset=utf-8');
      return send(res, 200, resultPage(estado === 'aprobado' ? 'Pago autorizado' : 'Pago cancelado', 'La respuesta fue recibida por Vera.', result, cus), 'text/html; charset=utf-8');
    }
    send(res, 404, 'No encontrado');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  createServer(config).listen(config.port, config.host, () => console.log(`PSE simulado escuchando en ${config.host}:${config.port}`));
}
