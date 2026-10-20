// 로컬 웹앱 서버: http://localhost:4300
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Booker } = require('./lib/booker');

const PORT = Number(process.env.PORT) || 4300;
const PUBLIC_DIR = path.join(__dirname, 'public');
const booker = new Booker();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); }
    });
  });
}

const routes = {
  'GET /api/status': async () => booker.status(),
  'POST /api/time/sync': async () => booker.syncTime(),
  'POST /api/browser/open': async (body) => {
    await booker.openBrowser(body.url);
    return booker.status();
  },
  'POST /api/games': async (body) => {
    const games = await booker.listGames(body.url);
    return { games };
  },
  'POST /api/run': async (body) => {
    await booker.start(body);
    return booker.status();
  },
  'POST /api/stop': async () => {
    booker.stop();
    return booker.status();
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = routes[`${req.method} ${url.pathname}`];
  if (route) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      send(res, 200, await route(body));
    } catch (err) {
      booker.log(`요청 실패: ${err.message}`, 'error');
      send(res, 400, { error: err.message });
    }
    return;
  }

  // 정적 파일
  const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// 로컬 PC에서만 접속 가능하도록 127.0.0.1 에만 연다.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`가을야구 자동 예매: http://localhost:${PORT}`);
  booker.syncTime().catch((e) => booker.log(`시간 동기화 실패: ${e.message}`, 'error'));
});
