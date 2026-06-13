# Binance Proxy Backend

## Deploy en Railway (gratis, 5 minutos)

### Paso 1 — Subir a GitHub
1. Creá una cuenta en https://github.com si no tenés
2. Creá un repo nuevo (privado) llamado `binance-proxy`
3. Subí estos archivos al repo

### Paso 2 — Crear proyecto en Railway
1. Entrá a https://railway.app y logueate con GitHub
2. Click en **New Project** → **Deploy from GitHub repo**
3. Seleccioná tu repo `binance-proxy`
4. Railway detecta automáticamente que es Node.js y lo deployea

### Paso 3 — Configurar variables de entorno
En tu proyecto Railway:
1. Click en el servicio → pestaña **Variables**
2. Agregá:
   - `BINANCE_API_KEY` = tu API Key de Binance
   - `BINANCE_API_SECRET` = tu Secret Key de Binance
3. Railway reinicia automáticamente

### Paso 4 — Obtener tu URL
- En Railway, pestaña **Settings** → **Domains** → **Generate Domain**
- Tu URL será algo como: `https://binance-proxy-production-xxxx.up.railway.app`
- Pegá esa URL en la app (campo "URL del Backend")

## Endpoints disponibles
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | /health | Estado del servidor |
| GET | /api/price/:symbol | Precio actual |
| GET | /api/klines/:symbol | Velas históricas |
| GET | /api/ticker/:symbol | Stats 24h |
| GET | /api/account | Balance de cuenta (firmado) |
| GET | /api/orders/open | Órdenes abiertas (firmado) |
| GET | /api/orders/:symbol | Historial de órdenes (firmado) |
| POST | /api/order | Colocar orden (firmado) |
| DELETE | /api/order | Cancelar orden (firmado) |

## Seguridad
- Nunca compartas tu Secret Key
- El repo debe ser PRIVADO en GitHub
- Las claves van solo en Railway como variables de entorno
