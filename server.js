import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());
 
// ---- Config (set these as environment variables on Render/your host) ----
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;       // any string you choose, must match Meta dashboard
const WA_TOKEN = process.env.WA_TOKEN;                 // WhatsApp access token (temp or permanent)
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;   // from WhatsApp API Setup page
const EXTERNAL_API_URL = process.env.EXTERNAL_API_URL; // the API you want to call, e.g. an LLM or custom backend
 
// ---- 1. Webhook verification (Meta calls this once, on save) ----
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
 
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});
 
// ---- 2. Incoming messages (Meta POSTs here whenever a user messages you) ----
app.post('/webhook', async (req, res) => {
  // Always ack immediately - Meta retries aggressively if you're slow or error out
  res.sendStatus(200);
 
  try {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];
 
    if (!message) return; // could be a status update (delivered/read), not a real message
 
    const from = message.from;             // sender's WhatsApp number
    const text = message.text?.body;       // message text (undefined if it's an image/audio/etc.)
 
    console.log(`Incoming from ${from}: ${text}`);
 
    if (!text) return; // skip non-text messages for now
 
    // ---- Call your external API ----
    let replyText = "Sorry, I couldn't process that.";
    if (EXTERNAL_API_URL) {
      const apiRes = await axios.post(EXTERNAL_API_URL, { message: text, from });
      replyText = apiRes.data.reply || apiRes.data.result || JSON.stringify(apiRes.data);
    } else {
      replyText = `Echo: ${text}`; // fallback if no external API configured yet
    }
 
    await sendWhatsAppMessage(from, replyText);
  } catch (err) {
    console.error('Error handling incoming message:', err.response?.data || err.message);
  }
});
 
// ---- Helper: send a WhatsApp text message ----
async function sendWhatsAppMessage(to, body) {
  return axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    },
    {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
}
 
// ---- Health check (handy for confirming the deploy is alive) ----
app.get('/', (req, res) => res.send('WhatsApp bot server is running.'));
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
 