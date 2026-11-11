// 점심 메뉴 투표 API — 모든 사람의 투표를 한곳(Upstash Redis)에 모아 둔다.
// Vercel에서 Upstash Redis를 연결하면 KV_REST_API_URL / KV_REST_API_TOKEN 이 자동으로 들어온다.
// 저장소가 연결되지 않았으면 임시 메모리에 저장한다(서버가 다시 시작되면 사라짐).

const KEY = 'skb-lunch-vote:menus'; // Redis 해시: 메뉴 이름 -> 표 수
const DEFAULT_MENUS = ['김치찌개', '돈까스', '쌀국수'];
const MAX_NAME = 30;
const MAX_MENUS = 30;

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const useRedis = Boolean(URL_ && TOKEN);

// ---- 저장소 (Redis 또는 메모리) ----
const mem = globalThis.__lunchMem || (globalThis.__lunchMem = { data: null });

async function redis(cmd) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

async function getAll() {
  if (useRedis) {
    const flat = await redis(['HGETALL', KEY]);
    const out = {};
    for (let i = 0; i < flat.length; i += 2) out[flat[i]] = Number(flat[i + 1]) || 0;
    return out;
  }
  return { ...mem.data };
}

async function ensureSeed() {
  if (useRedis) {
    const exists = await redis(['EXISTS', KEY]);
    if (!exists) await seed();
  } else if (!mem.data) {
    await seed();
  }
}

async function seed() {
  if (useRedis) {
    await redis(['DEL', KEY]);
    await redis(['HSET', KEY, ...DEFAULT_MENUS.flatMap((n) => [n, '0'])]);
  } else {
    mem.data = Object.fromEntries(DEFAULT_MENUS.map((n) => [n, 0]));
  }
}

async function addMenu(name) {
  if (useRedis) return (await redis(['HSETNX', KEY, name, '0'])) === 1;
  if (name in mem.data) return false;
  mem.data[name] = 0;
  return true;
}

async function incr(name, by) {
  if (useRedis) {
    const v = await redis(['HINCRBY', KEY, name, String(by)]);
    if (v < 0) await redis(['HSET', KEY, name, '0']);
    return;
  }
  mem.data[name] = Math.max(0, (mem.data[name] || 0) + by);
}

async function del(name) {
  if (useRedis) return redis(['HDEL', KEY, name]);
  delete mem.data[name];
}

async function resetVotes() {
  const all = await getAll();
  const names = Object.keys(all);
  if (!names.length) return;
  if (useRedis) await redis(['HSET', KEY, ...names.flatMap((n) => [n, '0'])]);
  else names.forEach((n) => (mem.data[n] = 0));
}

// ---- 요청 처리 ----
function cleanName(v) {
  return String(v || '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
}

// 초기화할 때마다 회차를 올린다. 브라우저는 회차가 바뀌면 "내 투표" 기록을 버린다.
const ROUND_KEY = 'skb-lunch-vote:round';
async function getRound() {
  if (useRedis) return Number(await redis(['GET', ROUND_KEY])) || 0;
  return mem.round || 0;
}
async function nextRound() {
  if (useRedis) return redis(['INCR', ROUND_KEY]);
  mem.round = (mem.round || 0) + 1;
}

async function snapshot() {
  const all = await getAll();
  const menus = Object.entries(all).map(([name, votes]) => ({ name, votes }));
  return { menus, round: await getRound(), storage: useRedis ? 'redis' : 'memory' };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureSeed();

    if (req.method === 'GET') return res.status(200).json(await snapshot());
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET 또는 POST만 쓸 수 있어요.' });

    let body = req.body || {};
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    const all = await getAll();
    const name = cleanName(body.name);

    switch (body.action) {
      case 'add': {
        if (!name) return res.status(400).json({ error: '메뉴 이름을 입력해 주세요.' });
        if (Object.keys(all).length >= MAX_MENUS) return res.status(400).json({ error: '메뉴는 ' + MAX_MENUS + '개까지 추가할 수 있어요.' });
        const dup = Object.keys(all).some((n) => n.toLowerCase() === name.toLowerCase());
        if (dup || !(await addMenu(name))) return res.status(409).json({ error: '"' + name + '"은(는) 이미 있는 메뉴예요.' });
        break;
      }
      case 'vote': {
        if (!(name in all)) return res.status(404).json({ error: '없는 메뉴예요. 새로고침해 주세요.' });
        const sameRound = Number(body.round) === (await getRound());
        const prev = sameRound ? cleanName(body.prev) : '';
        if (prev === name) break; // 이미 같은 메뉴에 투표함
        if (prev && prev in all) await incr(prev, -1); // 투표를 옮기면 이전 표를 뺀다
        await incr(name, 1);
        break;
      }
      case 'delete':
        await del(name);
        break;
      case 'resetVotes':
        await resetVotes();
        await nextRound();
        break;
      case 'resetAll':
        await seed();
        await nextRound();
        break;
      default:
        return res.status(400).json({ error: '알 수 없는 요청이에요.' });
    }
    return res.status(200).json(await snapshot());
  } catch (e) {
    return res.status(500).json({ error: '저장소에 연결하지 못했어요.', detail: String(e.message || e) });
  }
};
