/*
bkash-mock-server.js
A lightweight mock of the bKash Checkout API for local testing (Express.js).

How to use:
1. Save this file as `server.js` in a new folder.
2. Run:
   npm init -y
   npm install express body-parser cors uuid
   node server.js
3. Server runs on http://localhost:4000 by default.

Endpoints implemented (behaves like a simple sandbox mock):
- POST /token/grant
  Request: { app_key, app_secret }
  Response: { id_token, expires_in }

- POST /checkout/payment/create
  Headers: { authorization: <id_token>, x-app-key: <app_key> }
  Body: { amount, currency, intent, merchantInvoiceNumber, callbackURL }
  Response: { paymentID, bkashURL }

- POST /checkout/payment/execute/:paymentID
  Headers: { authorization }
  Body: {}
  Response: { paymentID, status, transactionID }

- GET  /checkout/payment/query/:paymentID
  Headers: { authorization }
  Response: { paymentID, status, transactionID, amount }

- POST /callback (optional) -- simulate bKash calling your callback after user approves

Notes:
- This mock stores payments in memory (process-lifetime). Good for local dev and CI tests.
- It does NOT perform any real money movement. You can adapt the logic to simulate failures, timeouts, or edge cases.
*/

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 4000;

// In-memory stores
const tokens = new Map(); // token -> { app_key, expiresAt }
const payments = new Map(); // paymentID -> payment object

// Helper: create token
function createToken(app_key) {
  const id_token = 'mock_' + uuidv4();
  const ttl = 1000 * 60 * 60; // 1 hour
  tokens.set(id_token, { app_key, expiresAt: Date.now() + ttl });
  return { id_token, expires_in: ttl / 1000 };
}

// Helper: validate token
function validateAuth(req) {
  const auth = req.headers['authorization'];
  const xapp = req.headers['x-app-key'];
  if (!auth) return { ok: false, message: 'missing authorization header' };
  const info = tokens.get(auth);
  if (!info) return { ok: false, message: 'invalid token' };
  if (info.expiresAt < Date.now()) return { ok: false, message: 'token expired' };
  if (xapp && xapp !== info.app_key) return { ok: false, message: 'x-app-key mismatch' };
  return { ok: true, info };
}

// 1) Token grant
app.post('/token/grant', (req, res) => {
  const { app_key, app_secret } = req.body || {};
  // Basic validation - in real world you'd check values.
  if (!app_key || !app_secret) return res.status(400).json({ statusCode: 400, message: 'app_key and app_secret required' });

  const token = createToken(app_key);
  return res.json({ id_token: token.id_token, expires_in: token.expires_in, token_type: 'Bearer' });
});

// 2) Create payment
app.post('/checkout/payment/create', (req, res) => {
  const authCheck = validateAuth(req);
  if (!authCheck.ok) return res.status(401).json({ statusCode: 401, message: authCheck.message });

  const body = req.body || {};
  const { amount, currency = 'BDT', intent = 'sale', merchantInvoiceNumber, callbackURL } = body;
  if (!amount || isNaN(Number(amount))) return res.status(400).json({ statusCode: 400, message: 'invalid amount' });

  const paymentID = 'P_' + uuidv4();
  const bkashURL = `http://localhost:${PORT}/simulate-approve/${paymentID}`; // in real bKash this points to bKash UI

  const payment = {
    paymentID,
    merchantInvoiceNumber: merchantInvoiceNumber || null,
    amount: String(amount),
    currency,
    intent,
    callbackURL: callbackURL || null,
    status: 'created', // created -> approved (if user approves) -> executed -> failed
    createdAt: Date.now(),
    transactionID: null,
  };

  payments.set(paymentID, payment);

  return res.json({ paymentID, bkashURL, status: 'created' });
});

// 3) Simulate user approving payment by visiting bkashURL
// This is a developer convenience endpoint: GET /simulate-approve/:paymentID
app.get('/simulate-approve/:paymentID', (req, res) => {
  const { paymentID } = req.params;
  const p = payments.get(paymentID);
  if (!p) return res.status(404).send('Payment not found');

  // Mark as approved so client can call execute
  p.status = 'approved';
  payments.set(paymentID, p);

  // Optionally, if a callbackURL was set, we POST to it to simulate bKash server callback
  if (p.callbackURL) {
    // fire-and-forget simulated callback
    const axios = require('axios');
    axios.post(p.callbackURL, { paymentID, status: 'approved' }).catch(() => {});
  }

  // Simple HTML for developer to click "Return to Merchant"
  return res.send(`
    <html>
      <body style="font-family: Arial; text-align:center; padding:40px">
        <h2>Mock bKash Payment Approval</h2>
        <p>Payment <strong>${paymentID}</strong> marked <strong>approved</strong>.</p>
        <p>Now call <code>/checkout/payment/execute/${paymentID}</code> from your server to finish the flow.</p>
        <a href="javascript:history.back()">Return</a>
      </body>
    </html>
  `);
});

// 4) Execute payment
app.post('/checkout/payment/execute/:paymentID', (req, res) => {
  const authCheck = validateAuth(req);
  if (!authCheck.ok) return res.status(401).json({ statusCode: 401, message: authCheck.message });

  const { paymentID } = req.params;
  const p = payments.get(paymentID);
  if (!p) return res.status(404).json({ statusCode: 404, message: 'payment not found' });

  if (p.status !== 'approved') return res.status(400).json({ statusCode: 400, message: 'payment not approved by user' });

  // simulate a transaction
  const transactionID = 'T_' + uuidv4();
  p.status = 'executed';
  p.transactionID = transactionID;
  p.executedAt = Date.now();

  payments.set(paymentID, p);

  // Optionally, POST callback to merchant callbackURL to simulate server-to-server notification
  if (p.callbackURL) {
    const axios = require('axios');
    axios.post(p.callbackURL, { paymentID, status: 'executed', transactionID }).catch(() => {});
  }

  return res.json({ paymentID, status: p.status, transactionID });
});

// 5) Query payment status
app.get('/checkout/payment/query/:paymentID', (req, res) => {
  const authCheck = validateAuth(req);
  if (!authCheck.ok) return res.status(401).json({ statusCode: 401, message: authCheck.message });

  const { paymentID } = req.params;
  const p = payments.get(paymentID);
  if (!p) return res.status(404).json({ statusCode: 404, message: 'payment not found' });

  return res.json({ paymentID: p.paymentID, status: p.status, transactionID: p.transactionID, amount: p.amount, merchantInvoiceNumber: p.merchantInvoiceNumber });
});

// Optional webhook-style callback receiver for testing merchant callback handling
app.post('/callback', (req, res) => {
  console.log('Received callback to /callback:', req.body);
  return res.json({ ok: true });
});

// Health
app.get('/', (req, res) => res.send('bKash mock server running'));

app.listen(PORT, () => console.log(`bKash mock server listening on http://localhost:${PORT}`));
