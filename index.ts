// index.ts — Telegram alert bot m5 ±3% for Binance (TypeScript + Bun)

type ExchangeInfo = {
  symbols: Array<{
    symbol: string;
    status: string;
    quoteAsset: string;
    isSpotTradingAllowed?: boolean;
    permissions?: string[];
  }>;
};

type CombinedStreamMsg =
  | { stream: string; data: KlineEvent }
  | { result?: any }; // ping/pong/ack

type KlineEvent = {
  e: "kline";
  E: number;
  s: string; // SYMBOL
  k: {
    t: number; // startTime
    T: number; // closeTime
    s: string; // symbol
    i: "5m"; // interval
    f: number; // firstTradeId
    L: number; // lastTradeId
    o: string; // open
    c: string; // close (current price during live)
    h: string; // high
    l: string; // low
    v: string; // volume
    n: number; // trade count
    x: boolean; // isClosed
    q: string; // quoteVolume
    V: string; // takerBuyBase
    Q: string; // takerBuyQuote
    B: string; // ignore
  };
};

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;
const PERCENT_THRESHOLD =
  Number(process.env.PERCENT_THRESHOLD ?? "5"); // %
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? "100");

// Exclude leveraged / synthetic tickers
const EXCLUDE_PATTERNS = [
  "UPUSDT",
  "DOWNUSDT",
  "BULLUSDT",
  "BEARUSDT",
  "VENUSDT",
  "VOLATILITY",
];

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendTelegram(text: string) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("Telegram sendMessage failed:", res.status, t);
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchSpotUSDT(): Promise<string[]> {
  const url = "https://api.binance.com/api/v3/exchangeInfo";
  const json = (await fetch(url).then((r) => r.json())) as ExchangeInfo;

  const symbols = json.symbols
    .filter((s) => s.status === "TRADING")
    .filter((s) => s.quoteAsset === "USDT")
    .filter((s) => {
      const name = s.symbol;
      if (EXCLUDE_PATTERNS.some((p) => name.includes(p))) return false;
      const spotAllowed =
        s.isSpotTradingAllowed ||
        (s.permissions && s.permissions.includes("SPOT"));
      return !!spotAllowed;
    })
    .map((s) => s.symbol);

  // Optional: limit for MVP (ví dụ 500 cặp đầu tiên để nhẹ WS)
  return symbols.slice(0, 500);
}

type CandleKey = string; // `${SYMBOL}:${startTime}`
const alertedThisCandle = new Map<CandleKey, boolean>();

function formatPct(p: number) {
  const sign = p >= 0 ? "+" : "";
  return `${sign}${p.toFixed(2)}%`;
}

function tvLink(symbol: string) {
  // TradingView symbol format for Binance spot (đa số cặp sẽ là SYMBOLUSDT)
  return `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}`;
}

function binanceLink(symbol: string) {
  return `https://www.binance.com/en/trade/${symbol}`;
}

function handleKlineEvent(ev: KlineEvent) {
  const k = ev.k;
  const symbol = ev.s;
  const start = k.t;
  const open = Number(k.o);
  const current = Number(k.c);
  if (!open || !current) return;

  const changePct = ((current - open) / open) * 100;
  const key: CandleKey = `${symbol}:${start}`;

  // Dedup: chỉ bắn 1 lần trong mỗi nến
  if (alertedThisCandle.get(key)) return;

  if (Math.abs(changePct) >= PERCENT_THRESHOLD) {
    alertedThisCandle.set(key, true);


    const icon = changePct >= 0 ? "🟢" : "🔴";
    const direction = changePct >= 0 ? "up" : "down";
    const msg =
      `${icon} <b>${symbol}</b> is ${direction}: <code>${current} ${formatPct(changePct)}</code>`
    // Fire & forget
    sendTelegram(msg).catch(console.error);
  }

  // Cleanup: giữ map không phình to (xóa các nến đã close khi thấy nến mới)
  // Nếu nến close (x===true), xóa key sau 10 phút
  if (k.x) {
    setTimeout(() => alertedThisCandle.delete(key), 10 * 60 * 1000);
  }
}

type WSGroup = {
  url: string;
  ws: WebSocket | null;
  symbols: string[];
  name: string;
  backoff: number;
};

async function startGroup(group: WSGroup) {
  const connect = () => {
    const ws = new WebSocket(group.url);
    group.ws = ws;

    ws.onopen = () => {
      console.log(`[${group.name}] connected (${group.symbols.length} symbols)`);
      group.backoff = 1000; // reset backoff
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data.toString()) as CombinedStreamMsg;
        if ((msg as any).data && (msg as any).data.e === "kline") {
          handleKlineEvent((msg as any).data as KlineEvent);
        }
      } catch (e) {
        console.error(`[${group.name}] parse error`, e);
      }
    };

    ws.onerror = (e) => {
      console.error(`[${group.name}] error`, e);
    };

    ws.onclose = async () => {
      console.warn(`[${group.name}] closed -> reconnecting...`);
      await sleep(group.backoff);
      group.backoff = Math.min(group.backoff * 2, 30000); // max 30s
      connect();
    };
  };

  connect();
}

async function main() {
  const symbols = await fetchSpotUSDT();
  // Tạo streams: symbol@kline_5m (lowercase)
  const batches = chunk(symbols, BATCH_SIZE);

  const groups: WSGroup[] = batches.map((syms, i) => {
    const streams = syms
      .map((s) => `${s.toLowerCase()}@kline_5m`)
      .join("/");
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    return {
      url,
      ws: null,
      symbols: syms,
      name: `WS-${i + 1}`,
      backoff: 1000,
    };
  });

  // Khởi động tất cả WS groups (giãn nở nhẹ để tránh burst)
  for (const g of groups) {
    await startGroup(g);
    await sleep(250);
  }

  // Dọn map định kỳ (phòng hờ)
  setInterval(() => {
    if (alertedThisCandle.size > 20000) {
      alertedThisCandle.clear();
    }
  }, 10 * 60 * 1000);
}

main().catch(async (e) => {
  console.error("Fatal:", e);
  await sendTelegram("❌ Bot crashed: " + String(e));
  process.exit(1);
});
