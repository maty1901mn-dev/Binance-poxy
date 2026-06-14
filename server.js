const express = require("express");
const crypto  = require("crypto");
const axios   = require("axios");
const cors    = require("cors");
require("dotenv").config();

const app  = express();
const PORT = process.env.PORT || 3001;

const API_KEY    = process.env.BINANCE_API_KEY    || "";
const API_SECRET = process.env.BINANCE_API_SECRET || "";
const BASE       = "https://api.binance.com";

app.use(cors({ origin: "*" }));   // en producción podés restringir al dominio de tu app
app.use(express.json());

// ── Firma HMAC-SHA256 ────────────────────────────────────────────────────
function sign(params) {
  const query = new URLSearchParams({ ...params, timestamp: Date.now() }).toString();
  const sig   = crypto.createHmac("sha256", API_SECRET).update(query).digest("hex");
  return `${query}&signature=${sig}`;
}

// ── Helpers ──────────────────────────────────────────────────────────────
async function binance(method, path, params = {}, signed = false) {
  const query  = signed ? sign(params) : new URLSearchParams(params).toString();
  const url    = `${BASE}${path}${query ? "?" + query : ""}`;
  const config = {
    method,
    url,
    headers: { "X-MBX-APIKEY": API_KEY },
  };
  if (method === "POST") {
    config.data = query;
    config.url  = `${BASE}${path}`;
    config.headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const res = await axios(config);
  return res.data;
}

// ── RUTAS PÚBLICAS (sin firma) ───────────────────────────────────────────

// Precio actual
app.get("/api/price/:symbol", async (req, res) => {
  try {
    const data = await binance("GET", "/api/v3/ticker/price", { symbol: req.params.symbol });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Velas históricas
app.get("/api/klines/:symbol", async (req, res) => {
  try {
    const { interval = "1h", limit = 60 } = req.query;
    const data = await binance("GET", "/api/v3/klines", {
      symbol: req.params.symbol, interval, limit,
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Precio 24h stats
app.get("/api/ticker/:symbol", async (req, res) => {
  try {
    const data = await binance("GET", "/api/v3/ticker/24hr", { symbol: req.params.symbol });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── RUTAS PRIVADAS (con firma) ───────────────────────────────────────────

// Balance de cuenta
app.get("/api/account", async (req, res) => {
  try {
    const data = await binance("GET", "/api/v3/account", {}, true);
    const balances = data.balances
      .filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
      .map(b => ({ asset: b.asset, free: b.free, locked: b.locked }));
    res.json({ balances, canTrade: data.canTrade });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ordenes abiertas
app.get("/api/orders/open", async (req, res) => {
  try {
    const data = await binance("GET", "/api/v3/openOrders", {}, true);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Historial de ordenes de un par
app.get("/api/orders/:symbol", async (req, res) => {
  try {
    const data = await binance("GET", "/api/v3/allOrders",
      { symbol: req.params.symbol, limit: 50 }, true);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── COLOCAR ORDEN ────────────────────────────────────────────────────────
// POST /api/order  body: { symbol, side, type, quantity, price? }
app.post("/api/order", async (req, res) => {
  const { symbol, side, type = "MARKET", quantity, price } = req.body;
  if (!symbol || !side || !quantity) {
    return res.status(400).json({ error: "Faltan parametros: symbol, side, quantity" });
  }
  try {
    const params = { symbol, side: side.toUpperCase(), type, quantity };
    if (type === "LIMIT") {
      if (!price) return res.status(400).json({ error: "LIMIT requiere price" });
      params.price         = price;
      params.timeInForce   = "GTC";
    }
    const data = await binance("POST", "/api/v3/order", params, true);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// ── CANCELAR ORDEN ───────────────────────────────────────────────────────
app.delete("/api/order", async (req, res) => {
  const { symbol, orderId } = req.body;
  try {
    const data = await binance("DELETE", "/api/v3/order", { symbol, orderId }, true);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Health check
app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

// IP publica del servidor
app.get("/api/myip", async (_, res) => {
  try {
    const r = await axios.get("https://api.ipify.org?format=json");
    res.json({ ip: r.data.ip });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Binance proxy escuchando en :${PORT}`));
