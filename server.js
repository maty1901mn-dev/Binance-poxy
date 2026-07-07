const express = require("express");
const crypto  = require("crypto");
const axios   = require("axios");
const cors    = require("cors");
require("dotenv").config();

const app  = express();
const PORT = process.env.PORT || 3001;

const API_KEY    = process.env.BYBIT_API_KEY    || "";
const API_SECRET = process.env.BYBIT_API_SECRET || "";
const BASE        = "https://api.bybit.com";

app.use(cors({ origin: "*" }));
app.use(express.json());

// ── Estado del bot ────────────────────────────────────────────────────────
let bot = {
  active: false,
  strategy: "rsi",
  riskPct: 10,
  symbols: ["BTCUSDT","ETHUSDT","DOGEUSDT","XRPUSDT"],
  portfolio: { usdt:0, positions:{}, totalStart:0 },
  trades: [],
  gains: 0,
  signals: {},
  prices: {},
  candles: {},
  lastUpdate: null,
  loopTimer: null,
};

// ── Firma Bybit (HMAC-SHA256) ─────────────────────────────────────────────
function bybitSign(params, timestamp) {
  const recvWindow = "5000";
  const queryString = timestamp + API_KEY + recvWindow + params;
  return crypto.createHmac("sha256", API_SECRET).update(queryString).digest("hex");
}

async function bybitGet(path, params={}) {
  const timestamp = Date.now().toString();
  const qs = new URLSearchParams(params).toString();
  const sig = bybitSign(qs, timestamp);
  const url = `${BASE}${path}${qs?"?"+qs:""}`;
  const headers = {
    "X-BAPI-API-KEY": API_KEY,
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-RECV-WINDOW": "5000",
    "X-BAPI-SIGN": sig,
  };
  const res = await axios.get(url, {headers});
  return res.data;
}

async function bybitPost(path, body={}) {
  const timestamp = Date.now().toString();
  const bodyStr = JSON.stringify(body);
  const sig = bybitSign(bodyStr, timestamp);
  const headers = {
    "X-BAPI-API-KEY": API_KEY,
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-RECV-WINDOW": "5000",
    "X-BAPI-SIGN": sig,
    "Content-Type": "application/json",
  };
  const res = await axios.post(`${BASE}${path}`, body, {headers});
  return res.data;
}

// Precio público (no requiere firma)
async function publicPrice(symbol) {
  const r = await axios.get(`${BASE}/v5/market/tickers`, {params:{category:"spot", symbol}});
  return parseFloat(r.data.result.list[0].lastPrice);
}

// Velas públicas
async function publicKlines(symbol, interval="60", limit=60) {
  const r = await axios.get(`${BASE}/v5/market/kline`, {params:{category:"spot", symbol, interval, limit}});
  // Bybit devuelve [start,open,high,low,close,volume,turnover], más reciente primero
  return r.data.result.list.reverse().map(k => parseFloat(k[4]));
}

// ── Indicadores ───────────────────────────────────────────────────────────
function rsi(closes, p=14) {
  if(closes.length < p+1) return 50;
  let g=0, l=0;
  for(let i=closes.length-p; i<closes.length; i++) {
    const d = closes[i]-closes[i-1];
    if(d>0) g+=d; else l+=Math.abs(d);
  }
  const rs = l===0 ? 100 : (g/p)/(l/p);
  return 100 - 100/(1+rs);
}

function ema(arr, p) {
  const k = 2/(p+1);
  let e = arr[0];
  for(let i=1; i<arr.length; i++) e = arr[i]*k + e*(1-k);
  return e;
}

function macd(closes) {
  if(closes.length < 27) return {line:0, prevLine:0};
  const l = closes.length;
  return {
    line:     ema(closes.slice(-12),12) - ema(closes.slice(-26),26),
    prevLine: ema(closes.slice(l-13,l-1),12) - ema(closes.slice(l-27,l-1),26),
  };
}

function bollinger(closes, p=20) {
  if(closes.length < p) return {upper:999999, lower:0};
  const sl = closes.slice(-p);
  const mean = sl.reduce((a,b)=>a+b,0)/p;
  const std  = Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-mean,2),0)/p);
  return {upper: mean+2*std, lower: mean-2*std};
}

function getSignal(closes, price, strategy) {
  const r  = rsi(closes);
  const m  = macd(closes);
  const bb = bollinger(closes);

  const rsiBuy  = r < 30;
  const rsiSell = r > 70;
  const macdBuy  = m.prevLine < 0 && m.line > 0;
  const macdSell = m.prevLine > 0 && m.line < 0;
  const bbBuy  = price < bb.lower;
  const bbSell = price > bb.upper;
  
  // Para posiciones abiertas: vender con ganancia pequeña o en pérdida
  let positionPrice = null;
  for(const [sym, pos] of Object.entries(bot.portfolio.positions)) {
    positionPrice = pos.entry;
  }
  const priceUp2pct = positionPrice ? price > positionPrice * 1.02 : false;  // 2% ganancia
  const priceDown1pct = positionPrice ? price < positionPrice * 0.99 : false; // 1% pérdida

  let action = "HOLD";
  if(strategy === "rsi")  action = rsiBuy?"BUY":rsiSell?"SELL":"HOLD";
  if(strategy === "macd") action = macdBuy?"BUY":macdSell?"SELL":"HOLD";
  if(strategy === "bb")   action = bbBuy?"BUY":bbSell?"SELL":"HOLD";
  if(strategy === "combo" || strategy === "combo 2/3") {
    const buys  = [rsiBuy, macdBuy, bbBuy].filter(Boolean).length;
    const sells = [rsiSell, macdSell, bbSell].filter(Boolean).length;
    action = buys>=2?"BUY":sells>=2?"SELL":"HOLD";
  }
  // Estrategia MACD: compra y vende con profit/loss targets
  if(strategy === "macd" || strategy === "macd-agresivo") {
    if(macdBuy) action = "BUY";
    else if(macdSell || priceUp2pct || priceDown1pct) action = "SELL";
    else action = "HOLD";
  }

  return { action, rsi:r, macdLine:m.line, bbUpper:bb.upper, bbLower:bb.lower, price };
}

// ── Fetch mercado ─────────────────────────────────────────────────────────
async function fetchMarket() {
  for(const sym of bot.symbols) {
    try {
      const [price, closes] = await Promise.all([
        publicPrice(sym),
        publicKlines(sym, "60", 60),
      ]);
      bot.prices[sym]  = price;
      bot.candles[sym] = closes;
      bot.signals[sym] = getSignal(closes, price, bot.strategy);
      console.log(`📊 ${sym}: $${price.toFixed(4)} → ${bot.signals[sym].action} (RSI ${bot.signals[sym].rsi.toFixed(1)})`);
    } catch(e) {
      console.error(`Error fetchMarket ${sym}:`, e.response?.data || e.message);
    }
  }
  bot.lastUpdate = new Date().toISOString();
}

// ── Ejecutar orden ────────────────────────────────────────────────────────
async function executeOrder(sym, side, price) {
  if(side==="BUY") {
    if(bot.portfolio.positions[sym]) { console.log(`Ya tengo posición en ${sym}`); return; }
    if(bot.portfolio.usdt < 5) { console.log("Sin fondos suficientes"); return; }
  }
  if(side==="SELL") {
    if(!bot.portfolio.positions[sym]) { console.log(`Sin posición en ${sym}`); return; }
  }

  const tradeUSD = Math.min(bot.portfolio.usdt * (bot.riskPct/100), bot.portfolio.usdt);
  const finalTradeUSD = Math.max(tradeUSD, Math.min(bot.portfolio.usdt, 12));

  try {
    let orderBody;
    if(side === "BUY") {
      // Bybit Spot: comprar usando "qty" en USDT cuando marketUnit=quoteCoin
      orderBody = {
        category: "spot",
        symbol: sym,
        side: "Buy",
        orderType: "Market",
        qty: finalTradeUSD.toFixed(2),
        marketUnit: "quoteCoin",
      };
    } else {
      const pos = bot.portfolio.positions[sym];
      orderBody = {
        category: "spot",
        symbol: sym,
        side: "Sell",
        orderType: "Market",
        qty: pos.qty.toString(),
        marketUnit: "baseCoin",
      };
    }

    const result = await bybitPost("/v5/order/create", orderBody);

    if(result.retCode !== 0) {
      console.error(`❌ Bybit rechazó orden:`, result.retMsg);
      return;
    }

    console.log(`✅ ${side} ${sym} orderId:${result.result.orderId}`);

    if(side==="BUY") {
      const qty = finalTradeUSD / price;
      bot.portfolio.usdt -= finalTradeUSD;
      bot.portfolio.positions[sym] = {qty, entry:price, value:finalTradeUSD};
      bot.trades.unshift({sym, action:"BUY", price, qty, time:new Date().toLocaleTimeString("es-AR"), pnl:null, orderId:result.result.orderId});
    } else {
      const pos = bot.portfolio.positions[sym];
      const curVal = pos.qty * price;
      const pnl = curVal - pos.value;
      bot.gains += pnl;
      bot.portfolio.usdt += curVal;
      delete bot.portfolio.positions[sym];
      bot.trades.unshift({sym, action:"SELL", price, qty:pos.qty, time:new Date().toLocaleTimeString("es-AR"), pnl, orderId:result.result.orderId});
    }
    bot.trades = bot.trades.slice(0, 100);
  } catch(e) {
    console.error(`❌ Error orden ${side} ${sym}:`, e.response?.data || e.message);
  }
}

// ── Loop del bot ──────────────────────────────────────────────────────────
async function botLoop() {
  if(!bot.active) return;
  console.log("🔄 Bot loop:", new Date().toLocaleTimeString("es-AR"));
  await fetchMarket();
  for(const [sym, sig] of Object.entries(bot.signals)) {
    if(sig.action === "BUY" || sig.action === "SELL") {
      await executeOrder(sym, sig.action, sig.price);
    }
  }
}

function startLoop() {
  if(bot.loopTimer) clearInterval(bot.loopTimer);
  botLoop();
  bot.loopTimer = setInterval(botLoop, 60000);
  console.log("🟢 Bot loop iniciado");
}

function stopLoop() {
  if(bot.loopTimer) clearInterval(bot.loopTimer);
  bot.loopTimer = null;
  console.log("🔴 Bot loop detenido");
}

// ── Keep-alive ────────────────────────────────────────────────────────────
const SELF = process.env.SELF_URL || "";
if(SELF) {
  setInterval(async () => {
    try {
      await axios.get(`https://${SELF}/health`);
      console.log("💓 Keep-alive OK");
    } catch(e) { console.warn("Keep-alive error:", e.message); }
  }, 4 * 60 * 1000);
}

// ═══════════════════════════════════════════════════════════════════════════
// RUTAS
// ═══════════════════════════════════════════════════════════════════════════

app.get("/health", (_, res) => res.json({ok:true, ts:Date.now(), botActive:bot.active, exchange:"bybit"}));

app.get("/api/myip", async (_, res) => {
  try { const r=await axios.get("https://api.ipify.org?format=json"); res.json({ip:r.data.ip}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// Diagnóstico
app.get("/api/test", async (_, res) => {
  try {
    const price = await publicPrice("BTCUSDT");
    res.json({ok:true, btcPrice:price, msg:"Bybit accesible desde Railway"});
  } catch(e) {
    res.json({ok:false, error:e.message, msg:"Error conectando a Bybit"});
  }
});

app.get("/api/fetch-now", async (_, res) => {
  try {
    await fetchMarket();
    res.json({ok:true, signals:bot.signals, prices:bot.prices, lastUpdate:bot.lastUpdate});
  } catch(e) { res.json({ok:false, error:e.message}); }
});

// Precio público
app.get("/api/price/:symbol", async (req,res) => {
  try { res.json({price: await publicPrice(req.params.symbol)}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// Velas públicas
app.get("/api/klines/:symbol", async (req,res) => {
  try {
    const {interval="60",limit=60}=req.query;
    res.json(await publicKlines(req.params.symbol, interval, limit));
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Balance cuenta — wallet unificado de Bybit
app.get("/api/account", async (req,res) => {
  try {
    const d = await bybitGet("/v5/account/wallet-balance", {accountType:"UNIFIED"});
    if(d.retCode !== 0) return res.status(401).json({error: d.retMsg});
    const coins = d.result.list[0]?.coin || [];
    const balances = coins.filter(c=>parseFloat(c.walletBalance)>0).map(c=>({asset:c.coin, free:c.walletBalance}));
    res.json({balances, retCode:d.retCode});
  } catch(e){ res.status(500).json({error: e.response?.data || e.message}); }
});

// Orden manual
app.post("/api/order", async (req,res) => {
  const {symbol,side,qty,marketUnit="quoteCoin"}=req.body;
  if(!symbol||!side||!qty) return res.status(400).json({error:"Faltan parámetros"});
  try {
    const result = await bybitPost("/v5/order/create", {
      category:"spot", symbol, side, orderType:"Market", qty:qty.toString(), marketUnit
    });
    res.json(result);
  } catch(e){ res.status(500).json({error: e.response?.data || e.message}); }
});

// ── Estado del bot ────────────────────────────────────────────────────────
app.get("/bot/status", (req,res) => {
  const posVal = Object.entries(bot.portfolio.positions)
    .reduce((s,[sym,pos])=>s+(bot.prices[sym]||pos.entry)*pos.qty, 0);
  res.json({
    active:      bot.active,
    strategy:    bot.strategy,
    riskPct:     bot.riskPct,
    symbols:     bot.symbols,
    portfolio:   bot.portfolio,
    positionsValue: posVal,
    totalValue:  bot.portfolio.usdt + posVal,
    gains:       bot.gains,
    trades:      bot.trades,
    signals:     bot.signals,
    prices:      bot.prices,
    lastUpdate:  bot.lastUpdate,
  });
});

app.post("/bot/start", async (req,res) => {
  const {strategy, riskPct, symbols, capitalUSDT} = req.body;
  if(strategy)     bot.strategy = strategy;
  if(riskPct)      bot.riskPct  = parseFloat(riskPct);
  if(symbols && symbols.length > 0) bot.symbols = symbols;
  if(capitalUSDT && bot.portfolio.totalStart === 0) {
    bot.portfolio.usdt       = parseFloat(capitalUSDT);
    bot.portfolio.totalStart = parseFloat(capitalUSDT);
  }
  bot.active = true;
  startLoop();
  res.json({ok:true, message:"Bot iniciado 24/7 en Bybit", config:{strategy:bot.strategy, riskPct:bot.riskPct, symbols:bot.symbols, capital:bot.portfolio.usdt}});
});

app.post("/bot/stop", (req,res) => {
  bot.active = false;
  stopLoop();
  res.json({ok:true, message:"Bot detenido"});
});

app.post("/bot/config", (req,res) => {
  const {strategy,riskPct,symbols} = req.body;
  if(strategy) bot.strategy = strategy;
  if(riskPct)  bot.riskPct  = parseFloat(riskPct);
  if(symbols && symbols.length > 0) bot.symbols = symbols;
  if(bot.active) startLoop();
  res.json({ok:true, config:{strategy:bot.strategy, riskPct:bot.riskPct, symbols:bot.symbols}});
});

// ── Reset completo del bot ────────────────────────────────────────────────
app.post("/bot/reset", (req,res) => {
  stopLoop();
  bot = {
    active: false,
    strategy: "rsi",
    riskPct: 10,
    symbols: ["BTCUSDT","ETHUSDT","DOGEUSDT","XRPUSDT"],
    portfolio: { usdt:0, positions:{}, totalStart:0 },
    trades: [],
    gains: 0,
    signals: {},
    prices: {},
    candles: {},
    lastUpdate: null,
    loopTimer: null,
  };
  console.log("🔄 Bot reseteado completamente");
  res.json({ok:true, message:"Bot reseteado. Todos los datos fueron limpiados."});
});

app.listen(PORT, () => {
  console.log(`🚀 TradingBot AR (Bybit) corriendo en :${PORT}`);
  setTimeout(fetchMarket, 3000);
});
