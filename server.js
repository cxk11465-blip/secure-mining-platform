import http from 'node:http';
import fs from 'node:fs';
import { readFile, writeFile, mkdir, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadLocalEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnv();

const publicDir = path.join(__dirname, 'public');
const dataDir = path.join(__dirname, 'data');
const uploadDir = path.join(dataDir, 'uploads');
const dbPath = path.join(dataDir, 'db.json');
const adminBootstrapPath = path.join(dataDir, 'bootstrap-admin.txt');
const port = Number(process.env.PORT || 3000);
let databaseUrl = process.env.DATABASE_URL || '';
let usePostgres = false;
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseStorageBucket = process.env.SUPABASE_STORAGE_BUCKET || 'receipts';
const useSupabaseStorage = Boolean(supabaseUrl && supabaseServiceRoleKey);
let pgPool = null;
let postgresStatus = 'disabled';
let pgSchemaReady = false;
const withdrawalFeeRate = 0.10;
const referralRewardRate = 0.05;
const platformFeeRate = Math.max(0, Math.round((withdrawalFeeRate - referralRewardRate) * 10000) / 10000);
const minWithdrawalAmount = Number(process.env.MIN_WITHDRAWAL_AMOUNT || 10);
const dailyWithdrawalLimit = Number(process.env.DAILY_WITHDRAWAL_LIMIT || 1);
const adminLoginCode = process.env.ADMIN_LOGIN_CODE || '';
const rechargeConfig = {
  usdtNetwork: 'TRC20',
  coldWalletAddress: process.env.USDT_COLD_WALLET_ADDRESS || 'TXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  creditCardProcessor: 'manual_review'
};
const games = [
  {
    id: 'daily_check',
    name: '每日巡检',
    rewardMode: 'flat',
    reward: 1,
    cooldownMs: 24 * 60 * 60 * 1000,
    requireActiveMiner: false,
    description: '每日基础活跃奖励，额度很小，不能作为主要收益。'
  },
  {
    id: 'maintenance',
    name: '矿机维护',
    rewardMode: 'active_miner_rate',
    rewardRate: 0.002,
    maxReward: 8,
    cooldownMs: 24 * 60 * 60 * 1000,
    requireActiveMiner: true,
    description: '需要持有运行中的矿工，奖励为运行中矿工成本的 0.2%，最高 8 能量。'
  },
  {
    id: 'hash_boost',
    name: '算力校准',
    rewardMode: 'active_miner_rate',
    rewardRate: 0.003,
    maxReward: 12,
    cooldownMs: 24 * 60 * 60 * 1000,
    requireActiveMiner: true,
    description: '需要持有运行中的矿工，奖励为运行中矿工成本的 0.3%，最高 12 能量。'
  }
];
const gameCooldownMs = 24 * 60 * 60 * 1000;
const minerPlans = [
  { id: 'm100', name: '轻量矿工', cost: 100, durationDays: 6, totalReturnRate: 1.12 },
  { id: 'm500', name: '标准矿工', cost: 500, durationDays: 5, totalReturnRate: 1.12 },
  { id: 'm1000', name: '进阶矿工', cost: 1000, durationDays: 4, totalReturnRate: 1.12 },
  { id: 'm5000', name: '旗舰矿工', cost: 5000, durationDays: 3, totalReturnRate: 1.12 }
].map((plan) => ({
  ...plan,
  totalOutput: Math.round(plan.cost * plan.totalReturnRate * 100) / 100,
  hourlyOutput: Math.round((plan.cost * plan.totalReturnRate / (plan.durationDays * 24)) * 10000) / 10000
}));

const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

let writeQueue = Promise.resolve();

function sanitizeDbUrlForLog(raw) {
  try {
    const u = new URL(raw);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<invalid DATABASE_URL>';
  }
}

function validateDatabaseUrl(raw) {
  if (!raw) return { ok: false, reason: 'empty' };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  const host = (u.hostname || '').toLowerCase();
  if (host.startsWith('db.') && host.endsWith('.supabase.co')) {
    return {
      ok: false,
      reason: 'supabase_direct_db_host',
      hint:
        'Supabase 不能用 db.<project>.supabase.co 直连；请在 Supabase Dashboard 里复制 Database -> Connection string -> Transaction pooler 的连接串（通常是 *.pooler.supabase.com:6543 或 6543/5432 之一）。'
    };
  }
  return { ok: true };
}

{
  const check = validateDatabaseUrl(databaseUrl);
  if (check.ok) {
    usePostgres = true;
    postgresStatus = 'configured';
  } else if (databaseUrl) {
    console.warn('[db] DATABASE_URL 无法用于 Postgres，已回退本地 JSON 存储。');
    console.warn('[db] DATABASE_URL = ' + sanitizeDbUrlForLog(databaseUrl));
    if (check.hint) console.warn('[db] 提示: ' + check.hint);
    databaseUrl = '';
    usePostgres = false;
    postgresStatus = check.reason || 'invalid';
  }
}

async function fallbackToJsonStorage(error) {
  console.error('[db] Supabase Postgres 连接失败，已回退本地 JSON 存储。');
  console.error('[db] 原因: ' + (error?.message || 'unknown error'));
  if (pgPool) await pgPool.end().catch(() => {});
  usePostgres = false;
  pgPool = null;
  pgSchemaReady = false;
  postgresStatus = 'failed: ' + (error?.message || 'unknown error');
}

function isPostgresFailure(error) {
  if (error?.status && error.status < 500) return false;
  return Boolean(error?.code || /postgres|database|connection|authentication|timeout|ECONN|ENOTFOUND/i.test(error?.message || ''));
}

async function getPgPool() {
  if (!usePostgres) return null;
  if (!pgPool) {
    const { Pool } = await import('pg');
    pgPool = new Pool({
      connectionString: databaseUrl,
      ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX || 1)
    });
  }
  return pgPool;
}

async function ensurePgSchema() {
  if (pgSchemaReady) return;
  const pool = await getPgPool();
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  pgSchemaReady = true;
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

function cleanReferralCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function generateReferralCode(username, users = []) {
  const base = cleanReferralCode(username).slice(0, 8) || 'USER';
  for (let i = 0; i < 20; i += 1) {
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const code = `${base}${suffix}`.slice(0, 14);
    if (!users.some((item) => item.referralCode === code)) return code;
  }
  return crypto.randomBytes(7).toString('hex').toUpperCase();
}

function ensureReferralState(db) {
  db.referralRewards ||= [];
  for (const user of db.users || []) {
    if (!user.referralCode) user.referralCode = generateReferralCode(user.username, db.users);
    user.referralRewardBalance = Number(user.referralRewardBalance || 0);
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex');
  return `pbkdf2_sha256$210000$${salt}$${hash}`;
}

function verifyPassword(password, encoded) {
  const [algo, iter, salt, expected] = String(encoded || '').split('$');
  if (algo !== 'pbkdf2_sha256' || !iter || !salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(password, salt, Number(iter), 32, 'sha256');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), actual);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    balance: user.balance,
    frozen: user.frozen,
    energy: user.energy,
    withdrawableEnergy: user.withdrawableEnergy || 0,
    referralCode: user.referralCode || '',
    referrerId: user.referrerId || '',
    referrerUsername: user.referrerUsername || '',
    referralRewardBalance: user.referralRewardBalance || 0,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null,
    riskReason: user.riskReason || '',
    riskNote: user.riskNote || '',
    statusUpdatedAt: user.statusUpdatedAt || null,
    statusUpdatedBy: user.statusUpdatedBy || null
  };
}

function ensureOperationalUser(user) {
  if (user.status === 'frozen') throw Object.assign(new Error('账号已冻结，暂不能进行资金和矿工操作'), { status: 403 });
  if (user.status !== 'active') throw Object.assign(new Error('账号不可用'), { status: 401 });
}

function userStats(db, user) {
  ensureReferralState(db);
  const deposits = db.deposits.filter((item) => item.userId === user.id);
  const withdrawals = db.withdrawals.filter((item) => item.userId === user.id);
  const miners = (db.userMiners || []).filter((item) => item.userId === user.id);
  const ledger = db.ledger.filter((item) => item.userId === user.id);
  const invitedUsers = db.users.filter((item) => item.referrerId === user.id);
  const referralRewards = (db.referralRewards || []).filter((item) => item.referrerId === user.id);
  return {
    ...publicUser(user),
    totalRecharge: deposits.filter((item) => item.status === 'approved').reduce((sum, item) => sum + Number(item.amount || 0), 0),
    totalWithdrawRequested: withdrawals.reduce((sum, item) => sum + Number(item.amount || 0), 0),
    totalWithdrawReceived: withdrawals.filter((item) => item.status === 'approved').reduce((sum, item) => sum + Number(item.receiveAmount || 0), 0),
    minerCount: miners.length,
    activeMinerCount: miners.filter((item) => minerSnapshot(item).status === 'running').length,
    totalMined: ledger.filter((item) => item.type === 'miner_claim').reduce((sum, item) => sum + Number(item.amount || 0), 0),
    totalGameReward: ledger.filter((item) => item.type === 'game_reward').reduce((sum, item) => sum + Number(item.amount || 0), 0),
    invitedCount: invitedUsers.length,
    totalReferralReward: referralRewards.reduce((sum, item) => sum + Number(item.amount || 0), 0)
  };
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function initialDb() {
  await mkdir(dataDir, { recursive: true });
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(14).toString('base64url');
  const admin = {
    id: id('usr'),
    username: 'admin',
    passwordHash: hashPassword(password),
    role: 'admin',
    status: 'active',
    balance: 0,
    frozen: 0,
    energy: 0,
    withdrawableEnergy: 0,
    referralCode: 'ADMIN',
    referralRewardBalance: 0,
    createdAt: now()
  };
  if (!process.env.ADMIN_PASSWORD) {
    await writeFile(adminBootstrapPath, `管理员账号：admin\n初始密码：${password}\n首次登录后请立刻修改并删除此文件。\n`, { flag: 'wx' }).catch(() => {});
    await chmod(adminBootstrapPath, 0o600).catch(() => {});
  }
  return {
    users: [admin],
    sessions: [],
    deposits: [],
    withdrawals: [],
    gamePlays: [],
    userMiners: [],
    referralRewards: [],
    ledger: [],
    audit: [{
      id: id('aud'),
      actorId: admin.id,
      actorName: 'system',
      action: 'bootstrap_admin_created',
      detail: '系统初始化管理员账号',
      createdAt: now()
    }]
  };
}

async function loadDb() {
  if (usePostgres) {
    await ensurePgSchema();
    const pool = await getPgPool();
    const result = await pool.query('SELECT data FROM app_state WHERE id = $1', ['main']);
    if (result.rows[0]?.data) return result.rows[0].data;
    const db = await initialDb();
    await saveDb(db);
    return db;
  }
  if (!(await exists(dbPath))) {
    const db = await initialDb();
    await saveDb(db);
    return db;
  }
  return JSON.parse(await readFile(dbPath, 'utf8'));
}

async function saveDb(db) {
  if (usePostgres) {
    await ensurePgSchema();
    const pool = await getPgPool();
    await pool.query(`
      INSERT INTO app_state (id, data, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (id)
      DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
    `, ['main', JSON.stringify(db)]);
    return;
  }
  await mkdir(dataDir, { recursive: true });
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

async function withDb(mutator) {
  const run = writeQueue.then(async () => {
    try {
      const db = await loadDb();
      ensureReferralState(db);
      const result = await mutator(db);
      await saveDb(db);
      return result;
    } catch (error) {
      if (!usePostgres || !isPostgresFailure(error)) throw error;
      await fallbackToJsonStorage(error);
      const db = await loadDb();
      ensureReferralState(db);
      const result = await mutator(db);
      await saveDb(db);
      return result;
    }
  });
  writeQueue = run.catch(() => {});
  return run;
}

async function readDb(fn) {
  try {
    const db = await loadDb();
    ensureReferralState(db);
    return fn(db);
  } catch (error) {
    if (!usePostgres || !isPostgresFailure(error)) throw error;
    await fallbackToJsonStorage(error);
    const db = await loadDb();
    ensureReferralState(db);
    return fn(db);
  }
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...securityHeaders,
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers
  });
  res.end(payload);
}

function sendJson(res, status, body, headers = {}) {
  send(res, status, body, headers);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey) out[rawKey] = decodeURIComponent(rawValue.join('='));
  }
  return out;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON 格式错误'), { status: 400 });
  }
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 3_500_000) throw Object.assign(new Error('上传内容过大'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!boundaryMatch) throw Object.assign(new Error('缺少上传边界'), { status: 400 });
  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const raw = buffer.toString('latin1');
  const parts = raw.split(boundary).slice(1, -1);
  const fields = {};
  const files = {};
  for (const part of parts) {
    const trimmed = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const splitAt = trimmed.indexOf('\r\n\r\n');
    if (splitAt === -1) continue;
    const rawHeaders = trimmed.slice(0, splitAt);
    const body = trimmed.slice(splitAt + 4);
    const disposition = /content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(rawHeaders);
    if (!disposition) continue;
    const name = disposition[1];
    const filename = disposition[2];
    const contentTypeMatch = /content-type:\s*([^\r\n]+)/i.exec(rawHeaders);
    const content = Buffer.from(body, 'latin1');
    if (filename) {
      files[name] = { filename, contentType: contentTypeMatch?.[1] || 'application/octet-stream', content };
    } else {
      fields[name] = content.toString('utf8');
    }
  }
  return { fields, files };
}

async function saveReceiptUpload(file) {
  if (!file || !file.content.length) throw Object.assign(new Error('请上传转账凭证截图'), { status: 400 });
  if (file.content.length > 3_000_000) throw Object.assign(new Error('截图不能超过 3MB'), { status: 413 });
  const allowed = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp'
  };
  const ext = allowed[file.contentType.toLowerCase()];
  if (!ext) throw Object.assign(new Error('截图仅支持 JPG、PNG、WebP'), { status: 400 });
  const filename = `${id('receipt')}${ext}`;
  if (useSupabaseStorage) {
    const objectPath = `receipts/${filename}`;
    const uploadObject = () => fetch(`${supabaseUrl}/storage/v1/object/${encodeURIComponent(supabaseStorageBucket)}/${objectPath}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
        apikey: supabaseServiceRoleKey,
        'Content-Type': file.contentType,
        'x-upsert': 'false'
      },
      body: file.content
    });
    let response = await uploadObject();
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 404 && text.includes('Bucket not found')) {
        await ensureSupabaseBucket();
        response = await uploadObject();
        if (response.ok) return `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(supabaseStorageBucket)}/${objectPath}`;
        const retryText = await response.text().catch(() => '');
        throw Object.assign(new Error(`上传凭证失败：${retryText || response.statusText}`), { status: 502 });
      }
      throw Object.assign(new Error(`上传凭证失败：${text || response.statusText}`), { status: 502 });
    }
    return `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(supabaseStorageBucket)}/${objectPath}`;
  }
  await mkdir(uploadDir, { recursive: true });
  await writeFile(path.join(uploadDir, filename), file.content);
  return `/uploads/${filename}`;
}

async function ensureSupabaseBucket() {
  const response = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      apikey: supabaseServiceRoleKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      id: supabaseStorageBucket,
      name: supabaseStorageBucket,
      public: true,
      file_size_limit: 3_000_000,
      allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp']
    })
  });
  if (response.ok || response.status === 409) return;
  const text = await response.text().catch(() => '');
  throw Object.assign(new Error(`创建凭证存储桶失败：${text || response.statusText}`), { status: 502 });
}

function assertText(value, name, min = 1, max = 80) {
  const text = String(value || '').trim();
  if (text.length < min || text.length > max) throw Object.assign(new Error(`${name}长度不合法`), { status: 400 });
  return text;
}

function assertAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
    throw Object.assign(new Error('金额不合法'), { status: 400 });
  }
  return Math.round(amount * 100) / 100;
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function luhnValid(cardNumber) {
  let sum = 0;
  let doubleDigit = false;
  for (let i = cardNumber.length - 1; i >= 0; i--) {
    let digit = Number(cardNumber[i]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function expiryValid(expiry) {
  const [month, year] = expiry.split('/').map(Number);
  const expiresAt = new Date(2000 + year, month, 0, 23, 59, 59);
  return expiresAt >= new Date();
}

function normalizeExpiry(value) {
  const raw = String(value || '').trim();
  const slashMatch = raw.match(/^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/);
  if (slashMatch) {
    const month = slashMatch[1].padStart(2, '0');
    const year = slashMatch[2].slice(-2);
    return `${month}/${year}`;
  }
  const digits = digitsOnly(raw);
  if (digits.length === 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  if (digits.length === 6) return `${digits.slice(0, 2)}/${digits.slice(4)}`;
  return raw;
}

async function auth(req, requireRole) {
  const sid = parseCookies(req).sid;
  if (!sid) throw Object.assign(new Error('未登录'), { status: 401 });
  return readDb((db) => {
    const session = db.sessions.find((item) => item.id === sid && new Date(item.expiresAt) > new Date());
    if (!session) throw Object.assign(new Error('登录已过期'), { status: 401 });
    const user = db.users.find((item) => item.id === session.userId);
    if (!user || user.status === 'banned' || user.status === 'disabled') throw Object.assign(new Error('账号不可用'), { status: 401 });
    if (requireRole && user.role !== requireRole) throw Object.assign(new Error('权限不足'), { status: 403 });
    return { session, user };
  });
}

async function requireCsrf(req, session) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  if (req.headers['x-csrf-token'] !== session.csrfToken) {
    throw Object.assign(new Error('CSRF 校验失败'), { status: 403 });
  }
}

function audit(db, user, action, detail) {
  db.audit.unshift({
    id: id('aud'),
    actorId: user?.id || 'system',
    actorName: user?.username || 'system',
    action,
    detail,
    createdAt: now()
  });
}

function addLedger(db, userId, type, amount, refId, detail) {
  db.ledger.unshift({ id: id('led'), userId, type, amount, refId, detail, createdAt: now() });
}

function minerSnapshot(miner) {
  const durationMs = new Date(miner.endAt).getTime() - new Date(miner.startAt).getTime();
  const elapsedMs = Math.max(0, Math.min(Date.now() - new Date(miner.startAt).getTime(), durationMs));
  const accrued = Math.round((miner.totalOutput * (elapsedMs / durationMs)) * 100) / 100;
  const claimable = Math.max(0, Math.round((accrued - miner.claimedEnergy) * 100) / 100);
  return {
    ...miner,
    accrued,
    claimable,
    progress: durationMs > 0 ? Math.round((elapsedMs / durationMs) * 10000) / 100 : 0,
    status: Date.now() >= new Date(miner.endAt).getTime() ? 'completed' : 'running'
  };
}

function activeMinerCost(db, userId) {
  return (db.userMiners || [])
    .filter((item) => item.userId === userId && minerSnapshot(item).status === 'running')
    .reduce((sum, item) => sum + Number(item.cost || 0), 0);
}

function activeMiner(db, userId) {
  return (db.userMiners || []).find((item) => item.userId === userId && minerSnapshot(item).status === 'running') || null;
}

function gameReward(game, db, userId) {
  if (game.rewardMode === 'flat') return game.reward;
  const activeCost = activeMinerCost(db, userId);
  if (game.requireActiveMiner && activeCost <= 0) {
    throw Object.assign(new Error('需要先购买并持有运行中的矿工'), { status: 400 });
  }
  const reward = Math.min(game.maxReward, activeCost * game.rewardRate);
  return Math.round(reward * 100) / 100;
}

async function api(req, res, pathname) {
  if (pathname === '/api/meta' && req.method === 'GET') {
    return sendJson(res, 200, {
      storageMode: usePostgres ? 'postgres' : 'json',
      postgresStatus,
      supabaseStorage: useSupabaseStorage ? 'enabled' : 'disabled'
    });
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const { session, user } = await auth(req);
    return sendJson(res, 200, { user: publicUser(user), csrfToken: session.csrfToken });
  }

  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const body = await readBody(req);
    const username = assertText(body.username, '用户名', 3, 32);
    const password = assertText(body.password, '密码', 8, 128);
    const referralCode = cleanReferralCode(body.referralCode || body.inviteCode || '');
    return withDb((db) => {
      if (db.users.some((item) => item.username.toLowerCase() === username.toLowerCase())) {
        throw Object.assign(new Error('用户名已存在'), { status: 409 });
      }
      const referrer = referralCode
        ? db.users.find((item) => cleanReferralCode(item.referralCode) === referralCode || cleanReferralCode(item.username) === referralCode)
        : null;
      if (referralCode && !referrer) throw Object.assign(new Error('邀请码不存在'), { status: 400 });
      const user = {
        id: id('usr'),
        username,
        passwordHash: hashPassword(password),
        role: 'user',
        status: 'active',
        balance: 0,
        frozen: 0,
        energy: 0,
        withdrawableEnergy: 0,
        referralCode: generateReferralCode(username, db.users),
        referrerId: referrer?.id || '',
        referrerUsername: referrer?.username || '',
        referralRewardBalance: 0,
        createdAt: now()
      };
      db.users.push(user);
      audit(db, user, 'user_registered', `用户 ${username} 注册${referrer ? `，邀请人 ${referrer.username}` : ''}`);
      return sendJson(res, 201, { user: publicUser(user) });
    });
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
    const username = assertText(body.username, '用户名', 1, 80);
    const password = assertText(body.password, '密码', 1, 128);
    return withDb((db) => {
      const user = db.users.find((item) => item.username.toLowerCase() === username.toLowerCase());
      if (!user || user.status === 'banned' || user.status === 'disabled' || !verifyPassword(password, user.passwordHash)) {
        throw Object.assign(new Error('账号或密码错误'), { status: 401 });
      }
      if (user.role === 'admin' && adminLoginCode && body.adminCode !== adminLoginCode) {
        throw Object.assign(new Error('管理员验证码错误'), { status: 401 });
      }
      db.sessions = db.sessions.filter((item) => new Date(item.expiresAt) > new Date());
      user.lastLoginAt = now();
      const session = {
        id: id('ses'),
        userId: user.id,
        csrfToken: crypto.randomBytes(24).toString('base64url'),
        createdAt: now(),
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 8).toISOString()
      };
      db.sessions.push(session);
      audit(db, user, 'login', `${user.username} 登录`);
      return sendJson(res, 200, { user: publicUser(user), csrfToken: session.csrfToken }, {
        'Set-Cookie': `sid=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`
      });
    });
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const { session, user } = await auth(req);
    await requireCsrf(req, session);
    return withDb((db) => {
      db.sessions = db.sessions.filter((item) => item.id !== session.id);
      audit(db, user, 'logout', `${user.username} 登出`);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    });
  }

  if (pathname === '/api/user/dashboard' && req.method === 'GET') {
    const { user } = await auth(req);
    return readDb((db) => sendJson(res, 200, {
      user: publicUser(user),
      games,
      gameCooldownMs,
      withdrawalFeeRate,
      referralRewardRate,
      platformFeeRate,
      minWithdrawalAmount,
      dailyWithdrawalLimit,
      rechargeConfig,
      gamePlays: (db.gamePlays || []).filter((item) => item.userId === user.id).slice(0, 20),
      minerPlans,
      userMiners: (db.userMiners || []).filter((item) => item.userId === user.id).map(minerSnapshot).slice(0, 50),
      deposits: db.deposits.filter((item) => item.userId === user.id).slice(0, 20),
      withdrawals: db.withdrawals.filter((item) => item.userId === user.id).slice(0, 20),
      ledger: db.ledger.filter((item) => item.userId === user.id).slice(0, 20),
      referralRewards: (db.referralRewards || []).filter((item) => item.referrerId === user.id).slice(0, 20),
      invitedUsers: db.users
        .filter((item) => item.referrerId === user.id)
        .map((item) => ({ id: item.id, username: item.username, createdAt: item.createdAt, status: item.status }))
        .slice(0, 20)
    }));
  }

  if (pathname === '/api/miners/purchase' && req.method === 'POST') {
    const { session, user } = await auth(req);
    ensureOperationalUser(user);
    await requireCsrf(req, session);
    const body = await readBody(req);
    const plan = minerPlans.find((item) => item.id === body.planId);
    if (!plan) throw Object.assign(new Error('矿工计划不存在'), { status: 404 });
    const quantity = Math.floor(Number(body.quantity || 1));
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 100) {
      throw Object.assign(new Error('购买数量必须在 1 到 100 之间'), { status: 400 });
    }
    return withDb((db) => {
      db.userMiners ||= [];
      const fresh = db.users.find((item) => item.id === user.id);
      const runningMiner = activeMiner(db, fresh.id);
      if (runningMiner) throw Object.assign(new Error('当前已有运行中的矿工，请等待本轮挖矿结束后再购买'), { status: 400 });
      const totalCost = Math.round(plan.cost * quantity * 100) / 100;
      if (fresh.energy < totalCost) throw Object.assign(new Error('能量不足，请先充值或领取产出'), { status: 400 });
      fresh.energy = Math.round((fresh.energy - totalCost) * 100) / 100;
      fresh.withdrawableEnergy = Math.max(0, Math.round(((fresh.withdrawableEnergy || 0) - totalCost) * 100) / 100);
      const startAt = now();
      const endAt = new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000).toISOString();
      const miner = {
        id: id('miner'),
        userId: fresh.id,
        username: fresh.username,
        planId: plan.id,
        planName: plan.name,
        quantity,
        unitCost: plan.cost,
        cost: totalCost,
        durationDays: plan.durationDays,
        totalOutput: Math.round(plan.totalOutput * quantity * 100) / 100,
        hourlyOutput: Math.round(plan.hourlyOutput * quantity * 10000) / 10000,
        claimedEnergy: 0,
        startAt,
        endAt,
        createdAt: startAt
      };
      db.userMiners.unshift(miner);
      addLedger(db, fresh.id, 'miner_purchase', -totalCost, miner.id, `购买${plan.name} x ${quantity}`);
      audit(db, fresh, 'miner_purchased', `${fresh.username} 购买 ${plan.name} x ${quantity}，消耗 ${totalCost} 能量`);
      return sendJson(res, 201, { miner: minerSnapshot(miner), user: publicUser(fresh) });
    });
  }

  const minerClaim = pathname.match(/^\/api\/miners\/([^/]+)\/claim$/);
  if (minerClaim && req.method === 'POST') {
    const { session, user } = await auth(req);
    ensureOperationalUser(user);
    await requireCsrf(req, session);
    const [, minerId] = minerClaim;
    return withDb((db) => {
      db.userMiners ||= [];
      const fresh = db.users.find((item) => item.id === user.id);
      const miner = db.userMiners.find((item) => item.id === minerId && item.userId === fresh.id);
      if (!miner) throw Object.assign(new Error('矿工不存在'), { status: 404 });
      const snapshot = minerSnapshot(miner);
      if (snapshot.claimable < 0.01) throw Object.assign(new Error('暂无可领取产出'), { status: 400 });
      miner.claimedEnergy = Math.round((miner.claimedEnergy + snapshot.claimable) * 100) / 100;
      fresh.energy = Math.round((fresh.energy + snapshot.claimable) * 100) / 100;
      fresh.withdrawableEnergy = Math.round(((fresh.withdrawableEnergy || 0) + snapshot.claimable) * 100) / 100;
      addLedger(db, fresh.id, 'miner_claim', snapshot.claimable, miner.id, `${miner.planName} 领取产出`);
      audit(db, fresh, 'miner_claimed', `${fresh.username} 领取 ${miner.planName} 产出 ${snapshot.claimable} 能量`);
      return sendJson(res, 200, { miner: minerSnapshot(miner), user: publicUser(fresh), claimed: snapshot.claimable });
    });
  }

  if (pathname === '/api/games/play' && req.method === 'POST') {
    const { session, user } = await auth(req);
    ensureOperationalUser(user);
    await requireCsrf(req, session);
    const body = await readBody(req);
    const game = games.find((item) => item.id === body.gameId);
    if (!game) throw Object.assign(new Error('游戏不存在'), { status: 404 });
    return withDb((db) => {
      db.gamePlays ||= [];
      const fresh = db.users.find((item) => item.id === user.id);
      const lastPlay = db.gamePlays.find((item) => item.userId === fresh.id && item.gameId === game.id);
      const cooldownMs = game.cooldownMs || gameCooldownMs;
      if (lastPlay && Date.now() - new Date(lastPlay.createdAt).getTime() < cooldownMs) {
        throw Object.assign(new Error('该游戏冷却中，请稍后再试'), { status: 429 });
      }
      const reward = gameReward(game, db, fresh.id);
      fresh.energy = Math.round((fresh.energy + reward) * 100) / 100;
      const play = {
        id: id('game'),
        userId: fresh.id,
        username: fresh.username,
        gameId: game.id,
        gameName: game.name,
        reward,
        createdAt: now()
      };
      db.gamePlays.unshift(play);
      addLedger(db, fresh.id, 'game_reward', reward, play.id, `${game.name} 辅助奖励`);
      audit(db, fresh, 'game_played', `${fresh.username} 参与 ${game.name}，获得 ${reward} 能量`);
      return sendJson(res, 201, { play, user: publicUser(fresh), gameCooldownMs: cooldownMs });
    });
  }

  if (pathname === '/api/deposits' && req.method === 'POST') {
    const { session, user } = await auth(req);
    ensureOperationalUser(user);
    await requireCsrf(req, session);
    const isMultipart = String(req.headers['content-type'] || '').startsWith('multipart/form-data');
    let body;
    let files = {};
    if (isMultipart) {
      const parsed = parseMultipart(await readRawBody(req), req.headers['content-type']);
      body = parsed.fields;
      files = parsed.files;
    } else {
      body = await readBody(req);
    }
    const amount = assertAmount(body.amount);
    const channel = assertText(body.channel || '', '充值方式', 2, 24);
    let depositDetails = {};
    if (channel === 'cold_wallet') {
      const receiptUrl = isMultipart ? await saveReceiptUpload(files.receipt) : assertText(body.receiptUrl, '凭证截图', 4, 160);
      depositDetails = {
        network: rechargeConfig.usdtNetwork,
        walletAddress: rechargeConfig.coldWalletAddress,
        receiptUrl
      };
      if (body.txHash) depositDetails.txHash = assertText(body.txHash, '交易哈希', 8, 120);
    } else if (channel === 'credit_card') {
      const cardHolder = assertText(body.cardHolder, '持卡人姓名', 2, 80);
      const cardNumber = digitsOnly(body.cardNumber);
      const cvv = digitsOnly(body.cvv);
      const expiry = normalizeExpiry(body.expiry);
      if (cardNumber.length < 13 || cardNumber.length > 19) throw Object.assign(new Error('卡号格式不正确'), { status: 400 });
      if (!luhnValid(cardNumber)) throw Object.assign(new Error('卡号校验失败'), { status: 400 });
      if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(expiry)) throw Object.assign(new Error('有效期格式应为 MM/YY'), { status: 400 });
      if (!expiryValid(expiry)) throw Object.assign(new Error('信用卡已过期'), { status: 400 });
      if (cvv.length < 3 || cvv.length > 4) throw Object.assign(new Error('安全码格式不正确'), { status: 400 });
      depositDetails = {
        cardHolder,
        cardLast4: cardNumber.slice(-4),
        expiry,
        processor: rechargeConfig.creditCardProcessor
      };
    } else {
      throw Object.assign(new Error('充值方式不支持'), { status: 400 });
    }
    return withDb((db) => {
      const deposit = { id: id('dep'), userId: user.id, username: user.username, amount, channel, details: depositDetails, status: 'pending', createdAt: now(), reviewedAt: null };
      db.deposits.unshift(deposit);
      audit(db, user, 'deposit_created', `提交充值申请 ${amount}`);
      return sendJson(res, 201, { deposit });
    });
  }

  if (pathname === '/api/withdrawals' && req.method === 'POST') {
    const { session, user } = await auth(req);
    ensureOperationalUser(user);
    await requireCsrf(req, session);
    const body = await readBody(req);
    const amount = assertAmount(body.amount);
    const walletAddress = assertText(body.walletAddress || body.destination, '冷钱包地址', 20, 120);
    if (amount < minWithdrawalAmount) throw Object.assign(new Error(`最低提现能量为 ${minWithdrawalAmount}`), { status: 400 });
    const fee = Math.round(amount * withdrawalFeeRate * 100) / 100;
    const receiveAmount = Math.round((amount - fee) * 100) / 100;
    return withDb((db) => {
      const fresh = db.users.find((item) => item.id === user.id);
      if ((fresh.withdrawableEnergy || 0) < amount || fresh.energy < amount) throw Object.assign(new Error('可提现能量不足'), { status: 400 });
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayCount = db.withdrawals.filter((item) => item.userId === fresh.id && new Date(item.createdAt) >= todayStart).length;
      if (todayCount >= dailyWithdrawalLimit) throw Object.assign(new Error(`每日最多提交 ${dailyWithdrawalLimit} 次提现申请`), { status: 429 });
      const referrer = fresh.referrerId ? db.users.find((item) => item.id === fresh.referrerId) : null;
      const referralReward = referrer ? Math.round(amount * referralRewardRate * 100) / 100 : 0;
      const platformFee = Math.round((fee - referralReward) * 100) / 100;
      fresh.energy = Math.round((fresh.energy - amount) * 100) / 100;
      fresh.withdrawableEnergy = Math.round(((fresh.withdrawableEnergy || 0) - amount) * 100) / 100;
      fresh.frozen = Math.round((fresh.frozen + amount) * 100) / 100;
      const withdrawal = {
        id: id('wd'),
        userId: fresh.id,
        username: fresh.username,
        amount,
        fee,
        receiveAmount,
        feeRate: withdrawalFeeRate,
        platformFee,
        referralReward,
        referralRewardRate: referrer ? referralRewardRate : 0,
        referrerId: referrer?.id || '',
        referrerUsername: referrer?.username || '',
        method: 'cold_wallet',
        network: rechargeConfig.usdtNetwork,
        walletAddress,
        destination: walletAddress,
        status: 'pending',
        createdAt: now(),
        reviewedAt: null
      };
      db.withdrawals.unshift(withdrawal);
      addLedger(db, fresh.id, 'withdraw_freeze', -amount, withdrawal.id, `提现申请冻结，手续费 ${fee}，预计到账 ${receiveAmount}${referrer ? `，邀请奖励待结算 ${referralReward}` : ''}`);
      audit(db, fresh, 'withdrawal_created', `提交提现申请 ${amount}，手续费 ${fee}，预计到账 ${receiveAmount}${referrer ? `，邀请人 ${referrer.username}` : ''}`);
      return sendJson(res, 201, { withdrawal, user: publicUser(fresh) });
    });
  }

  if (pathname === '/api/admin/overview' && req.method === 'GET') {
    await auth(req, 'admin');
    return readDb((db) => sendJson(res, 200, {
      users: db.users.map((item) => userStats(db, item)),
      deposits: db.deposits,
      withdrawals: db.withdrawals,
      userMiners: db.userMiners || [],
      gamePlays: db.gamePlays || [],
      referralRewards: db.referralRewards || [],
      ledger: db.ledger.slice(0, 100),
      audit: db.audit.slice(0, 100)
    }));
  }

  const userStatus = pathname.match(/^\/api\/admin\/users\/([^/]+)\/status$/);
  if (userStatus && req.method === 'POST') {
    const { session, user } = await auth(req, 'admin');
    await requireCsrf(req, session);
    const [, targetId] = userStatus;
    const body = await readBody(req);
    const nextStatus = assertText(body.status || '', '账号状态', 5, 12);
    if (!['active', 'frozen', 'banned'].includes(nextStatus)) throw Object.assign(new Error('账号状态不支持'), { status: 400 });
    const reason = assertText(body.reason || '后台手动调整', '处理原因', 2, 120);
    const note = body.note ? assertText(body.note, '操作备注', 0, 240) : '';
    return withDb((db) => {
      const target = db.users.find((item) => item.id === targetId);
      if (!target) throw Object.assign(new Error('用户不存在'), { status: 404 });
      if (target.role === 'admin' && nextStatus !== 'active') throw Object.assign(new Error('不能冻结或封禁管理员'), { status: 400 });
      target.status = nextStatus;
      target.riskReason = reason;
      target.riskNote = note;
      target.statusUpdatedAt = now();
      target.statusUpdatedBy = user.username;
      if (nextStatus === 'banned') db.sessions = db.sessions.filter((item) => item.userId !== target.id);
      const label = { active: '恢复正常', frozen: '冻结', banned: '封禁' }[nextStatus];
      audit(db, user, 'user_status_changed', `${label}用户 ${target.username}，原因：${reason}${note ? `，备注：${note}` : ''}`);
      return sendJson(res, 200, { user: userStats(db, target) });
    });
  }

  const resetPassword = pathname.match(/^\/api\/admin\/users\/([^/]+)\/reset-password$/);
  if (resetPassword && req.method === 'POST') {
    const { session, user } = await auth(req, 'admin');
    await requireCsrf(req, session);
    const [, targetId] = resetPassword;
    return withDb((db) => {
      const target = db.users.find((item) => item.id === targetId);
      if (!target) throw Object.assign(new Error('用户不存在'), { status: 404 });
      const password = crypto.randomBytes(10).toString('base64url');
      target.passwordHash = hashPassword(password);
      db.sessions = db.sessions.filter((item) => item.userId !== target.id);
      audit(db, user, 'user_password_reset', `重置用户 ${target.username} 密码`);
      return sendJson(res, 200, { user: userStats(db, target), temporaryPassword: password });
    });
  }

  const depositReview = pathname.match(/^\/api\/admin\/deposits\/([^/]+)\/(approve|reject)$/);
  if (depositReview && req.method === 'POST') {
    const { session, user } = await auth(req, 'admin');
    await requireCsrf(req, session);
    const [, depositId, decision] = depositReview;
    return withDb((db) => {
      const deposit = db.deposits.find((item) => item.id === depositId);
      if (!deposit || deposit.status !== 'pending') throw Object.assign(new Error('充值申请不存在或已处理'), { status: 404 });
      const target = db.users.find((item) => item.id === deposit.userId);
      if (!target) throw Object.assign(new Error('用户不存在'), { status: 404 });
      deposit.status = decision === 'approve' ? 'approved' : 'rejected';
      deposit.reviewedAt = now();
      deposit.reviewedBy = user.username;
      if (decision === 'approve') {
        target.energy = Math.round((target.energy + deposit.amount) * 100) / 100;
        addLedger(db, target.id, 'deposit_approved', deposit.amount, deposit.id, '充值审核通过，转换为可用能量');
      }
      audit(db, user, `deposit_${decision}`, `${decision === 'approve' ? '通过' : '拒绝'} ${deposit.username} 充值 ${deposit.amount}`);
      return sendJson(res, 200, { deposit, user: publicUser(target) });
    });
  }

  const withdrawalReview = pathname.match(/^\/api\/admin\/withdrawals\/([^/]+)\/(approve|reject)$/);
  if (withdrawalReview && req.method === 'POST') {
    const { session, user } = await auth(req, 'admin');
    await requireCsrf(req, session);
    const [, withdrawalId, decision] = withdrawalReview;
    let payoutProof = null;
    if (decision === 'approve') {
      const isMultipart = String(req.headers['content-type'] || '').startsWith('multipart/form-data');
      if (!isMultipart) throw Object.assign(new Error('通过提现时必须上传付款凭证'), { status: 400 });
      const parsed = parseMultipart(await readRawBody(req), req.headers['content-type']);
      const payoutTxHash = assertText(parsed.fields.payoutTxHash, '付款 TxID', 8, 120);
      const receiptUrl = await saveReceiptUpload(parsed.files.payoutReceipt);
      payoutProof = { payoutTxHash, receiptUrl };
    } else {
      await readBody(req).catch(() => ({}));
    }
    return withDb((db) => {
      const withdrawal = db.withdrawals.find((item) => item.id === withdrawalId);
      if (!withdrawal || withdrawal.status !== 'pending') throw Object.assign(new Error('提现申请不存在或已处理'), { status: 404 });
      const target = db.users.find((item) => item.id === withdrawal.userId);
      if (!target) throw Object.assign(new Error('用户不存在'), { status: 404 });
      withdrawal.status = decision === 'approve' ? 'approved' : 'rejected';
      withdrawal.reviewedAt = now();
      withdrawal.reviewedBy = user.username;
      target.frozen = Math.max(0, Math.round((target.frozen - withdrawal.amount) * 100) / 100);
      if (decision === 'reject') {
        target.energy = Math.round((target.energy + withdrawal.amount) * 100) / 100;
        target.withdrawableEnergy = Math.round(((target.withdrawableEnergy || 0) + withdrawal.amount) * 100) / 100;
        addLedger(db, target.id, 'withdraw_rejected_refund', withdrawal.amount, withdrawal.id, '提现拒绝退回能量');
      } else {
        const fee = withdrawal.fee ?? Math.round(withdrawal.amount * withdrawalFeeRate * 100) / 100;
        const receiveAmount = withdrawal.receiveAmount ?? Math.round((withdrawal.amount - fee) * 100) / 100;
        const referrer = withdrawal.referrerId ? db.users.find((item) => item.id === withdrawal.referrerId) : null;
        const referralReward = referrer ? Math.round((withdrawal.referralReward ?? withdrawal.amount * referralRewardRate) * 100) / 100 : 0;
        const platformFee = Math.round((fee - referralReward) * 100) / 100;
        withdrawal.fee = fee;
        withdrawal.receiveAmount = receiveAmount;
        withdrawal.feeRate = withdrawal.feeRate ?? withdrawalFeeRate;
        withdrawal.platformFee = platformFee;
        withdrawal.referralReward = referralReward;
        withdrawal.referralRewardRate = referrer ? referralRewardRate : 0;
        withdrawal.payout = payoutProof;
        addLedger(db, target.id, 'withdraw_approved', -fee, withdrawal.id, `提现审核通过，到账 ${receiveAmount}，手续费 ${fee}`);
        if (referrer && referralReward > 0) {
          referrer.energy = Math.round((Number(referrer.energy || 0) + referralReward) * 100) / 100;
          referrer.withdrawableEnergy = Math.round((Number(referrer.withdrawableEnergy || 0) + referralReward) * 100) / 100;
          referrer.referralRewardBalance = Math.round((Number(referrer.referralRewardBalance || 0) + referralReward) * 100) / 100;
          const reward = {
            id: id('ref'),
            referrerId: referrer.id,
            referrerUsername: referrer.username,
            invitedUserId: target.id,
            invitedUsername: target.username,
            withdrawalId: withdrawal.id,
            amount: referralReward,
            sourceAmount: withdrawal.amount,
            fee,
            status: 'settled',
            createdAt: now()
          };
          db.referralRewards.unshift(reward);
          addLedger(db, referrer.id, 'referral_reward', referralReward, reward.id, `邀请用户 ${target.username} 提现审核通过，奖励 ${referralReward}`);
          audit(db, user, 'referral_reward_settled', `结算邀请奖励 ${referralReward} 给 ${referrer.username}，来源用户 ${target.username}`);
        }
      }
      audit(db, user, `withdrawal_${decision}`, `${decision === 'approve' ? '通过' : '拒绝'} ${withdrawal.username} 提现 ${withdrawal.amount}`);
      return sendJson(res, 200, { withdrawal, user: publicUser(target) });
    });
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

async function staticFile(res, pathname) {
  if (pathname.startsWith('/uploads/')) {
    const file = path.normalize(path.join(uploadDir, pathname.replace('/uploads/', '')));
    if (!file.startsWith(uploadDir)) return send(res, 403, 'Forbidden');
    try {
      const data = await readFile(file);
      const ext = path.extname(file);
      const types = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
      res.writeHead(200, { ...securityHeaders, 'Content-Type': types[ext] || 'application/octet-stream' });
      res.end(data);
    } catch {
      send(res, 404, 'Not Found');
    }
    return;
  }
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(publicDir, requested));
  if (!file.startsWith(publicDir)) return send(res, 403, 'Forbidden');
  try {
    const data = await readFile(file);
    const ext = path.extname(file);
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
    res.writeHead(200, { ...securityHeaders, 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    const html = await readFile(path.join(publicDir, 'index.html'));
    res.writeHead(200, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url.pathname);
    return await staticFile(res, url.pathname);
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    return sendJson(res, status, { error: error.message || '服务器错误' });
  }
});

try {
  await loadDb();
  if (usePostgres) postgresStatus = 'connected';
} catch (error) {
  if (!usePostgres) throw error;
  await fallbackToJsonStorage(error);
  await loadDb();
}
server.listen(port, () => {
  console.log(`Secure mining platform running at http://localhost:${port}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log(`Bootstrap admin password: ${adminBootstrapPath}`);
  }
});
