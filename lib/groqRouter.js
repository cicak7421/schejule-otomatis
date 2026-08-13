/**
 * Groq multi-API-key router.
 * Membaca sampai 5 API key dari env (GROQ_API_KEY_1..GROQ_API_KEY_5),
 * lalu mencoba satu per satu kalau ada yang kena rate-limit (429) atau error.
 * Round-robin ringan: key terakhir yang sukses dipakai lagi duluan di request berikutnya,
 * jadi beban natural tersebar tapi tidak asal random.
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

function loadKeys() {
  const keys = [];
  for (let i = 1; i <= 5; i++) {
    const v = process.env[`GROQ_API_KEY_${i}`];
    if (v && v.trim()) keys.push({ label: `KEY_${i}`, value: v.trim() });
  }
  // fallback tunggal kalau cuma isi GROQ_API_KEY biasa
  if (!keys.length && process.env.GROQ_API_KEY) {
    keys.push({ label: 'KEY_1', value: process.env.GROQ_API_KEY.trim() });
  }
  return keys;
}

let cursor = 0;

/**
 * Panggil Groq chat completion dengan failover otomatis antar key.
 * @param {Array} messages - array {role, content} format OpenAI-style
 * @param {Object} opts - { json: boolean, temperature, maxTokens }
 * @returns {Promise<{content: string, keyUsed: string}>}
 */
async function callGroq(messages, opts = {}) {
  const keys = loadKeys();
  if (!keys.length) {
    throw new Error('Tidak ada GROQ_API_KEY yang dikonfigurasi di .env');
  }

  const { json = false, temperature = 0.4, maxTokens = 2000, model = DEFAULT_MODEL } = opts;

  let lastError = null;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const idx = (cursor + attempt) % keys.length;
    const key = keys[idx];
    try {
      const body = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      };
      if (json) body.response_format = { type: 'json_object' };

      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key.value}`,
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429 || res.status === 401 || res.status === 403) {
        // rate limited / invalid key -> coba key berikutnya
        lastError = new Error(`Groq ${key.label} gagal (status ${res.status})`);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        lastError = new Error(`Groq ${key.label} error ${res.status}: ${text.slice(0, 300)}`);
        continue;
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content ?? '';
      cursor = (idx + 1) % keys.length; // key berikutnya jadi prioritas request selanjutnya
      return { content, keyUsed: key.label };
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  throw lastError || new Error('Semua Groq API key gagal dipakai');
}

module.exports = { callGroq, loadKeys };
