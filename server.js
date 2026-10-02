import PDFDocument from 'pdfkit';
import FormData from 'form-data';
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';

const app = express();

// Keep the raw body so Meta's signature can be verified
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ---- Config (set as environment variables in Vercel) ----
const {
  VERIFY_TOKEN,      // any string you choose, must match the Meta dashboard
  WA_TOKEN,          // permanent WhatsApp access token (System User token)
  PHONE_NUMBER_ID,   // Phone number ID from the API Setup page (not the WABA ID)
  EXTERNAL_API_URL,  // optional: your backend / LLM endpoint 
  APP_SECRET,
  GEMINI_API_KEY,      // optional: your Gemini API key
} = process.env;

// ---- Signature check (skipped if APP_SECRET is not set) ----
function validSignature(req) {
  if (!APP_SECRET) return true;
  const sig = req.get('x-hub-signature-256') || '';
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', APP_SECRET).update(req.rawBody || Buffer.from('')).digest('hex');
  return (
    sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  );
}

// ---- 1. Webhook verification (Meta calls this when you save the webhook) ----
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (VERIFY_TOKEN && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---- 2. Incoming messages ----
// Vercel is serverless: finish ALL work before responding, or the function is frozen.
app.post('/webhook', async (req, res) => {
  if (!validSignature(req)) return res.sendStatus(401);

  let from;
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    if (!message) return res.sendStatus(200); // status update (delivered/read), not a message

    from = message.from;

    if (message.type !== 'text') {
      await sendWhatsAppMessage(from, 'Sorry, I can only read text messages for now.');
      return res.sendStatus(200);
    }

    const text = message.text.body;
    console.log(`Incoming from ${from}: ${text}`);
    if (text.trim().toUpperCase().startsWith('QUOTE')) {
      const fields = parseQuoteMessage(text);
      const pdfBuffer = await generateQuotePDF(fields);
      const mediaId = await uploadPDFToWhatsApp(pdfBuffer);
      await sendWhatsAppDocument(from, mediaId, 'quote.pdf');
      return res.sendStatus(200);
    }
    let replyText;
    try {
      const geminiRes = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
        { contents: [{ parts: [{ text }] }] }
      );
      replyText = geminiRes.data.candidates[0].content.parts[0].text;
    } catch (apiErr) {
      console.error('Gemini call failed:', apiErr.response?.data || apiErr.message);
      replyText = "Couldn't get a response right now, try again!";
    }

    await sendWhatsAppMessage(from, String(replyText).slice(0, 4000));
    return res.sendStatus(200);
  } catch (err) {
    console.error('Error handling incoming message:', err.response?.data || err.message);
    try {
      if (from) await sendWhatsAppMessage(from, 'Sorry, something went wrong. Please try again.');
    } catch (e) {
      console.error('Fallback send failed:', e.response?.data || e.message);
    }
    return res.sendStatus(200); // ack anyway so Meta doesn't retry endlessly
  }
});

// ---- Helper: send a WhatsApp text message ----
async function sendWhatsAppMessage(to, body) {
  return axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body } },
    {
      headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 8000,
    }
  );
}
// Parses "QUOTE\nName: X\nItem: Y..." into an object
function parseQuoteMessage(text) {
  const fields = {};
  text.split('\n').slice(1).forEach(line => {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) fields[key.trim()] = rest.join(':').trim();
  });
  return fields;
}

// Builds a PDF in memory and returns it as a Buffer
function generateQuotePDF(fields) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).text('Quotation', { align: 'center' });
    doc.moveDown(2);
    Object.entries(fields).forEach(([key, value]) => {
      doc.fontSize(12).text(`${key}: ${value}`);
      doc.moveDown(0.5);
    });
    doc.end();
  });
}

// Uploads the PDF buffer to WhatsApp's Media API, returns a media ID
async function uploadPDFToWhatsApp(pdfBuffer) {
  const form = new FormData();
  form.append('file', pdfBuffer, { filename: 'quote.pdf', contentType: 'application/pdf' });
  form.append('messaging_product', 'whatsapp');

  const res = await axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/media`,
    form,
    { headers: { ...form.getHeaders(), Authorization: `Bearer ${WA_TOKEN}` } }
  );
  return res.data.id;
}

// Sends the uploaded PDF as a WhatsApp document message
async function sendWhatsAppDocument(to, mediaId, filename) {
  return axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: { id: mediaId, filename },
    },
    { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
  );
}
// ---- Health check ----
app.get('/', (_req, res) => res.send('WhatsApp bot server is running.'));

// Vercel: export the app. Only listen when running locally (node server.js).
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

export default app;