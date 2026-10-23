require('dotenv').config();
const express = require('express');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const PORT = process.env.PORT || 3000;

const MAIL_HOST = process.env.MAIL_HOST || 'imap.gmail.com';
const MAIL_PORT = Number(process.env.MAIL_PORT || 993);
const MAIL_USER = process.env.MAIL_USER;
const MAIL_PASS = process.env.MAIL_PASS;
const DOMAIN = process.env.DOMAIN;
const LOOKBACK_MINUTES = Number(process.env.LOOKBACK_MINUTES || 15);

if (!MAIL_USER || !MAIL_PASS || !DOMAIN) {
  console.error('MAIL_USER, MAIL_PASS, DOMAIN 환경변수를 .env 에 설정해주세요.');
  process.exit(1);
}

// 아주 단순한 IP당 레이트리밋 (분당 30회 - 프론트엔드 자동 재시도가 분당 최대 20회라 여유를 둠)
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const entry = hits.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count += 1;
  hits.set(ip, entry);
  return entry.count > 30;
}

function extractCode(text) {
  if (!text) return null;
  const labeled = text.match(/(?:인증\s*(?:번호|코드)|확인\s*코드|verification\s*code|security\s*code|otp)[^0-9A-Za-z]{0,10}([A-Z0-9]{4,8})/i);
  if (labeled) return labeled[1];

  const sixDigit = text.match(/\b\d{6}\b/);
  if (sixDigit) return sixDigit[0];

  const generic = text.match(/\b\d{4,8}\b/);
  if (generic) return generic[0];

  return null;
}

function isValidId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(id);
}

async function findCodeForId(id) {
  const client = new ImapFlow({
    host: MAIL_HOST,
    port: MAIL_PORT,
    secure: true,
    auth: { user: MAIL_USER, pass: MAIL_PASS },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - LOOKBACK_MINUTES * 60_000);
      const uids = await client.search({ since }, { uid: true });
      if (!uids || uids.length === 0) return null;

      const recentUids = uids.slice(-50).reverse();
      const targetAddress = `${id.toLowerCase()}@${DOMAIN.toLowerCase()}`;

      for (const uid of recentUids) {
        const msg = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
        if (!msg) continue;

        const toList = (msg.envelope?.to || []).map((t) => (t.address || '').toLowerCase());
        const matches = toList.some((addr) => addr === targetAddress);
        if (!matches) continue;

        const parsed = await simpleParser(msg.source);
        const code = extractCode(parsed.text || parsed.html || '');
        if (code) {
          return { code, subject: parsed.subject || '', date: parsed.date };
        }
      }
      return null;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/code', async (req, res) => {
  const ip = req.ip;
  if (rateLimited(ip)) {
    return res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
  }

  const id = req.query.id;
  if (!isValidId(id)) {
    return res.status(400).json({ error: 'ID 형식이 올바르지 않습니다.' });
  }

  try {
    const result = await findCodeForId(id);
    if (!result) {
      return res.status(404).json({ error: '아직 도착한 메일이 없습니다.' });
    }
    return res.json(result);
  } catch (err) {
    console.error('메일 조회 실패:', err);
    return res.status(500).json({ error: '메일 서버 조회 중 오류가 발생했습니다.' });
  }
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
