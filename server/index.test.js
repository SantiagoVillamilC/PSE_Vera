import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, loadConfig, validPayment } from './index.js';

const token = '0123456789abcdef0123456789abcdef';
const seen = [];
const config = { host: '127.0.0.1', port: 8090, token, callbackUrl: 'http://backend.test/v1/depositos/confirmaciones' };
const server = createServer(config, async (url, options) => {
  seen.push({ url, options, body: JSON.parse(options.body) });
  return { ok: true, status: 200 };
});
let base;

before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('exponer el servicio requiere habilitación explícita', () => {
  assert.throws(() => loadConfig({ CUSTODIO_ADDR: '0.0.0.0', CUSTODIO_TOKEN: token, NUCLEO_CONFIRMACION_URL: config.callbackUrl }), /CUSTODIO_PERMITIR_EXPOSICION=true/);
  assert.equal(loadConfig({ CUSTODIO_ADDR: '0.0.0.0', CUSTODIO_PERMITIR_EXPOSICION: 'true', CUSTODIO_TOKEN: token, NUCLEO_CONFIRMACION_URL: config.callbackUrl }).host, '0.0.0.0');
});

test('solo acepta centavos positivos dentro de int64', () => {
  assert.equal(validPayment('dep-1', '150000'), true);
  for (const amount of ['', '0', '-1', '12.5', '9223372036854775808']) assert.equal(validPayment('dep-1', amount), false);
});

test('GET /pse valida referencia y monto y sirve la interfaz', async () => {
  assert.equal((await fetch(`${base}/pse?referencia=dep-1&monto=0`)).status, 400);
  const response = await fetch(`${base}/pse?referencia=dep-1&monto=150000`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /PSE simulado/);
});

test('autorizar envía el callback exacto con Bearer y CUS; cancelar no envía CUS', async () => {
  for (const action of ['autorizar', 'cancelar']) {
    const referencia = `dep-${action}`;
    const response = await fetch(`${base}/pse/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ referencia, monto: '150000' }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    const sent = seen.at(-1);
    assert.equal(sent.url, config.callbackUrl);
    assert.equal(sent.options.headers.Authorization, `Bearer ${token}`);
    assert.equal(sent.body.referencia, referencia);
    assert.equal(sent.body.monto, '150000');
    assert.equal(sent.body.moneda, 'COP');
    assert.match(sent.body.ocurrido_en, /^\d{4}-\d\d-\d\dT/);
    assert.equal(sent.body.estado, action === 'autorizar' ? 'aprobado' : 'rechazado');
    assert.equal(Boolean(sent.body.cus), action === 'autorizar');
    assert.equal(result.cus, sent.body.cus);
  }
});

test('un fallo del backend no se muestra como pago aprobado', async () => {
  const failing = createServer(config, async () => ({ ok: false, status: 503 }));
  await new Promise(resolve => failing.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${failing.address().port}/pse/autorizar`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ referencia: 'dep-falla', monto: '100' }),
    });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /Intenta de nuevo/);
  } finally { failing.close(); }
});
