const express = require('express');
const path    = require('path');
const QRCode  = require('qrcode');
const pino    = require('pino');
const fs      = require('fs');

const {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const app = express();

// ── CORS ─────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// ── STATE ────────────────────────────────────────
let sock = null;
let qrBase64 = null;
let pairingCode = null;
let connStatus = 'disconnected';
let lastErr = '';

const AUTH_DIR = './auth_session';

// ── LIMPAR SESSÃO ────────────────────────────────
function clearAuthSession() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('🗑️ Sessão limpa');
    }
  } catch (e) {}
}

// ── SOCKET ───────────────────────────────────────
async function startSocket(usePairing = false, phone = '') {
  try {
    if (sock) {
      await sock.logout().catch(() => {});
      sock = null;
    }

    connStatus = 'connecting';
    qrBase64 = null;
    pairingCode = null;

    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: true,
    });

    sock.ev.on('creds.update', saveCreds);

    // 🔑 Pairing code
    if (usePairing) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phone);
          pairingCode = code.match(/.{1,4}/g).join('-');
          connStatus = 'pairing';
          console.log('🔑 Código:', pairingCode);
        } catch (e) {
          lastErr = e.message;
          connStatus = 'error';
        }
      }, 5000);
    }

    sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
      if (qr && !usePairing) {
        qrBase64 = await QRCode.toDataURL(qr);
        connStatus = 'qr';
      }

      if (connection === 'open') {
        connStatus = 'connected';
        console.log('✅ Conectado');
      }

      if (connection === 'close') {
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        sock = null;
        connStatus = 'disconnected';

        console.log('🔴 Desconectado:', code);

        setTimeout(() => startSocket(false, ''), 5000);
      }
    });

  } catch (err) {
    lastErr = err.message;
    connStatus = 'error';
  }
}

// 🔥 AUTO START (ESSA PARTE É O SEGREDO)
setTimeout(() => {
  console.log('🚀 Auto start...');
  startSocket(false, '');
}, 5000);

// ── API ─────────────────────────────────────────
app.get('/api/status', (_, res) => res.json({ status: connStatus, error: lastErr }));

app.get('/api/qrcode', (_, res) => {
  res.json({ qr: qrBase64, pairingCode, status: connStatus, error: lastErr });
});

app.post('/api/connect', (_, res) => {
  startSocket(false, '');
  res.json({ ok: true });
});

app.post('/api/connect-pairing', (req, res) => {
  startSocket(true, req.body.phoneNumber);
  res.json({ ok: true });
});

app.post('/api/clear', (_, res) => {
  clearAuthSession();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Rodando na porta ${PORT}`);
});
