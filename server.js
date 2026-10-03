/* ============================================================
   🖥️ server.js — سيرفر Basetna English
   ------------------------------------------------------------
   - بيقرأ المفاتيح من .env
   - نظام تدوير ذكي: لو مفتاح خلص، يروح للتاني
   - التحقق من تسجيل الدخول (Supabase)
   - /api/ai              → المساعد الذكي
   - /api/generate-quiz   → توليد امتحانات من الدروس
   - /api/health          → فحص الحالة
   ============================================================ */

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

/* ============================================================
   🔑 جمع كل المفاتيح من .env
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
  /* دعم للمفتاح القديم GEMINI_API_KEY (لو موجود) */
  if (process.env.GEMINI_API_KEY && !keys.includes(process.env.GEMINI_API_KEY)) {
    keys.unshift(process.env.GEMINI_API_KEY);
  }
  return keys;
}

const API_KEYS = loadApiKeys();
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

if (API_KEYS.length === 0) {
  console.error('❌ خطأ: مفيش أي مفتاح Gemini');
  process.exit(1);
}

console.log(`🔑 عدد المفاتيح: ${API_KEYS.length}`);
console.log(`🤖 الموديل: ${MODEL_NAME}`);

/* ============================================================
   🔐 التحقق من تسجيل الدخول (Supabase)
   ============================================================ */
const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://wgostqkywpybmzgbyzeo.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'sb_publishable_zx0zeWR2bpbmyO90oN-4ow_FxZCSPl8';

async function verifyUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return null;

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

/* ============================================================
   🔄 مدير المفاتيح الذكي
   ============================================================ */
class KeyManager {
  constructor(keys) {
    this.keys = keys;
    this.currentIndex = 0;
    this.status = keys.map(() => ({
      valid: true,
      failCount: 0,
      lastFail: null,
      cooldownUntil: null,
    }));
  }

  current() {
    if (
      this.status[this.currentIndex].cooldownUntil &&
      Date.now() < this.status[this.currentIndex].cooldownUntil
    ) {
      this.next();
    }
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

  isAvailable(index) {
    const s = this.status[index];
    if (!s.valid) return false;
    if (s.cooldownUntil && Date.now() < s.cooldownUntil) return false;
    return true;
  }

  markFailed(reason) {
    const s = this.status[this.currentIndex];
    s.failCount++;
    s.lastFail = reason;

    if (
      reason.includes('429') ||
      reason.includes('quota') ||
      reason.includes('rate')
    ) {
      s.cooldownUntil = Date.now() + 60 * 1000;
      console.log(`⏸️  المفتاح #${this.currentIndex + 1} في cooldown لمدة دقيقة`);
    } else if (
      reason.includes('API key') ||
      reason.includes('403') ||
      reason.includes('PERMISSION')
    ) {
      s.valid = false;
      console.log(`❌ المفتاح #${this.currentIndex + 1} معطّل نهائي`);
    } else if (s.failCount >= 5) {
      s.cooldownUntil = Date.now() + 5 * 60 * 1000;
    }
  }

  markSuccess() {
    const s = this.status[this.currentIndex];
    s.failCount = 0;
    s.cooldownUntil = null;
  }

  allBusy() {
    return this.status.every((s, i) => !this.isAvailable(i));
  }

  getStatus() {
    return this.status.map((s, i) => ({
      index: i + 1,
      valid: s.valid,
      failCount: s.failCount,
      lastFail: s.lastFail,
      cooldown: s.cooldownUntil
        ? Math.max(0, Math.round((s.cooldownUntil - Date.now()) / 1000)) + 's'
        : null,
    }));
  }
}

const keyManager = new KeyManager(API_KEYS);

/* ============================================================
   📝 System Prompt للمساعد الذكي
   ============================================================ */
const SYSTEM_PROMPT = `أنت "مساعد بسّطنا الإنجليزي" — مساعد ذكي متخصص في تعليم اللغة الإنجليزية للناطقين بالعربية.

مهمتك:
- شرح قواعد اللغة الإنجليزية ببساطة ووضوح
- تصحيح الجمل وتوضيح الأخطاء
- ترجمة عربي ↔ إنجليزي
- اقتراح تمارين وأمثلة
- مساعدة الطلاب في استخدام الموقع

قواعد الرد:
- رد بالعربية أولاً، ثم الإنجليزية عند الحاجة
- كن ودوداً ومشجعاً
- استخدم أمثلة عملية
- لو السؤال مش واضح، اسأل للتوضيح`;

/* ============================================================
   🤖 دالة إرسال الطلب لـ Gemini
   ============================================================ */
async function askGemini(messages) {
  if (keyManager.allBusy()) {
    throw new Error('ALL_KEYS_BUSY');
  }

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }],
  }));

  contents.unshift({
    role: 'user',
    parts: [{ text: SYSTEM_PROMPT }],
  });
  contents.splice(1, 0, {
    role: 'model',
    parts: [{ text: 'تمام، أنا جاهز أساعدك في الإنجليزي.' }],
  });

  let lastError = null;
  let attempts = 0;
  const maxAttempts = API_KEYS.length * 2;

  while (attempts < maxAttempts) {
    if (keyManager.allBusy()) throw new Error('ALL_KEYS_BUSY');

    const apiKey = keyManager.current();
    const keyNum = keyManager.currentIndex + 1;

    try {
      console.log(`🔄 محاولة بـ المفتاح #${keyNum}...`);

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 4096,
          },
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        const errMsg = data?.error?.message || `HTTP ${response.status}`;
        throw new Error(errMsg);
      }

      const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!reply) throw new Error('EMPTY_RESPONSE');

      keyManager.markSuccess();
      console.log(`✅ نجح بـ المفتاح #${keyNum}`);
      return reply;
    } catch (err) {
      lastError = err;
      const msg = err.message || '';
      console.log(`❌ فشل المفتاح #${keyNum}: ${msg.substring(0, 100)}`);

      if (
        msg.includes('API_KEY') ||
        msg.includes('API key') ||
        msg.includes('403') ||
        msg.includes('429') ||
        msg.includes('quota') ||
        msg.includes('rate') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('PERMISSION_DENIED') ||
        msg.includes('EMPTY_RESPONSE')
      ) {
        keyManager.markFailed(msg);
        const nextKey = keyManager.next();
        if (!nextKey) break;
        attempts++;
        continue;
      }

      throw err;
    }
  }

  throw lastError || new Error('ALL_KEYS_BUSY');
}

/* ============================================================
   🛣️ مسار /api/ai — المساعد الذكي
   ============================================================ */
app.post('/api/ai', async (req, res) => {
  try {
    const user = await verifyUser(req);
    if (!user) {
      return res.status(401).json({
        code: 'LOGIN_REQUIRED',
        error: 'سجّل دخولك الأول عشان تستخدم المساعد الذكي',
      });
    }

    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res
        .status(400)
        .json({ code: 'BAD_REQUEST', error: 'لازم تبعت messages (array)' });
    }

    const reply = await askGemini(messages);
    res.json({ reply });
  } catch (err) {
    console.error('❌ [AI Error]', err.message);

    if (err.message === 'ALL_KEYS_BUSY') {
      return res.status(503).json({
        code: 'ALL_KEYS_BUSY',
        error: 'كل المفاتيح مشغولة دلوقتي، جرب تاني بعد دقيقة',
      });
    }
    if (err.message?.includes('API key') || err.message?.includes('403')) {
      return res
        .status(500)
        .json({ code: 'BAD_KEY', error: 'مفتاح Gemini غلط أو منتهي' });
    }
    if (err.message?.includes('429') || err.message?.includes('quota')) {
      return res
        .status(429)
        .json({ code: 'RATE_LIMIT', error: 'الحد المسموح خلص، جرب بعد شوية' });
    }
    res
      .status(500)
      .json({ code: 'SERVER_ERROR', error: err.message || 'حصلت مشكلة' });
  }
});

/* ============================================================
   🎓 مسار /api/generate-quiz — توليد امتحان من درس
   ============================================================ */
app.post('/api/generate-quiz', async (req, res) => {
  try {
    const user = await verifyUser(req);
    if (!user) {
      return res.status(401).json({
        code: 'LOGIN_REQUIRED',
        error: 'سجّل دخولك الأول',
      });
    }

    const { lessonTitle, lessonDescription, lessonDuration } = req.body;

    if (!lessonTitle) {
      return res
        .status(400)
        .json({ code: 'BAD_REQUEST', error: 'محتاج عنوان الدرس' });
    }

    const prompt = `أنت مدرس إنجليزي محترف. اعمل امتحان قصير (5 أسئلة اختيار من متعدد) عن الدرس التالي:

**عنوان الدرس:** ${lessonTitle}
**الوصف:** ${lessonDescription || 'درس في اللغة الإنجليزية'}
**المدة:** ${lessonDuration || 0} دقيقة

**المطلوب:**
- 5 أسئلة اختيار من متعدد.
- 4 خيارات لكل سؤال.
- تحديد الإجابة الصحيحة (رقم 0-3).
- الأسئلة تكون متنوعة (قواعد، مفردات، فهم).

⚠️ مهم جداً: رد بـ JSON بس، من غير أي كلام تاني أو شرح. الشكل بالظبط:

{
  "title_ar": "امتحان: اسم الدرس",
  "questions": [
    {
      "question": "نص السؤال",
      "options": ["خيار 1", "خيار 2", "خيار 3", "خيار 4"],
      "correct": 0
    },
    {
      "question": "نص السؤال التاني",
      "options": ["خيار 1", "خيار 2", "خيار 3", "خيار 4"],
      "correct": 2
    }
  ]
}`;

    const reply = await askGemini([{ role: 'user', content: prompt }]);

    /* نظّف الرد من أي markdown */
    let cleanReply = reply
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    /* لو فيه نص قبل JSON، خد الجزء اللي فيه {} */
    const jsonMatch = cleanReply.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleanReply = jsonMatch[0];

    const quiz = JSON.parse(cleanReply);

    if (!quiz.questions || !Array.isArray(quiz.questions)) {
      throw new Error('الرد مش فيه questions');
    }

    res.json(quiz);
  } catch (err) {
    console.error('❌ [Generate Quiz]', err.message);
    res.status(500).json({
      code: 'SERVER_ERROR',
      error: err.message || 'فشل توليد الامتحان',
    });
  }
});

/* ============================================================
   🏥 مسار /api/health — فحص الحالة
   ============================================================ */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'basetna-ai',
    model: MODEL_NAME,
    totalKeys: API_KEYS.length,
    currentKey: keyManager.currentIndex + 1,
    keysStatus: keyManager.getStatus(),
    time: new Date().toISOString(),
  });
});

/* ============================================================
   🚀 تشغيل السيرفر
   ============================================================ */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('==============================================');
  console.log('🖥️  بسّطنا الإنجليزي — السيرفر شغال');
  console.log('==============================================');
  console.log(`🌐 الموقع:     http://localhost:${PORT}`);
  console.log(`🤖 المساعد:    http://localhost:${PORT}/api/ai`);
  console.log(`🎓 الامتحانات: http://localhost:${PORT}/api/generate-quiz`);
  console.log(`🏥 الحالة:     http://localhost:${PORT}/api/health`);
  console.log(`🔑 المفاتيح:   ${API_KEYS.length} مفتاح`);
  console.log(`🤖 الموديل:    ${MODEL_NAME}`);
  console.log('==============================================');
});