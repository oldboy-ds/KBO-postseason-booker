// 전용 크롬을 조작해서 정해진 시각에 "예매하기" 버튼을 클릭하는 엔진.
const path = require('path');
const { chromium } = require('playwright');
const { measureOffset } = require('./ntp');

const PROFILE_DIR = path.join(__dirname, '..', 'browser-profile');
const BUTTON_TEXT = '예매하기';

// ---------- 페이지 안에서 실행되는 코드 ----------

// 페이지의 "예매하기" 버튼과 각 버튼이 속한 경기 카드 정보를 찾는다.
// window.__booker 에 헬퍼를 설치하고, 경기 목록을 반환한다.
function pageInstallHelpers(buttonText) {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function findButtons() {
    return [...document.querySelectorAll('button, a, [role="button"]')]
      .filter((el) => norm(el.textContent) === buttonText);
  }

  // 버튼에서 위로 올라가며 "예매하기" 버튼이 하나만 들어 있는 가장 큰 조상을 카드로 본다.
  function cardOf(btn, all) {
    let card = btn;
    while (card.parentElement) {
      const parent = card.parentElement;
      const count = all.filter((b) => parent.contains(b)).length;
      if (count !== 1) break;
      card = parent;
      if (card === document.body) break;
    }
    return card;
  }

  function cardKey(card) {
    return norm(card.innerText.replace(new RegExp(buttonText, 'g'), ' '));
  }

  function listGames() {
    const all = findButtons();
    return all.map((btn, index) => {
      const card = cardOf(btn, all);
      return { index, key: cardKey(card) };
    });
  }

  function findByKey(key) {
    const all = findButtons();
    for (const btn of all) {
      if (cardKey(cardOf(btn, all)) === key) return btn;
    }
    return null;
  }

  // 버튼의 "활성화 상태"를 나타내는 값들. 이 값이 바뀌면 활성화된 것으로 본다.
  // (색상·커서는 마우스 hover 만으로도 바뀌므로 넣지 않는다)
  function signature(btn) {
    const cs = getComputedStyle(btn);
    return JSON.stringify([
      btn.disabled === true,
      btn.getAttribute('aria-disabled'),
      btn.className,
      btn.getAttribute('style'),
      cs.pointerEvents,
    ]);
  }

  function rectOf(btn) {
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }

  function isEnabled(btn) {
    return !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' &&
      getComputedStyle(btn).pointerEvents !== 'none';
  }

  function sigByKey(key) {
    const btn = findByKey(key);
    return btn ? signature(btn) : null;
  }

  window.__booker = { listGames, findByKey, signature, sigByKey, isEnabled, rectOf, watcher: null };
  return listGames();
}

// 대상 버튼을 감시하다가 상태가 바뀌는 순간 Node 쪽에 좌표를 보낸다.
function pageArmWatcher(key) {
  const B = window.__booker;
  if (B.watcher) B.watcher.stop();

  let btn = B.findByKey(key);
  if (!btn) return { ok: false, reason: '대상 경기의 예매하기 버튼을 찾지 못했습니다' };
  btn.scrollIntoView({ block: 'center', inline: 'center' });

  let lastSig = B.signature(btn);
  let stopped = false;

  function check() {
    if (stopped) return;
    if (!btn.isConnected) {
      const again = B.findByKey(key);
      if (!again) return;
      btn = again;
    }
    const sig = B.signature(btn);
    if (sig !== lastSig) {
      const prev = lastSig;
      lastSig = sig;
      window.__bookerSignal({ type: 'changed', rect: B.rectOf(btn), prev, sig, enabled: B.isEnabled(btn) });
    }
  }

  const observer = new MutationObserver(check);
  observer.observe(document.body, { attributes: true, childList: true, subtree: true });
  const interval = setInterval(check, 4);

  B.watcher = {
    stop() {
      stopped = true;
      observer.disconnect();
      clearInterval(interval);
    },
  };
  return { ok: true, rect: B.rectOf(btn), sig: lastSig, enabled: B.isEnabled(btn) };
}

function pageDisarmWatcher() {
  if (window.__booker && window.__booker.watcher) window.__booker.watcher.stop();
}

// ---------- 유틸 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const immediate = () => new Promise((r) => setImmediate(r));

function fmtKst(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
}

function sameUrl(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname.replace(/\/$/, '') === ub.pathname.replace(/\/$/, '');
  } catch (_) {
    return a === b;
  }
}

// ---------- 엔진 ----------

class Booker {
  constructor() {
    this.context = null;
    this.page = null;
    this.state = 'idle';
    this.time = null; // NTP 측정 결과
    this.logs = [];
    this.run = null; // 진행 중인 실행 정보
    this.result = null;
  }

  // 표준시 기준 현재 시각(ms)
  now() {
    return Date.now() + (this.time ? this.time.offsetMs : 0);
  }

  log(msg, level = 'info') {
    const entry = { t: this.now(), time: fmtKst(this.now()), level, msg };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.shift();
    console.log(`[${entry.time}] ${level.toUpperCase()} ${msg}`);
  }

  status() {
    return {
      state: this.state,
      browserOpen: !!this.context,
      pageUrl: this.page && !this.page.isClosed() ? this.page.url() : null,
      time: this.time,
      run: this.run && {
        url: this.run.url,
        gameKey: this.run.gameKey,
        openAt: this.run.openAt,
        openAtKst: fmtKst(this.run.openAt),
        clicks: this.run.clicks,
        phase: this.run.phase,
      },
      result: this.result,
      logs: this.logs.slice(-200),
    };
  }

  async syncTime() {
    this.time = await measureOffset();
    const dir = this.time.offsetMs >= 0 ? '늦음' : '빠름';
    this.log(
      `KRISS 시간 동기화: PC 시계가 표준시보다 ${Math.abs(this.time.offsetMs)}ms ${dir} ` +
        `(서버 ${this.time.host}, 왕복 ${this.time.rttMs}ms)`,
      Math.abs(this.time.offsetMs) > 50 ? 'warn' : 'info'
    );
    return this.time;
  }

  async openBrowser(url) {
    if (!this.context) {
      this.log('전용 크롬을 실행합니다');
      this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
        channel: 'chrome',
        headless: false,
        viewport: null,
        args: ['--start-maximized'],
      });
      await this.context.exposeBinding('__bookerSignal', (_source, payload) => this.onSignal(payload));
      this.context.on('close', () => {
        this.log('브라우저가 닫혔습니다', 'warn');
        this.context = null;
        this.page = null;
        if (this.run) this.finish(false, '브라우저가 닫혀 중단되었습니다');
        this.state = 'idle';
      });
      this.page = this.context.pages()[0] || (await this.context.newPage());
    }
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
    }
    if (url) {
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      this.log(`페이지 열기: ${url}`);
    }
    await this.page.bringToFront();
    if (this.state === 'idle') this.state = 'ready';
  }

  async ensurePage(url) {
    if (!this.context || !this.page || this.page.isClosed()) await this.openBrowser(url);
    else if (url && !sameUrl(this.page.url(), url)) {
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      this.log(`페이지 이동: ${url}`);
    }
  }

  // 버튼이 렌더링될 때까지 기다렸다가 경기 목록을 가져온다.
  async listGames(url, timeoutMs = 20000) {
    await this.ensurePage(url);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const games = await this.page.evaluate(pageInstallHelpers, BUTTON_TEXT).catch(() => []);
      if (games.length > 0) return games;
      await sleep(300);
    }
    return [];
  }

  // 경기 버튼이 나타나고, 페이지 스크립트 로딩이 끝나 버튼 상태가 stableMs 동안
  // 바뀌지 않을 때까지 기다린다. (실제 사이트는 로딩 직후 disabled 였다가 약 1초 뒤 바뀜)
  async waitForGame(gameKey, timeoutMs = 30000, stableMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    let lastSig = null;
    let since = 0;
    while (Date.now() < deadline) {
      const sig = await this.page
        .evaluate(
          ([text, key]) => {
            if (!window.__booker) return null;
            return window.__booker.sigByKey(key);
          },
          [BUTTON_TEXT, gameKey]
        )
        .catch(() => null);
      if (sig === null) {
        await this.page.evaluate(pageInstallHelpers, BUTTON_TEXT).catch(() => []);
        lastSig = null;
      } else if (sig !== lastSig) {
        lastSig = sig;
        since = Date.now();
      } else if (Date.now() - since >= stableMs) {
        return true;
      }
      await sleep(100);
    }
    return false;
  }

  // 표준시 기준 target 시각까지 정밀하게 대기한다 (중단 시 false).
  async waitUntil(target, run) {
    for (;;) {
      if (run.aborted) return false;
      const remaining = target - this.now();
      if (remaining <= 0) return true;
      if (remaining > 30) await sleep(Math.min(remaining - 20, 500));
      else await immediate();
    }
  }

  async start(opts) {
    if (this.run) throw new Error('이미 실행 중입니다');
    const {
      url,
      gameKey,
      openAtKst, // 'YYYY-MM-DDTHH:mm:ss' (한국 시간)
      preClickMs = 1000,
      intervalMs = 100,
      maxAfterMs = 10000,
      refreshBeforeSec = 60,
    } = opts;

    if (!url || !gameKey || !openAtKst) throw new Error('URL, 경기, 오픈 시각을 모두 입력하세요');
    const openAt = new Date(`${openAtKst}+09:00`).getTime();
    if (Number.isNaN(openAt)) throw new Error('오픈 시각 형식이 올바르지 않습니다');

    await this.syncTime();
    if (openAt + maxAfterMs < this.now()) throw new Error('오픈 시각이 이미 지났습니다');

    const run = {
      url, gameKey, openAt, preClickMs, intervalMs, maxAfterMs, refreshBeforeSec,
      clicks: 0, phase: 'waiting', aborted: false, armed: false, rect: null,
      enabled: false, processing: false, lastLiveClickAt: 0,
      clickChain: Promise.resolve(), listeners: [],
    };
    this.run = run;
    this.result = null;
    this.state = 'running';
    this.log(`실행 시작 — 오픈 ${fmtKst(openAt)} / 경기: ${gameKey}`);

    this.loop(run).catch((err) => {
      this.log(`오류: ${err.message}`, 'error');
      this.finish(false, err.message);
    });
  }

  async loop(run) {
    await this.ensurePage(run.url);
    if (!(await this.waitForGame(run.gameKey))) throw new Error('페이지에서 선택한 경기를 찾지 못했습니다');

    // 1) 오픈 N초 전 새로고침 (한 번만)
    const refreshAt = run.openAt - run.refreshBeforeSec * 1000;
    if (run.refreshBeforeSec > 0 && refreshAt > this.now() + 2000) {
      run.phase = 'waiting-refresh';
      if (!(await this.waitUntil(refreshAt, run))) return;
      run.phase = 'refreshing';
      this.log(`오픈 ${run.refreshBeforeSec}초 전 새로고침`);
      await this.page.reload({ waitUntil: 'domcontentloaded' });
      if (!(await this.waitForGame(run.gameKey))) throw new Error('새로고침 후 경기를 찾지 못했습니다');
      this.log('새로고침 완료, 버튼 확인됨');
      await this.syncTime().catch((e) => this.log(`재동기화 실패(기존 값 사용): ${e.message}`, 'warn'));
    } else if (run.refreshBeforeSec > 0) {
      this.log('오픈까지 시간이 짧아 사전 새로고침은 건너뜁니다', 'warn');
    }

    // 2) 감시 장치 설치 및 이동 감지
    run.phase = 'armed';
    this.attachListeners(run);
    await this.arm(run);

    // 3) 오픈 preClickMs 전부터 일정 간격으로 클릭
    const clickStart = run.openAt - run.preClickMs;
    if (!(await this.waitUntil(clickStart, run))) return;
    run.phase = 'clicking';
    this.log(`클릭 시작 (${run.intervalMs}ms 간격)`);

    const end = run.openAt + run.maxAfterMs;
    for (let k = 0; ; k++) {
      const tick = clickStart + k * run.intervalMs;
      if (tick > end) break;
      if (!(await this.waitUntil(tick, run))) return;
      this.click(run, 'interval');
    }
    if (!run.aborted) this.finish(false, `최대 시도 시간(${run.maxAfterMs / 1000}초) 동안 페이지 이동이 없었습니다`);
  }

  async arm(run) {
    const res = await this.page.evaluate(pageArmWatcher, run.gameKey);
    if (!res.ok) throw new Error(res.reason);
    run.rect = res.rect;
    run.enabled = res.enabled;
    run.armed = true;
    this.log(
      `버튼 감시 시작 — 현재 ${res.enabled ? '활성' : '비활성(disabled)'} 상태 ` +
        `(좌표 ${Math.round(res.rect.x)}, ${Math.round(res.rect.y)})`
    );
  }

  attachListeners(run) {
    const startUrl = this.page.url();
    const onNav = (frame) => {
      if (frame !== this.page.mainFrame() || !this.run) return;
      const u = frame.url();
      if (sameUrl(u, startUrl)) return;
      if (/accounts\.yanolja\.com|\/login/.test(u)) {
        this.finish(false, `로그인 페이지로 이동했습니다 — 전용 브라우저에서 먼저 로그인하세요 (${u.split('?')[0]})`);
      } else {
        this.finish(true, `페이지 이동 감지: ${u}`);
      }
    };
    const onPopup = (p) => {
      if (!this.run) return;
      p.bringToFront().catch(() => {});
      this.finish(true, `새 창 열림: ${p.url() || '(로딩 중)'}`);
    };
    const seenDialogs = new Set();
    const onDialog = (d) => {
      // 같은 문구는 처음 한 번만 기록한다
      if (!seenDialogs.has(d.message())) {
        seenDialogs.add(d.message());
        this.log(`알림창: "${d.message()}" → 자동으로 닫음 (이후 같은 알림은 생략)`, 'warn');
      }
      d.accept().catch(() => {});
    };
    // 이미 열려 있던 다른 창(예: 이전 예매창)이 재사용되는 경우도 감지한다
    const others = this.context.pages().filter((p) => p !== this.page);
    const otherListeners = others.map((p) => {
      const fn = (frame) => {
        if (frame !== p.mainFrame() || !this.run) return;
        p.bringToFront().catch(() => {});
        this.finish(true, `기존 창에서 페이지 이동: ${frame.url()}`);
      };
      p.on('framenavigated', fn);
      return () => p.off('framenavigated', fn);
    });
    this.page.on('framenavigated', onNav);
    this.context.on('page', onPopup);
    this.page.on('dialog', onDialog);
    run.listeners = [
      () => this.page && this.page.off('framenavigated', onNav),
      () => this.context && this.context.off('page', onPopup),
      () => this.page && this.page.off('dialog', onDialog),
      ...otherListeners,
    ];
  }

  onSignal(payload) {
    const run = this.run;
    if (!run || run.aborted || !run.armed || payload.type !== 'changed') return;
    run.rect = payload.rect;
    const wasEnabled = run.enabled;
    run.enabled = payload.enabled;

    if (!payload.enabled) {
      // 활성 상태에서 클릭한 직후 비활성화되면 사이트가 클릭을 처리 중인 것
      if (wasEnabled && this.now() - run.lastLiveClickAt < 300) {
        if (!run.processing) this.log('사이트가 클릭을 처리 중 (버튼 잠시 비활성)');
        run.processing = true;
      }
      return;
    }
    if (run.processing) {
      // 처리 중 → 다시 활성화된 것은 오픈이 아니므로 즉시 클릭하지 않는다 (반복 클릭은 계속)
      run.processing = false;
      return;
    }
    this.log('버튼 활성화 감지 → 즉시 클릭', 'success');
    this.click(run, 'signal');
  }

  // 실제 마우스 클릭(신뢰된 입력)을 보낸다. 클릭은 하나씩 순서대로 처리한다.
  click(run, reason) {
    if (!run.rect || run.aborted) return;
    if (reason === 'interval' && run.clickBusy) return; // 직전 클릭이 아직 처리 중이면 건너뜀
    const { x, y } = run.rect;
    run.clickChain = run.clickChain.then(async () => {
      if (run.aborted) return;
      run.clickBusy = true;
      const t = this.now();
      if (run.enabled) run.lastLiveClickAt = t;
      try {
        await this.page.mouse.click(x, y);
        run.clicks++;
        if (reason === 'signal' || run.clicks === 1) {
          const diff = t - run.openAt;
          this.log(`클릭 #${run.clicks} (${reason === 'signal' ? '활성화 감지' : '반복'}) — 오픈 대비 ${diff >= 0 ? '+' : ''}${diff}ms`);
        }
      } catch (_) {
        /* 페이지 이동 중이면 실패할 수 있음 */
      } finally {
        run.clickBusy = false;
      }
    });
  }

  finish(success, message) {
    const run = this.run;
    if (!run) return;
    run.aborted = true;
    run.listeners.forEach((off) => { try { off(); } catch (_) {} });
    if (this.page && !this.page.isClosed()) this.page.evaluate(pageDisarmWatcher).catch(() => {});
    const at = this.now();
    this.result = { success, message, at, atKst: fmtKst(at), afterOpenMs: at - run.openAt, clicks: run.clicks };
    this.log(`${success ? '완료' : '종료'}: ${message} (오픈 대비 ${at - run.openAt >= 0 ? '+' : ''}${at - run.openAt}ms, 클릭 ${run.clicks}회)`, success ? 'success' : 'warn');
    this.run = null;
    this.state = this.context ? 'ready' : 'idle';
  }

  stop() {
    if (this.run) this.finish(false, '사용자가 중지했습니다');
  }
}

module.exports = { Booker, fmtKst };
