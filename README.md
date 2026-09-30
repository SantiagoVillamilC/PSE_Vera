# PSE simulado

Formulario de pago simulado con Vue 3 y servidor Node.js. El servidor recibe el formulario y envía el callback al backend con el token del custodio; ese token nunca se entrega al navegador.

## Contrato

- `GET /pse?referencia=...&monto=...` presenta el monto en centavos y la referencia.
- `POST /pse/autorizar` y `POST /pse/cancelar` reciben `application/x-www-form-urlencoded` con `referencia` y `monto`.
- Ambos envían `POST` JSON a `NUCLEO_CONFIRMACION_URL`: `referencia`, `estado`, `monto` (cadena de centavos), `moneda: "COP"`, `ocurrido_en` (UTC), y `cus` solo para aprobación.
- La pantalla de éxito aparece cuando el backend acepta el callback. Si falla, permite reintentar. El CUS para una misma referencia y monto permanece estable entre reintentos.

## Desarrollo

```sh
npm ci
npm test
```

Copiar `.env.example` a `.env`, ajustar el token y la URL. El servidor requiere estas variables:

```sh
CUSTODIO_TOKEN=... NUCLEO_CONFIRMACION_URL=http://127.0.0.1:8080/v1/depositos/confirmaciones npm start
```

La rama `origin/dev` del backend registra **`/v1/depositos/confirmaciones`**. La rama local `feat/authentication` todavía registra la ruta anterior sin `/v1`; usa la URL correspondiente a la versión del API que esté ejecutándose.

## Despliegue

El Compose en `infra/custodio-simulado` toma como plantilla el de `simulador-custodia`: puerto del contenedor 8090, publicado únicamente en loopback del host. Además se conecta a la red Docker `centinela`, que ya usan el API y nginx del VPS. `CUSTODIO_PERMITIR_EXPOSICION=true` es obligatorio porque el proceso escucha en `0.0.0.0` dentro de Docker y el formulario no tiene login.

```sh
cd infra/custodio-simulado
docker compose --env-file ../../.env up -d --build
```

En el VPS, usar `NUCLEO_CONFIRMACION_URL=http://api:8080/v1/depositos/confirmaciones`. Para probar este Compose en un host sin la infraestructura del VPS, crear primero una red Docker `centinela` y ajustar la URL del API según dónde esté ejecutándose.

Crear un registro DNS `A` de `pse.veraapp.tech` a la IP pública del VPS. Emitir un certificado Let's Encrypt para ese nombre con el webroot de nginx antes de instalar `infra/nginx/pse.conf.example`; después comprobar con `nginx -t` y recargar nginx. El ejemplo resuelve `custodio-simulado` en la red Docker `centinela`.

Configurar `PSE_URL=https://pse.veraapp.tech/pse` en el entorno del API que genera la redirección. En `origin/dev` del backend todavía no aparece `PSE_URL`; esa conexión corresponde a B3. El token `CUSTODIO_TOKEN` debe ser exactamente el mismo en el API y este servicio.

## Verificación de aceptación

1. Crear un depósito en el API y abrir desde un celular con datos móviles la URL `https://pse.veraapp.tech/pse?referencia=<referencia>&monto=<centavos>`.
2. Confirmar que se ven la referencia y el monto. Tocar **Autorizar pago**.
3. Consultar `GET /v1/depositos/{id}` en `origin/dev` con la autenticación del usuario y comprobar `estado: "confirmada"`.
4. Repetir con otro depósito y **Cancelar pago**; el callback debe tener `estado: "rechazado"` y carecer de `cus`.

La prueba desde datos móviles y la configuración del dominio requieren acceso al DNS, al VPS y a un API desplegado; el repositorio deja listas las piezas para ejecutarlas allí.
