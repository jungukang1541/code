require('dotenv').config();
const express = require('express');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const PORT = process.env.PORT || 3000;

const LOOKBACK_MINUTES = Number(process.env.LOOKBACK_MINUTES || 15);

function loadAccounts() {
  const accounts = [];
  let i = 1;
  while (process.env[`MAIL_USER_${i}`]) {
    accounts.push({
      host: process.env[`MAIL_HOST_${i}`] || 'imap.gmail.com',
      port: Number(process.env[`MAIL_PORT_${i}`] || 993),
      user: process.env[`MAIL_USER_${i}`],
      pass: process.env[`MAIL_PASS_${i}`],
      domain: process.env[`DOMAIN_${i}`],
    });
    i += 1;
  }
  if (accounts.length === 0 && process.env.MAIL_USER) {
    accounts.push({
      host: process.env.MAIL_HOST || 'imap.gmail.com',
      port: Number(process.env.MAIL_PORT || 993),
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS,
      domain: process.env.DOMAIN,
    });
  }
  return accounts;
}

const ACCOUNTS = loadAccounts();

if (ACCOUNTS.length === 0 || ACCOUNTS.some((a) => !a.user || !a.pass || !a.domain)) {
  console.error('메일 계정 환경변수가 올바르지 않습니다. MAIL_USER_1/MAIL_PASS_1/DOMAIN_1 (또는 레거시 MAIL_USER/MAIL_PASS/DOMAIN)을 .env 에 설정해주세요.');
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

function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&shy;/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCode(rawText, html) {
  const text = rawText || htmlToText(html);
  if (!text) return null;
  const labeled = text.match(/(?:인증\s*(?:번호|코드)|확인\s*코드|verification\s*code|security\s*code|otp)[^0-9A-Za-z]{0,10}([A-Z0-9]{4,8})/i);
  if (labeled) return labeled[1];

  const codeAfterPhrase = text.match(/코드를\s*입력하고\s*로그인하세요[^0-9]{0,15}(\d{4,6})/);
  if (codeAfterPhrase) return codeAfterPhrase[1];

  const codeBeforePhrase = text.match(/(\d{4,6})[^0-9]{0,15}(?:에\s*로그인하려면|로그인하려면\s*디바이스에\s*위\s*코드를\s*입력)/);
  if (codeBeforePhrase) return codeBeforePhrase[1];

  const enterCodeBelow = text.match(/(?:enter\s*the\s*code\s*below|use\s*the\s*code\s*below)[^0-9A-Za-z]{0,15}(\d{4,6})/i);
  if (enterCodeBelow) return enterCodeBelow[1];

  const enterCodeOnDevice = text.match(/(\d{4,6})[^0-9]{0,15}enter\s*(?:the|this)\s*code\s*on\s*(?:your|the)\s*device/i);
  if (enterCodeOnDevice) return enterCodeOnDevice[1];

  const sixDigit = text.match(/\b\d{6}\b/);
  if (sixDigit) return sixDigit[0];

  const generic = text.match(/\b\d{4,8}\b/);
  if (generic) return generic[0];

  return null;
}

function isValidId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(id);
}

async function findCodeInAccount(account, id) {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: true,
    auth: { user: account.user, pass: account.pass },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - LOOKBACK_MINUTES * 60_000);
      const targetAddress = `${id.toLowerCase()}@${account.domain.toLowerCase()}`;

      // IMAP 서버에 To 헤더로 바로 필터링을 맡겨서, 메일을 일일이 열어보지 않게 함
      const uids = await client.search({ since, header: { to: targetAddress } }, { uid: true });
      if (!uids || uids.length === 0) return null;

      const recentUids = uids.slice(-10).reverse();

      for (const uid of recentUids) {
        const msg = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
        if (!msg) continue;

        // header 검색은 부분일치라, 정확히 일치하는지 한번 더 확인
        const toList = (msg.envelope?.to || []).map((t) => (t.address || '').toLowerCase());
        if (!toList.includes(targetAddress)) continue;

        const parsed = await simpleParser(msg.source);
        const code = extractCode(parsed.text, parsed.html);
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

async function findCodeForId(id) {
  const results = await Promise.all(
    ACCOUNTS.map((account) => findCodeInAccount(account, id).catch(() => null))
  );
  return results.find((result) => result) || null;
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
