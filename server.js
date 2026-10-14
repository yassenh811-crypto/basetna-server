/* ============================================================
   🖥️ server.js — سيرفر Basetna English
   ------------------------------------------------------------
   - المساعد الذكي (AI)
   - توليد الامتحانات
   - السيرفر الوسيط للفيديوهات (Google Drive Stream)
   ============================================================ */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

/* ============================================================
   🔑 مفاتيح Gemini
   ============================================================ */
function loadApiKeys() {
  const keys = [];
  let i = 1;
  while (true) {
    const key = process.env[`GEMINI_API_KEY_${i}`];
    if (!key) break;
    if (key.trim() && !key.includes('...')) keys.push(key.trim());
    i++;
  }
  if (process.env.GEMINI_API_KEY && !keys.includes(process.env.GEMINI_API_KEY)) {
    keys.unshift(process.env.GEMINI_API_KEY);
  }
  return keys;
}

const API_KEYS = loadApiKeys();
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

console.log(`🔑 عدد المفاتيح: ${API_KEYS.length}`);
console.log(`🤖 الموديل: ${MODEL_NAME}`);

/* ============================================================
   🔐 Supabase
   ============================================================ */
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wgostqkywpybmzgbyzeo.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_zx0zeWR2bpbmyO90oN-4ow_FxZCSPl8';

async function verifyUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/* ============================================================
   🔄 مدير المفاتيح
   ============================================================ */
class KeyManager {
  constructor(keys) {
    this.keys = keys;
    this.currentIndex = 0;
    this.status = keys.map(() => ({ valid: true, failCount: 0, cooldownUntil: null }));
  }
  current() {
    if (this.status[this.currentIndex].cooldownUntil && Date.now() < this.status[this.currentIndex].cooldownUntil) this.next();
    return this.keys[this.currentIndex];
  }
  next() {
    let tries = 0;
    do {
      this.currentIndex = (this.currentIndex + 1) % this.keys.length;
      tries++;
      if (tries > this.keys.length) return null;
    } while (!this.isAvailable(this.currentIndex));
    return this.current();
  }
  isAvailable(i) {
    const s = this.status[i];
    if (!s.valid) return false;
    if (s.cooldownUntil && Date.now() < s.cooldownUntil) return false;
    return true;
  }
  markFailed(reason) {
    const s = this.status[this.currentIndex];
    s.failCount++;
    if (reason.includes('429') || reason.includes('quota') || reason.includes('rate')) s.cooldownUntil = Date.now() + 60000;
    else if (reason.includes('API key') || reason.includes('403')) s.valid = false;
    else if (s.failCount >= 5) s.cooldownUntil = Date.now() + 300000;
  }
  markSuccess() { const s = this.status[this.currentIndex]; s.failCount = 0; s.cooldownUntil = null; }
  allBusy() { return this.status.every((s, i) => !this.isAvailable(i)); }
}

const keyManager = new KeyManager(API_KEYS);

/* ============================================================
   📝 System Prompt
   ============================================================ */
const SYSTEM_PROMPT = `أنت "مساعد بسّطنا الإنجليزي" — مساعد ذكي متخصص في تعليم اللغة الإنجليزية للناطقين بالعربية.

مهمتك:
- شرح قواعد اللغة الإنجليزية ببساطة ووضوح
- تصحيح الجمل وتوضيح الأخطاء
- ترجمة عربي ↔ إنجليزي
- اقتراح تمارين وأمثلة

قواعد الرد:
- رد بالعربية أولاً، ثم الإنجليزية عند الحاجة
- كن ودوداً ومشجعاً`;

/* ============================================================
   🤖 askGemini
   ============================================================ */
async function askGemini(messages) {
  if (keyManager.allBusy()) throw new Error('ALL_KEYS_BUSY');

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }],
  }));
  contents.unshift({ role: 'user', parts: [{ text: SYSTEM_PROMPT }] });
  contents.splice(1, 0, { role: 'model', parts: [{ text: 'تمام، أنا جاهز أساعدك في الإنجليزي.' }] });

  let lastError = null;
  let attempts = 0;
  const maxAttempts = API_KEYS.length * 2;

  while (attempts < maxAttempts) {
    if (keyManager.allBusy()) throw new Error('ALL_KEYS_BUSY');
    const apiKey = keyManager.current();
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, generationConfig: { temperature: 0.7, maxOutputTokens: 8192 } }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
      const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!reply) throw new Error('EMPTY_RESPONSE');
      keyManager.markSuccess();
      return reply;
    } catch (err) {
      lastError = err;
      const msg = err.message || '';
      if (msg.includes('API key') || msg.includes('403') || msg.includes('429') || msg.includes('quota') || msg.includes('rate') || msg.includes('EMPTY_RESPONSE')) {
        keyManager.markFailed(msg);
        if (!keyManager.next()) break;
        attempts++;
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error('ALL_KEYS_BUSY');
}

/* ============================================================
   🛣️ /api/ai
   ============================================================ */
app.post('/api/ai', async (req, res) => {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ code: 'LOGIN_REQUIRED', error: 'سجّل دخولك الأول' });
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ code: 'BAD_REQUEST', error: 'لازم تبعت messages' });
    const reply = await askGemini(messages);
    res.json({ reply });
  } catch (err) {
    console.error('❌ [AI]', err.message);
    if (err.message === 'ALL_KEYS_BUSY') return res.status(503).json({ code: 'ALL_KEYS_BUSY', error: 'جرب تاني بعد دقيقة' });
    res.status(500).json({ code: 'SERVER_ERROR', error: err.message || 'حصلت مشكلة' });
  }
});

/* ============================================================
   🎓 /api/generate-quiz
   ============================================================ */
app.post('/api/generate-quiz', async (req, res) => {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ code: 'LOGIN_REQUIRED', error: 'سجّل دخولك' });
    const { lessonTitle, lessonDescription, questionsCount = 15, timeLimitMin = 10, maxAttempts = 1 } = req.body;
    if (!lessonTitle) return res.status(400).json({ code: 'BAD_REQUEST', error: 'محتاج عنوان الدرس' });

    const prompt = `أنت مدرس إنجليزي محترف. اعمل امتحان (${questionsCount} سؤال اختيار من متعدد) عن الدرس التالي:

**عنوان الدرس:** ${lessonTitle}
**الوصف:** ${lessonDescription || 'درس في اللغة الإنجليزية'}

⚠️ رد بـ JSON بس بالشكل:
{
  "title_ar": "امتحان: اسم الدرس",
  "questions": [{"question": "...", "options": ["...", "..."], "correct": 0}]
}`;

    const reply = await askGemini([{ role: 'user', content: prompt }]);
    let cleanReply = reply.replace(/```json/g, '').replace(/```/g, '').trim();
    const jsonMatch = cleanReply.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleanReply = jsonMatch[0];
    const quiz = JSON.parse(cleanReply);
    if (!quiz.questions || !Array.isArray(quiz.questions)) throw new Error('الرد مش فيه questions');
    res.json({ ...quiz, time_limit_min: timeLimitMin, max_attempts: maxAttempts, questions_count: questionsCount });
  } catch (err) {
    console.error('❌ [Quiz]', err.message);
    res.status(500).json({ code: 'SERVER_ERROR', error: err.message || 'فشل التوليد' });
  }
});

/* ============================================================
   🎬 Google Drive — السيرفر الوسيط
   ============================================================ */
let drive = null;
try {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}'),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  drive = google.drive({ version: 'v3', auth });
  console.log('✅ Google Drive جاهز');
} catch (err) {
  console.warn('⚠️ Google Drive مش مفعّل:', err.message);
}

const LESSONS = {
  'lesson-1': 'PUT_DRIVE_FILE_ID_HERE',
  'lesson-2': 'PUT_DRIVE_FILE_ID_HERE',
};

function requireLogin(req, res, next) {
  next();
}

app.get('/api/stream/:lessonId', requireLogin, async (req, res) => {
  if (!drive) return res.status(503).json({ error: 'Drive not configured' });
  try {
    const fileId = LESSONS[req.params.lessonId];
    if (!fileId) return res.sendStatus(404);

    const meta = await drive.files.get({ fileId, fields: 'size,mimeType' });
    const size = Number(meta.data.size);
    const mime = meta.data.mimeType || 'video/mp4';

    let start = 0;
    let end = size - 1;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m && m[1] !== '') start = parseInt(m[1], 10);
      if (m && m[2] !== '') end = Math.min(parseInt(m[2], 10), size - 1);
      if (start > end || start >= size) return res.status(416).set('Content-Range', `bytes */${size}`).end();
    }

    const upstream = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream', headers: { Range: `bytes=${start}-${end}` } }
    );

    res.writeHead(range ? 206 : 200, {
      'Content-Type': mime,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline',
      ...(range && { 'Content-Range': `bytes ${start}-${end}/${size}` }),
    });
    upstream.data.pipe(res);
    req.on('close', () => upstream.data.destroy());
  } catch (err) {
    console.error(err.message);
    if (!res.headersSent) res.sendStatus(500);
  }
});

/* ============================================================
   🏥 /api/health
   ============================================================ */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'basetna-server', model: MODEL_NAME, totalKeys: API_KEYS.length, drive: !!drive, time: new Date().toISOString() });
});

/* ============================================================
   🚀 Vercel
   ============================================================ */
export default app;

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🖥️ السيرفر شغال على ${PORT}`));
}