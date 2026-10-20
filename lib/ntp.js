// KRISS(한국표준과학연구원) NTP 서버로 PC 시계 오차를 측정한다.
// offsetMs = 표준시 - PC시계  (양수면 PC 시계가 늦음)
const dgram = require('dgram');

const SERVERS = ['time.kriss.re.kr', 'time2.kriss.re.kr'];
const NTP_EPOCH_DIFF = 2208988800; // 1900-01-01 ~ 1970-01-01 (초)

function readTimestamp(buf, offset) {
  const sec = buf.readUInt32BE(offset) - NTP_EPOCH_DIFF;
  const frac = buf.readUInt32BE(offset + 4) / 2 ** 32;
  return (sec + frac) * 1000;
}

function querySingle(host, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const packet = Buffer.alloc(48);
    packet[0] = 0x1b; // LI=0, VN=3, Mode=3(client)
    let t0;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${host} 응답 없음`));
    }, timeoutMs);

    socket.on('message', (msg) => {
      const t3 = Date.now();
      clearTimeout(timer);
      socket.close();
      const t1 = readTimestamp(msg, 32); // 서버 수신 시각
      const t2 = readTimestamp(msg, 40); // 서버 송신 시각
      const offset = ((t1 - t0) + (t2 - t3)) / 2;
      const rtt = (t3 - t0) - (t2 - t1);
      resolve({ host, offset, rtt });
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });

    t0 = Date.now();
    socket.send(packet, 123, host);
  });
}

// 서버별로 여러 번 측정해서 왕복시간(RTT)이 가장 짧은 샘플을 채택한다.
// 네트워크가 순간적으로 느려 RTT가 크면(오차가 커지므로) 최대 3회까지 다시 측정한다.
async function measureOffset(samplesPerServer = 4, goodRttMs = 30) {
  const results = [];
  for (let round = 0; round < 3; round++) {
    for (const host of SERVERS) {
      for (let i = 0; i < samplesPerServer; i++) {
        try {
          results.push(await querySingle(host));
        } catch (_) { /* 다음 샘플 시도 */ }
      }
    }
    if (results.some((r) => r.rtt <= goodRttMs)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (results.length === 0) {
    throw new Error('KRISS 시간 서버에 연결할 수 없습니다 (UDP 123 포트 확인)');
  }
  results.sort((a, b) => a.rtt - b.rtt);
  const best = results[0];
  return {
    offsetMs: Math.round(best.offset),
    rttMs: Math.round(best.rtt),
    host: best.host,
    samples: results.length,
    measuredAt: Date.now(),
  };
}

module.exports = { measureOffset };
