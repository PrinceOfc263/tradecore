import WebSocket from 'ws';

const PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const MARKET_DEFINITIONS = [
  { key: 'BTCUSD', name: 'Bitcoin / USD', assetClass: 'Crypto', symbols: ['cryBTCUSD'], aliases: ['BTC/USD', 'Bitcoin/USD'] },
  { key: 'ETHUSD', name: 'Ethereum / USD', assetClass: 'Crypto', symbols: ['cryETHUSD'], aliases: ['ETH/USD', 'Ethereum/USD'] },
  { key: 'EURUSD', name: 'EUR / USD', assetClass: 'Forex', symbols: ['frxEURUSD'], aliases: ['EUR/USD', 'Euro/US Dollar'] },
  { key: 'XAUUSD', name: 'Gold / USD', assetClass: 'Metal', symbols: ['frxXAUUSD'], aliases: ['XAU/USD', 'Gold/USD', 'Gold'] },
  { key: 'GBPUSD', name: 'GBP / USD', assetClass: 'Forex', symbols: ['frxGBPUSD'], aliases: ['GBP/USD', 'Pound/US Dollar'] },
  { key: 'USDJPY', name: 'USD / JPY', assetClass: 'Forex', symbols: ['frxUSDJPY'], aliases: ['USD/JPY', 'US Dollar/Yen'] }
];

const GRANULARITIES = new Set([60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400]);
const normalize = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function resolveMarket(definition, symbols) {
  const desiredSymbols = definition.symbols.map(normalize);
  const desiredNames = definition.aliases.map(normalize);
  return symbols.find(item => desiredSymbols.includes(normalize(item.underlying_symbol || item.symbol))) ||
    symbols.find(item => desiredNames.includes(normalize(item.underlying_symbol_name || item.display_name)));
}

function asCandle(candle) {
  const epoch = Number(candle.epoch);
  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);
  if (![epoch, open, high, low, close].every(Number.isFinite)) return null;
  return { time: epoch * 1000, open, high, low, close };
}

export function getAvailableMarketKeys() {
  return MARKET_DEFINITIONS.map(({ key, name, assetClass }) => ({ key, name, assetClass }));
}

export async function fetchDerivMarkets({ keys, granularity = 3600, count = 24 } = {}) {
  if (!GRANULARITIES.has(granularity)) throw new Error('Unsupported candle interval.');
  if (!Number.isInteger(count) || count < 2 || count > 365) throw new Error('Candle count must be between 2 and 365.');
  const definitions = keys?.length ? MARKET_DEFINITIONS.filter(item => keys.includes(item.key)) : MARKET_DEFINITIONS;
  if (!definitions.length) return [];

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(PUBLIC_WS_URL, { handshakeTimeout: 8000 });
    const found = [];
    const pending = new Map();
    let nextReqId = 2;
    let completed = 0;
    let ended = false;
    const timer = setTimeout(() => finish(new Error('Market data provider timed out.')), 15_000);

    function finish(error) {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      if ((error || !found.length) && !found.length) reject(error || new Error('Deriv did not return market candles.'));
      else resolve(found);
    }

    socket.on('open', () => socket.send(JSON.stringify({ active_symbols: 'brief', req_id: 1 })));
    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return finish(new Error('Market provider returned invalid data.')); }

      if (message.error) {
        const request = pending.get(Number(message.req_id));
        if (request) {
          pending.delete(Number(message.req_id));
          completed++;
          if (pending.size === 0) finish();
          return;
        }
        return finish(new Error('Market data provider rejected the request.'));
      }

      if (Number(message.req_id) === 1 && message.msg_type === 'active_symbols') {
        const symbols = message.active_symbols || message.data?.active_symbols || [];
        for (const definition of definitions) {
          const selected = resolveMarket(definition, symbols);
          if (!selected) continue;
          const requestId = nextReqId++;
          pending.set(requestId, { definition, symbol: selected.underlying_symbol || selected.symbol });
          socket.send(JSON.stringify({
            ticks_history: selected.underlying_symbol || selected.symbol,
            end: 'latest',
            count,
            style: 'candles',
            granularity,
            req_id: requestId
          }));
        }
        if (!pending.size) return finish(new Error('No requested markets are currently available from Deriv.'));
        return;
      }

      const requestId = Number(message.req_id);
      const request = pending.get(requestId);
      if (!request || !['candles', 'history'].includes(message.msg_type)) return;
      pending.delete(requestId);
      completed++;
      const candles = (message.candles || []).map(asCandle).filter(Boolean);
      if (candles.length) {
        const first = candles[0];
        const last = candles[candles.length - 1];
        const changePct = first.open ? ((last.close - first.open) / first.open) * 100 : null;
        found.push({
          key: request.definition.key,
          name: request.definition.name,
          assetClass: request.definition.assetClass,
          symbol: request.symbol,
          price: last.close,
          changePct,
          asOf: new Date(last.time).toISOString(),
          source: 'Deriv',
          granularity,
          candles
        });
      }
      if (pending.size === 0) finish();
    });
    socket.on('error', () => finish(new Error('Could not connect to Deriv market data.')));
    socket.on('close', () => { if (!ended) finish(new Error('Deriv market data connection closed early.')); });
  });
}
