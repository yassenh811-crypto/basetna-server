/* ============================================================
   🖥️ server.js — سيرفر Basetna English
   ============================================================ */
import express from 'express';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();

// ✅ السماح بالاتصال من أي مكان (هيحل مشكلة CORS)
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ============================================================
// 🔑 مفاتيح Gemini
// ============================================================
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

// ============================================================
// 🔐 Supabase
// ============================================================
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

// ============================================================
// 🤖 askGemini
// ============================================================
async function askGemini(messages) {
  if (API_KEYS.length === 0) throw new Error('مفيش مفاتيح API متسجلة');

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }],
  }));
  
  const systemPrompt = `أنت "مساعد بسّطنا الإنجليزي" — مساعد ذكي متخصص في تعليم اللغة الإنجليزية للناطقين بالعربية.
مهمتك: شرح القواعد، تصحيح الجمل، الترجمة، واقتراح تمارين.
رد بالعربية أولاً، ثم الإنجليزية عند الحاجة. كن ودوداً ومشجعاً.`;

  contents.unshift({ role: 'user', parts: [{ text: systemPrompt }] });
  contents.splice(1, 0, { role: 'model', parts: [{ text: 'تمام، أنا جاهز أساعدك في الإنجليزي.' }] });

  let lastError = null;

  // محاولة استخدام المفاتيح المتاحة
  for (const apiKey of API_KEYS) {
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
      
      return reply;
    } catch (err) {
      console.error(`❌ فشل المفتاح:`, err.message);
      lastError = err;
    }
  }
  
  throw lastError || new Error('فشل الاتصال بجوجل');
}

// ============================================================
// 🛣️ Routes
// ============================================================
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
    res.status(500).json({ code: 'SERVER_ERROR', error: err.message || 'حصلت مشكلة' });
  }
});

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

app.get('/api/health', (req, res) => {
  res.json({ 
    ok: true, 
    service: 'basetna-server', 
    model: MODEL_NAME, 
    totalKeys: API_KEYS.length, 
    time: new Date().toISOString() 
  });
});

// ============================================================
// 🚀 Vercel
// ============================================================
export default app;

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🖥️ السيرفر شغال على ${PORT}`));
}