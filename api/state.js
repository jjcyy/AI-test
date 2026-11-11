// 점심 메뉴 투표 API — 모든 사람의 투표를 Supabase(PostgreSQL)에 모아 둔다.
// Vercel에서 Supabase를 연결하면 POSTGRES_URL 이 자동으로 들어온다.
// 표는 처음 실행할 때 자동으로 만든다. 저장소가 없으면 임시 메모리에 저장한다(서버가 다시 시작되면 사라짐).

const postgres = require('postgres');

const DEFAULT_MENUS = ['김치찌개', '돈까스', '쌀국수'];
const MAX_NAME = 30;
const MAX_MENUS = 30;

const DB_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
const isLocal = DB_URL && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const sql = DB_URL
  ? (globalThis.__lunchSql ||= postgres(DB_URL, {
      ssl: isLocal ? false : 'require',
      prepare: false, // Supabase 연결 풀(트랜잭션 모드)과 함께 쓰기 위해 끈다
      max: 1,
      idle_timeout: 20,
      onnotice: () => {}, // "이미 표가 있음" 같은 안내 메시지는 로그에 남기지 않는다
    }))
  : null;

// ---------------- Supabase(PostgreSQL) 저장소 ----------------
let ready = null;
function setupDb() {
  return (ready ||= (async () => {
    await sql`create table if not exists lunch_menus (
      name text primary key,
      votes integer not null default 0 check (votes >= 0),
      created_at timestamptz not null default now()
    )`;
    await sql`create table if not exists lunch_meta (
      id integer primary key,
      round integer not null default 0
    )`;
    // 메타 행을 처음 만들 때만 기본 메뉴를 넣는다.
    const first = await sql`insert into lunch_meta (id, round) values (1, 0) on conflict (id) do nothing returning id`;
    if (first.length) await seedDb(sql);
  })().catch((e) => { ready = null; throw e; }));
}

async function seedDb(tx) {
  await tx`delete from lunch_menus`;
  for (let i = 0; i < DEFAULT_MENUS.length; i++) {
    // 기본 메뉴 순서를 유지하려고 시각을 1ms씩 늦춘다.
    await tx`insert into lunch_menus (name, votes, created_at)
             values (${DEFAULT_MENUS[i]}, 0, now() + ${i + ' milliseconds'}::interval)`;
  }
}

const db = {
  async list() {
    const menus = await sql`select name, votes from lunch_menus order by created_at, name`;
    const [meta] = await sql`select round from lunch_meta where id = 1`;
    return { menus: menus.map((m) => ({ name: m.name, votes: m.votes })), round: meta ? meta.round : 0 };
  },
  async count() {
    const [r] = await sql`select count(*)::int as n from lunch_menus`;
    return r.n;
  },
  async add(name) {
    const dup = await sql`select 1 from lunch_menus where lower(name) = lower(${name})`;
    if (dup.length) return false;
    const r = await sql`insert into lunch_menus (name) values (${name}) on conflict (name) do nothing returning name`;
    return r.length > 0;
  },
  async vote(name, prev, round) {
    return sql.begin(async (tx) => {
      const [meta] = await tx`select round from lunch_meta where id = 1 for update`;
      const exists = await tx`select 1 from lunch_menus where name = ${name}`;
      if (!exists.length) return 'missing';
      const sameRound = meta && Number(round) === meta.round;
      if (sameRound && prev === name) return 'ok';
      if (sameRound && prev) {
        await tx`update lunch_menus set votes = greatest(votes - 1, 0) where name = ${prev}`;
      }
      await tx`update lunch_menus set votes = votes + 1 where name = ${name}`;
      return 'ok';
    });
  },
  async remove(name) {
    await sql`delete from lunch_menus where name = ${name}`;
  },
  async resetVotes() {
    await sql.begin(async (tx) => {
      await tx`update lunch_menus set votes = 0`;
      await tx`update lunch_meta set round = round + 1 where id = 1`;
    });
  },
  async resetAll() {
    await sql.begin(async (tx) => {
      await seedDb(tx);
      await tx`update lunch_meta set round = round + 1 where id = 1`;
    });
  },
};

// ---------------- 임시 메모리 저장소 (DB 연결 전) ----------------
const mem = (globalThis.__lunchMem ||= {
  round: 0,
  menus: DEFAULT_MENUS.map((name) => ({ name, votes: 0 })),
});
const memory = {
  async list() { return { menus: mem.menus.map((m) => ({ ...m })), round: mem.round }; },
  async count() { return mem.menus.length; },
  async add(name) {
    if (mem.menus.some((m) => m.name.toLowerCase() === name.toLowerCase())) return false;
    mem.menus.push({ name, votes: 0 });
    return true;
  },
  async vote(name, prev, round) {
    const target = mem.menus.find((m) => m.name === name);
    if (!target) return 'missing';
    const sameRound = Number(round) === mem.round;
    if (sameRound && prev === name) return 'ok';
    const old = sameRound && prev && mem.menus.find((m) => m.name === prev);
    if (old) old.votes = Math.max(0, old.votes - 1);
    target.votes += 1;
    return 'ok';
  },
  async remove(name) { mem.menus = mem.menus.filter((m) => m.name !== name); },
  async resetVotes() { mem.menus.forEach((m) => (m.votes = 0)); mem.round += 1; },
  async resetAll() { mem.menus = DEFAULT_MENUS.map((name) => ({ name, votes: 0 })); mem.round += 1; },
};

const store = sql ? db : memory;
const storageName = sql ? 'supabase' : 'memory';

// ---------------- 요청 처리 ----------------
function cleanName(v) {
  return String(v || '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
}

async function snapshot() {
  return { ...(await store.list()), storage: storageName };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (sql) await setupDb();

    if (req.method === 'GET') return res.status(200).json(await snapshot());
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET 또는 POST만 쓸 수 있어요.' });

    let body = req.body || {};
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    const name = cleanName(body.name);

    switch (body.action) {
      case 'add': {
        if (!name) return res.status(400).json({ error: '메뉴 이름을 입력해 주세요.' });
        if ((await store.count()) >= MAX_MENUS) return res.status(400).json({ error: '메뉴는 ' + MAX_MENUS + '개까지 추가할 수 있어요.' });
        if (!(await store.add(name))) return res.status(409).json({ error: '"' + name + '"은(는) 이미 있는 메뉴예요.' });
        break;
      }
      case 'vote': {
        const r = await store.vote(name, cleanName(body.prev), body.round);
        if (r === 'missing') return res.status(404).json({ error: '없는 메뉴예요. 새로고침해 주세요.' });
        break;
      }
      case 'delete':
        await store.remove(name);
        break;
      case 'resetVotes':
        await store.resetVotes();
        break;
      case 'resetAll':
        await store.resetAll();
        break;
      default:
        return res.status(400).json({ error: '알 수 없는 요청이에요.' });
    }
    return res.status(200).json(await snapshot());
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: '저장소에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.' });
  }
};
