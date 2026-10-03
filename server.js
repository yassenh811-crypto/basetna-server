/* ============================================================
   🖥️ server.js — سيرفر Basetna English
   ============================================================ */

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

/* ============================================================
   🔑 جمع المفاتيح
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

if (API_KEYS.length === 0) {
  console.error('❌ خطأ: مفيش أي مفتاح Gemini');
  process.exit(1);
}

console.log(`🔑 عدد المفاتيح: ${API_KEYS.length}`);
console.log(`🤖 الموديل: ${MODEL_NAME}`);

/* ============================================================
   🔐 Supabase
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
   🔄 مدير المفاتيح
   ============================================================ */
class KeyManager {
  constructor(keys) {
    this.keys = keys;
    this.currentIndex = 0;
    this.status = keys.map(() => ({
      valid: true,
      failCount: 0,
      cooldownUntil: null,
    }));
  }
  current() {
    if (this.status[this.currentIndex].cooldownUntil && Date.now() < this.status[this.currentIndex].cooldownUntil) {
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
  isAvailable(i) {
    const s = this.status[i];
    if (!s.valid) return false;
    if (s.cooldownUntil && Date.now() < s.cooldownUntil) return false;
    return true;
  }
  markFailed(reason) {
    const s = this.status[this.currentIndex];
    s.failCount++;
    if (reason.includes('429') || reason.includes('quota') || reason.includes('rate')) {
      s.cooldownUntil = Date.now() + 60 * 1000;
    } else if (reason.includes('API key') || reason.includes('403')) {
      s.valid = false;
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
    const keyNum = keyManager.currentIndex + 1;

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
        }),
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
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ code: 'BAD_REQUEST', error: 'لازم تبعت messages' });
    }

    const reply = await askGemini(messages);
    res.json({ reply });
  } catch (err) {
    console.error('❌ [AI]', err.message);
    if (err.message === 'ALL_KEYS_BUSY') return res.status(503).json({ code: 'ALL_KEYS_BUSY', error: 'جرب تاني بعد دقيقة' });
    res.status(500).json({ code: 'SERVER_ERROR', error: err.message || 'حصلت مشكلة' });
  }
});

/* ============================================================
   🎓 /api/generate-quiz — 15 سؤال
   ============================================================ */
app.post('/api/generate-quiz', async (req, res) => {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ code: 'LOGIN_REQUIRED', error: 'سجّل دخولك' });

    const {
      lessonTitle,
      lessonDescription,
      lessonDuration,
      questionsCount = 15,
      timeLimitMin = 10,
      maxAttempts = 1,
    } = req.body;

    if (!lessonTitle) return res.status(400).json({ code: 'BAD_REQUEST', error: 'محتاج عنوان الدرس' });

    const prompt = `أنت مدرس إنجليزي محترف. اعمل امتحان (${questionsCount} سؤال اختيار من متعدد) عن الدرس التالي:

**عنوان الدرس:** ${lessonTitle}
**الوصف:** ${lessonDescription || 'درس في اللغة الإنجليزية'}
**المدة:** ${lessonDuration || 0} دقيقة

**المطلوب:**
- ${questionsCount} سؤال اختيار من متعدد.
- 4 خيارات لكل سؤال.
- تحديد الإجابة الصحيحة (رقم 0-3).
- الأسئلة تكون متنوعة (قواعد، مفردات، فهم).

⚠️ مهم جداً: رد بـ JSON بس، من غير أي كلام تاني. الشكل:

{
  "title_ar": "امتحان: اسم الدرس",
  "questions": [
    {
      "question": "نص السؤال",
      "options": ["خيار 1", "خيار 2", "خيار 3", "خيار 4"],
      "correct": 0
    }
  ]
}`;

    const reply = await askGemini([{ role: 'user', content: prompt }]);

    let cleanReply = reply.replace(/```json/g, '').replace(/```/g, '').trim();
    const jsonMatch = cleanReply.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleanReply = jsonMatch[0];

    const quiz = JSON.parse(cleanReply);
    if (!quiz.questions || !Array.isArray(quiz.questions)) throw new Error('الرد مش فيه questions');

    res.json({
      title_ar: quiz.title_ar,
      questions: quiz.questions,
      time_limit_min: timeLimitMin,
      max_attempts: maxAttempts,
      questions_count: questionsCount,
    });
  } catch (err) {
    console.error('❌ [Quiz]', err.message);
    res.status(500).json({ code: 'SERVER_ERROR', error: err.message || 'فشل التوليد' });
  }
});

/* ============================================================
   🏥 /api/health
   ============================================================ */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'basetna-server',
    model: MODEL_NAME,
    totalKeys: API_KEYS.length,
    time: new Date().toISOString(),
  });
});

/* ============================================================
   🚀 Vercel
   ============================================================ */
module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🖥️ بسّطنا الإنجليزي — السيرفر شغال على ${PORT}`);
  });
}