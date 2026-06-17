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

// ── Estado del bot (en memoria) ───────────────────────────────────────────
let botState = {
  active: false,
  strategy: "combo",
  riskPct: 2,
  symbols: ["BTCUSDT","ETHUSDT"],
  portfolio: { usdt: 0, positions: {}, totalStart: 0 },
  trades: [],
  gains: 0,
  signals: {},
  prices: {},
  lastUpdate: null,
  interval: null,
};

// ── Firma HMAC-SHA256 ─────────────────────────────────────────────────────
function sign(params) {
  const query = new URLSearchParams({ ...params, timestamp: Date.now() }).toString();
  const sig   = crypto.createHmac("sha256", API_SECRET).update(query).digest("hex");
  return `${query}&signature=${sig}`;
}

// ── Binance API ───────────────────────────────────────────────────────────
async function binance(method, path, params={}, signed=false) {
  const query = signed ? sign(params) : new URLSearchParams(params).toString();
  const url   = `${BASE}${path}${query?"?"+query:""}`;
  const config = { method, url, headers:{"X-MBX-APIKEY":API_KEY} };
  if(method==="POST") {
    config.data = query;
    config.url  = `${BASE}${path}`;
    config.headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const res = await axios(config);
  return res.data;
}

// ── Indicadores ───────────────────────────────────────────────────────────
function calcRSI(closes, p=14) {
  if(closes.length<p+1) return null;
  let g=0,l=0;
  for(let i=closes.length-p;i<closes.length;i++){const d=closes[i]-closes[i-1];if(d>0)g+=d;else l+=Math.abs(d);}
  const rs=l===0?100:(g/p)/(l/p);
  return 100-100/(1+rs);
}
function calcEMA(arr,p){const k=2/(p+1);let e=arr[0];for(let i=1;i<arr.length;i++)e=arr[i]*k+e*(1-k);return e;}
function calcMACD(closes){
  if(closes.length<27)return null;
  const l=closes.length;
  return{line:calcEMA(closes.slice(-12),12)-calcEMA(closes.slice(-26),26),prevLine:calcEMA(closes.slice(l-13,l-1),12)-calcEMA(closes.slice(l-27,l-1),26)};
}
function calcBB(closes,p=20){
  if(closes.length<p)return null;
  const sl=closes.slice(-p),mean=sl.reduce((a,b)=>a+b,0)/p;
  const std=Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-mean,2),0)/p);
  return{upper:mean+2*std,lower:mean-2*std};
}
function evalSignal(candles, strategy) {
  const closes=candles.map(c=>c.close), price=closes[closes.length-1];
  const rsi=calcRSI(closes),macd=calcMACD(closes),bb=calcBB(closes);
  const rsiBuy=rsi!==null&&rsi<30,rsiSell=rsi!==null&&rsi>70;
  const macdBuy=macd!==null&&macd.prevLine<0&&macd.line>0,macdSell=macd!==null&&macd.prevLine>0&&macd.line<0;
  const bbBuy=bb!==null&&price<bb.lower,bbSell=bb!==null&&price>bb.upper;
  let action="HOLD";
  if(strategy==="rsi") action=rsiBuy?"BUY":rsiSell?"SELL":"HOLD";
  if(strategy==="macd") action=macdBuy?"BUY":macdSell?"SELL":"HOLD";
  if(strategy==="bb") action=bbBuy?"BUY":bbSell?"SELL":"HOLD";
  if(strategy==="combo"){const b=[rsiBuy,macdBuy,bbBuy].filter(Boolean).length,s=[rsiSell,macdSell,bbSell].filter(Boolean).length;action=b>=2?"BUY":s>=2?"SELL":"HOLD";}
  return{action,rsi,macd,bb,price};
}

// ── Fetch precios y señales ───────────────────────────────────────────────
async function fetchMarket() {
  for(const sym of botState.symbols) {
    try {
      const [pt, kl] = await Promise.all([
        axios.get(`${BASE}/api/v3/ticker/price?symbol=${sym}`),
        axios.get(`${BASE}/api/v3/klines?symbol=${sym}&interval=1h&limit=60`),
      ]);
      const price = parseFloat(pt.data.price);
      const candles = kl.data.map(k=>({open:parseFloat(k[1]),high:parseFloat(k[2]),low:parseFloat(k[3]),close:parseFloat(k[4])}));
      botState.prices[sym] = price;
      botState.signals[sym] = candles.length>20 ? evalSignal(candles, botState.strategy) : {action:"HOLD",rsi:null,price};
    } catch(e){ console.error("fetchMarket error",sym,e.message); }
  }
  botState.lastUpdate = new Date().toISOString();
}

// ── Ejecutar orden ────────────────────────────────────────────────────────
async function executeOrder(sym, side, price) {
  const tradeUSD = botState.portfolio.usdt * (botState.riskPct/100);
  if(side==="BUY" && botState.portfolio.usdt < tradeUSD) { console.log("Sin fondos suficientes"); return; }
  if(side==="SELL" && !botState.portfolio.positions[sym]) { console.log("Sin posición abierta"); return; }
  if(tradeUSD < 10 && side==="BUY") { console.log("Monto menor al mínimo Binance ($10)"); return; }

  const qty = side==="BUY"
    ? parseFloat((tradeUSD/price).toFixed(6))
    : parseFloat(botState.portfolio.positions[sym].qty.toFixed(6));

  try {
    const order = await binance("POST", "/api/v3/order", {symbol:sym, side, type:"MARKET", quantity:qty}, true);
    console.log(`✅ Orden ${side} ${sym}: #${order.orderId}`);

    if(side==="BUY") {
      botState.portfolio.usdt -= tradeUSD;
      botState.portfolio.positions[sym] = {qty, entry:price, value:tradeUSD};
      botState.trades.unshift({sym, action:"BUY", price, qty, time:new Date().toLocaleTimeString(), pnl:null, orderId:order.orderId});
    } else {
      const pos=botState.portfolio.positions[sym], curVal=pos.qty*price, pnl=curVal-pos.value;
      botState.gains += pnl;
      botState.portfolio.usdt += curVal;
      delete botState.portfolio.positions[sym];
      botState.trades.unshift({sym, action:"SELL", price, qty:pos.qty, time:new Date().toLocaleTimeString(), pnl, orderId:order.orderId});
    }
    botState.trades = botState.trades.slice(0,100);
  } catch(e) {
    console.error(`❌ Error orden ${side} ${sym}:`, e.response?.data||e.message);
  }
}

// ── Loop del bot ──────────────────────────────────────────────────────────
async function botLoop() {
  console.log("🤖 Bot loop ejecutando...", new Date().toLocaleTimeString());
  await fetchMarket();
  for(const [sym, sig] of Object.entries(botState.signals)) {
    if(sig.action==="BUY"||sig.action==="SELL") await executeOrder(sym, sig.action, sig.price);
  }
}

function startBot() {
  if(botState.interval) clearInterval(botState.interval);
  botLoop(); // ejecutar inmediatamente
  botState.interval = setInterval(botLoop, 60000);
  botState.active = true;
  console.log("🟢 Bot iniciado");
}

function stopBot() {
  if(botState.interval) clearInterval(botState.interval);
  botState.interval = null;
  botState.active = false;
  console.log("🔴 Bot detenido");
}

// ── RUTAS PÚBLICAS ────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok:true, ts:Date.now() }));

app.get("/api/myip", async (_, res) => {
  try { const r=await axios.get("https://api.ipify.org?format=json"); res.json({ip:r.data.ip}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.get("/api/price/:symbol", async (req,res) => {
  try { const d=await binance("GET","/api/v3/ticker/price",{symbol:req.params.symbol}); res.json(d); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.get("/api/klines/:symbol", async (req,res) => {
  try {
    const {interval="1h",limit=60}=req.query;
    const d=await binance("GET","/api/v3/klines",{symbol:req.params.symbol,interval,limit});
    res.json(d);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── RUTAS PRIVADAS ────────────────────────────────────────────────────────
app.get("/api/account", async (req,res) => {
  try {
    const d=await binance("GET","/api/v3/account",{},true);
    const balances=d.balances.filter(b=>parseFloat(b.free)>0||parseFloat(b.locked)>0).map(b=>({asset:b.asset,free:b.free,locked:b.locked}));
    res.json({balances,canTrade:d.canTrade});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post("/api/order", async (req,res) => {
  const {symbol,side,type="MARKET",quantity,price}=req.body;
  if(!symbol||!side||!quantity) return res.status(400).json({error:"Faltan parámetros"});
  try {
    const params={symbol,side:side.toUpperCase(),type,quantity};
    if(type==="LIMIT"){if(!price)return res.status(400).json({error:"LIMIT requiere price"});params.price=price;params.timeInForce="GTC";}
    const d=await binance("POST","/api/v3/order",params,true);
    res.json(d);
  } catch(e){ res.status(500).json({error:e.response?.data||e.message}); }
});

// ── RUTAS DEL BOT 24/7 ───────────────────────────────────────────────────

// Estado completo del bot
app.get("/bot/status", (req,res) => {
  const posVal = Object.entries(botState.portfolio.positions).reduce((s,[sym,pos])=>s+(botState.prices[sym]||pos.entry)*pos.qty,0);
  res.json({
    active: botState.active,
    strategy: botState.strategy,
    riskPct: botState.riskPct,
    symbols: botState.symbols,
    portfolio: botState.portfolio,
    positionsValue: posVal,
    totalValue: botState.portfolio.usdt + posVal,
    gains: botState.gains,
    trades: botState.trades,
    signals: botState.signals,
    prices: botState.prices,
    lastUpdate: botState.lastUpdate,
  });
});

// Configurar e iniciar bot
app.post("/bot/start", async (req,res) => {
  const {strategy, riskPct, symbols, capitalUSDT} = req.body;
  if(strategy) botState.strategy = strategy;
  if(riskPct)  botState.riskPct  = parseFloat(riskPct);
  if(symbols)  botState.symbols  = symbols;
  if(capitalUSDT) {
    botState.portfolio.usdt = parseFloat(capitalUSDT);
    botState.portfolio.totalStart = parseFloat(capitalUSDT);
  }
  startBot();
  res.json({ok:true, message:"Bot iniciado en servidor 24/7", config:{strategy:botState.strategy,riskPct:botState.riskPct,symbols:botState.symbols}});
});

// Detener bot
app.post("/bot/stop", (req,res) => {
  stopBot();
  res.json({ok:true, message:"Bot detenido"});
});

// Actualizar config sin reiniciar
app.post("/bot/config", (req,res) => {
  const {strategy,riskPct,symbols} = req.body;
  if(strategy) botState.strategy = strategy;
  if(riskPct)  botState.riskPct  = parseFloat(riskPct);
  if(symbols)  botState.symbols  = symbols;
  res.json({ok:true, config:botState});
});

// ── Keep-alive: evita que Railway duerma el servidor ─────────────────────
const SELF_URL = process.env.RAILWAY_STATIC_URL || process.env.SELF_URL || "";
if (SELF_URL) {
  setInterval(async () => {
    try {
      await axios.get(`https://${SELF_URL}/health`);
      console.log("💓 Keep-alive ping OK");
    } catch(e) { console.warn("Keep-alive error:", e.message); }
  }, 4 * 60 * 1000); // cada 4 minutos
}

app.listen(PORT, () => console.log(`🚀 Servidor en :${PORT}`));
