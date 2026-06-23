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

app.use(cors({ origin: "*" }));
app.use(express.json());

// ── Estado del bot ────────────────────────────────────────────────────────
let bot = {
  active: false,
  strategy: "combo",
  riskPct: 2,
  symbols: ["BTCUSDT","ETHUSDT"],
  portfolio: { usdt:0, positions:{}, totalStart:0 },
  trades: [],
  gains: 0,
  signals: {},
  prices: {},
  candles: {},
  lastUpdate: null,
  loopTimer: null,
};

// ── Firma ─────────────────────────────────────────────────────────────────
function sign(params) {
  const q = new URLSearchParams({...params, timestamp:Date.now()}).toString();
  const sig = crypto.createHmac("sha256", API_SECRET).update(q).digest("hex");
  return `${q}&signature=${sig}`;
}

// ── Binance request ───────────────────────────────────────────────────────
async function bnb(method, path, params={}, signed=false) {
  const q = signed ? sign(params) : new URLSearchParams(params).toString();
  const url = `${BASE}${path}${q?"?"+q:""}`;
  const headers = {"X-MBX-APIKEY": API_KEY};
  let config = {method, url, headers};
  if(method==="POST") {
    config.data = q;
    config.url  = `${BASE}${path}`;
    config.headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const res = await axios(config);
  return res.data;
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

  let action = "HOLD";
  if(strategy === "rsi")  action = rsiBuy?"BUY":rsiSell?"SELL":"HOLD";
  if(strategy === "macd") action = macdBuy?"BUY":macdSell?"SELL":"HOLD";
  if(strategy === "bb")   action = bbBuy?"BUY":bbSell?"SELL":"HOLD";
  if(strategy === "combo") {
    const buys  = [rsiBuy, macdBuy, bbBuy].filter(Boolean).length;
    const sells = [rsiSell, macdSell, bbSell].filter(Boolean).length;
    action = buys>=2?"BUY":sells>=2?"SELL":"HOLD";
  }

  return { action, rsi:r, macdLine:m.line, bbUpper:bb.upper, bbLower:bb.lower, price };
}

// ── Fetch mercado ─────────────────────────────────────────────────────────
async function fetchMarket() {
  for(const sym of bot.symbols) {
    try {
      const [pt, kl] = await Promise.all([
        axios.get(`${BASE}/api/v3/ticker/price?symbol=${sym}`),
        axios.get(`${BASE}/api/v3/klines?symbol=${sym}&interval=1h&limit=60`),
      ]);
      const price   = parseFloat(pt.data.price);
      const closes  = kl.data.map(k => parseFloat(k[4]));
      bot.prices[sym]  = price;
      bot.candles[sym] = closes;
      bot.signals[sym] = getSignal(closes, price, bot.strategy);
      console.log(`📊 ${sym}: $${price.toFixed(4)} → ${bot.signals[sym].action} (RSI ${bot.signals[sym].rsi.toFixed(1)})`);
    } catch(e) {
      console.error(`Error fetchMarket ${sym}:`, e.message);
    }
  }
  bot.lastUpdate = new Date().toISOString();
}

// ── Ejecutar orden ────────────────────────────────────────────────────────
async function executeOrder(sym, side, price) {
  const tradeUSD = bot.portfolio.usdt * (bot.riskPct/100);

  if(side==="BUY") {
    if(bot.portfolio.positions[sym]) { console.log(`Ya tengo posición en ${sym}`); return; }
    if(tradeUSD < 10) { console.log(`Monto $${tradeUSD.toFixed(2)} menor al mínimo ($10)`); return; }
    if(bot.portfolio.usdt < tradeUSD) { console.log("Sin fondos suficientes"); return; }
  }
  if(side==="SELL") {
    if(!bot.portfolio.positions[sym]) { console.log(`Sin posición en ${sym}`); return; }
  }

  const qty = side==="BUY"
    ? parseFloat((tradeUSD/price).toFixed(6))
    : parseFloat(bot.portfolio.positions[sym].qty.toFixed(6));

  try {
    const order = await bnb("POST", "/api/v3/order", {
      symbol:sym, side, type:"MARKET", quantity:qty
    }, true);

    console.log(`✅ ${side} ${sym} qty:${qty} orderId:${order.orderId}`);

    if(side==="BUY") {
      bot.portfolio.usdt -= tradeUSD;
      bot.portfolio.positions[sym] = {qty, entry:price, value:tradeUSD};
      bot.trades.unshift({sym, action:"BUY", price, qty, time:new Date().toLocaleTimeString("es-AR"), pnl:null, orderId:order.orderId});
    } else {
      const pos   = bot.portfolio.positions[sym];
      const curVal = pos.qty * price;
      const pnl   = curVal - pos.value;
      bot.gains        += pnl;
      bot.portfolio.usdt += curVal;
      delete bot.portfolio.positions[sym];
      bot.trades.unshift({sym, action:"SELL", price, qty:pos.qty, time:new Date().toLocaleTimeString("es-AR"), pnl, orderId:order.orderId});
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

app.get("/health", (_, res) => res.json({ok:true, ts:Date.now(), botActive:bot.active}));

app.get("/api/myip", async (_, res) => {
  try { const r=await axios.get("https://api.ipify.org?format=json"); res.json({ip:r.data.ip}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// Precio público
app.get("/api/price/:symbol", async (req,res) => {
  try { res.json(await bnb("GET","/api/v3/ticker/price",{symbol:req.params.symbol})); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// Velas públicas
app.get("/api/klines/:symbol", async (req,res) => {
  try {
    const {interval="1h",limit=60}=req.query;
    res.json(await bnb("GET","/api/v3/klines",{symbol:req.params.symbol,interval,limit}));
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Balance cuenta
app.get("/api/account", async (req,res) => {
  try {
    const d = await bnb("GET","/api/v3/account",{},true);
    const balances = d.balances.filter(b=>parseFloat(b.free)>0||parseFloat(b.locked)>0);
    res.json({balances, canTrade:d.canTrade});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Orden manual
app.post("/api/order", async (req,res) => {
  const {symbol,side,type="MARKET",quantity,price}=req.body;
  if(!symbol||!side||!quantity) return res.status(400).json({error:"Faltan parámetros"});
  try {
    const params={symbol,side:side.toUpperCase(),type,quantity};
    if(type==="LIMIT"){params.price=price;params.timeInForce="GTC";}
    res.json(await bnb("POST","/api/v3/order",params,true));
  } catch(e){ res.status(500).json({error:e.response?.data||e.message}); }
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

// ── Iniciar bot ───────────────────────────────────────────────────────────
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
  res.json({ok:true, message:"Bot iniciado 24/7", config:{strategy:bot.strategy, riskPct:bot.riskPct, symbols:bot.symbols, capital:bot.portfolio.usdt}});
});

// ── Detener bot ───────────────────────────────────────────────────────────
app.post("/bot/stop", (req,res) => {
  bot.active = false;
  stopLoop();
  res.json({ok:true, message:"Bot detenido"});
});

// ── Actualizar config ─────────────────────────────────────────────────────
app.post("/bot/config", (req,res) => {
  const {strategy,riskPct,symbols} = req.body;
  if(strategy) bot.strategy = strategy;
  if(riskPct)  bot.riskPct  = parseFloat(riskPct);
  if(symbols && symbols.length > 0) bot.symbols = symbols;
  if(bot.active) startLoop();
  res.json({ok:true, config:{strategy:bot.strategy, riskPct:bot.riskPct, symbols:bot.symbols}});
});

app.listen(PORT, () => {
  console.log(`🚀 TradingBot AR corriendo en :${PORT}`);
  // Fetch inicial de mercado al arrancar
  setTimeout(fetchMarket, 3000);
});
