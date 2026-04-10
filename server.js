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

// ── CORS total ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── State ──────────────────────────────────────────────────────────────────
let sock        = null;
let qrBase64    = null;
let pairingCode = null;
let connStatus  = 'disconnected';
let lastErr     = '';
let contacts    = [];
let messages    = [];
let autoRules   = [];
let logs        = [];
let settings    = { delayMin:5,delayMax:15,safeMode:true,maxPerHour:60,humanSim:true,defaultMsg:'Olá! Em breve retornamos.' };

const AUTH_DIR = path.join(__dirname, 'auth_session');

// ── Helpers ────────────────────────────────────────────────────────────────
const nowTime  = () => new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
const nowFull  = () => new Date().toLocaleString('pt-BR');
const rndDelay = (a,b) => (Math.floor(Math.random()*(b-a+1))+a)*1000;
const toJid    = n => { const c=n.replace(/\D/g,''); return c.includes('@')?c:`${c}@s.whatsapp.net`; };

function clearAuthSession() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive:true, force:true });
      console.log('🗑️  Sessão limpa.');
    }
  } catch(e) { console.error('Erro ao limpar sessão:', e.message); }
}

function handleAutoReply(jid, from, text) {
  for (const r of autoRules) {
    if (!r.active) continue;
    if (text.toLowerCase().includes(r.keyword.toLowerCase())) {
      setTimeout(() => doSend(jid, r.response, from, true), rndDelay(settings.delayMin, settings.delayMax));
      return;
    }
  }
}

async function doSend(jid, text, name, auto=false) {
  if (!sock || connStatus !== 'connected') return false;
  try {
    await sock.sendMessage(jid, { text });
    const number = jid.replace(/@.+/,'');
    const e = { id:Date.now()+Math.random(), contact:name||number, number, text, time:nowTime(), in:false, auto };
    messages.push(e);
    logs.unshift({ id:e.id, contact:name||number, number, text, time:nowFull(), status:'enviado' });
    return true;
  } catch(e) {
    logs.unshift({ id:Date.now(), contact:name||jid, number:jid, text, time:nowFull(), status:'erro: '+e.message });
    return false;
  }
}

// ── stopSocket ────────────────────────────────────────────────────────────
async function stopSocket() {
  try { if (sock) { sock.ev.removeAllListeners(); await sock.logout().catch(()=>{}); sock = null; } } catch(_) {}
  connStatus = 'disconnected'; qrBase64 = null; pairingCode = null;
}

// ── startSocket ────────────────────────────────────────────────────────────
async function startSocket(usePairing=false, phone='') {
  if (sock) await stopSocket();

  connStatus  = 'connecting';
  qrBase64    = null;
  pairingCode = null;
  lastErr     = '';

  console.log(`\n▶ startSocket | pairing=${usePairing} | phone=${phone}`);

  try {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    // Se já está registrado e pediu pairing, limpa e recomeça
    if (usePairing && state.creds.registered) {
      console.log('⚠️  Sessão existente encontrada. Limpando para gerar novo código...');
      clearAuthSession();
      const { state: freshState, saveCreds: freshSave } = await useMultiFileAuthState(AUTH_DIR);
      return _buildSocket(usePairing, phone, version, freshState, freshSave);
    }

    _buildSocket(usePairing, phone, version, state, saveCreds);

  } catch(err) {
    console.error('❌ startSocket error:', err.message);
    lastErr    = err.message;
    connStatus = 'error';
  }
}

function _buildSocket(usePairing, phone, version, state, saveCreds) {
  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: !usePairing,
    browser: ['WA Automação', 'Chrome', '3.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // Pairing code — aguarda 4s depois do socket abrir
  if (usePairing) {
    let tries = 0;
    const ask = () => {
      tries++;
      console.log(`🔑 Pedindo pairing code... tentativa ${tries}`);
      const clean = phone.replace(/\D/g,'');
      sock.requestPairingCode(clean).then(code => {
        pairingCode = code.match(/.{1,4}/g)?.join('-') || code;
        connStatus  = 'pairing';
        console.log(`✅ Código gerado: ${pairingCode}`);
      }).catch(e => {
        console.error(`❌ requestPairingCode falhou (tentativa ${tries}): ${e.message}`);
        lastErr = e.message;
        if (tries < 4) {
          console.log('⏳ Nova tentativa em 6s...');
          setTimeout(ask, 6000);
        } else {
          connStatus = 'error';
          lastErr = 'Não foi possível gerar o código após 4 tentativas. Tente limpar a sessão e reconectar.';
        }
      });
    };
    // Aguarda o socket estabilizar
    setTimeout(ask, 4000);
  }

  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !usePairing) {
      try {
        qrBase64   = await QRCode.toDataURL(qr, { width:300, margin:2 });
        connStatus = 'qr';
        console.log('📷 QR Code gerado.');
      } catch(e) { console.error(e.message); }
    }

    if (connection === 'close') {
      const code      = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(`🔴 Conexão fechada. code=${code} loggedOut=${loggedOut}`);
      connStatus  = 'disconnected';
      qrBase64    = null;
      pairingCode = null;
      sock        = null;
      if (!loggedOut && code !== 401) {
        console.log('♻️  Reconectando em 6s...');
        setTimeout(() => startSocket(usePairing, phone), 6000);
      }
    }

    if (connection === 'open') {
      connStatus  = 'connected';
      qrBase64    = null;
      pairingCode = null;
      lastErr     = '';
      console.log('✅ WhatsApp conectado!');
    }
  });

  sock.ev.on('messages.upsert', ({ messages: msgs, type }) => {
    if (type !== 'notify') return;
    for (const msg of msgs) {
      if (!msg.message || msg.key.fromMe) continue;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      if (!text) continue;
      const jid    = msg.key.remoteJid;
      const number = jid.replace('@s.whatsapp.net','');
      const from   = msg.pushName || number;
      messages.push({ id:Date.now()+Math.random(), contact:from, number, text, time:nowTime(), in:true, auto:false });
      logs.unshift({ id:Date.now(), contact:from, number, text, time:nowFull(), status:'recebido' });
      console.log(`📩 ${from}: ${text}`);
      handleAutoReply(jid, from, text);
    }
  });
}

// ── API ────────────────────────────────────────────────────────────────────
app.get('/api/status', (_, res) => res.json({ status:connStatus, error:lastErr }));

app.get('/api/qrcode', (_, res) => {
  console.log(`📡 POLL → status=${connStatus} | code=${pairingCode||'-'} | err=${lastErr||'-'}`);
  res.json({ qr:qrBase64, pairingCode, status:connStatus, error:lastErr });
});

app.post('/api/connect', (_, res) => {
  if (connStatus === 'connected') return res.json({ ok:true, already:true });
  startSocket(false, '');
  res.json({ ok:true, mode:'qr' });
});

app.post('/api/connect-pairing', (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error:'phoneNumber obrigatório' });
  if (connStatus === 'connected') return res.json({ ok:true, already:true });
  startSocket(true, phoneNumber);
  res.json({ ok:true, mode:'pairing' });
});

app.post('/api/disconnect', async (_, res) => {
  await stopSocket();
  res.json({ ok:true });
});

// Limpa sessão salva e desconecta — resolve travamentos
app.post('/api/clear-session', async (_, res) => {
  console.log('🗑️  Clear session solicitado.');
  await stopSocket();
  clearAuthSession();
  res.json({ ok:true, message:'Sessão limpa. Pode conectar novamente.' });
});

// Debug — mostra estado atual
app.get('/api/debug', (_, res) => {
  res.json({
    status: connStatus,
    pairingCode,
    hasQR: !!qrBase64,
    lastError: lastErr,
    authExists: fs.existsSync(AUTH_DIR),
    contacts: contacts.length,
    messages: messages.length,
    rules: autoRules.length,
  });
});

// Contacts
app.get('/api/contacts',       (_, res)   => res.json(contacts));
app.post('/api/contacts',      (req, res) => { const{name,number}=req.body; if(!name||!number) return res.status(400).json({error:'campos obrigatórios'}); const c={id:Date.now(),name:name.trim(),number:number.replace(/\D/g,''),status:'ativo',tags:[]}; contacts.push(c); res.json(c); });
app.put('/api/contacts/:id',   (req, res) => { contacts=contacts.map(c=>c.id===+req.params.id?{...c,...req.body,id:+req.params.id}:c); res.json({ok:true}); });
app.delete('/api/contacts/:id',(req, res) => { contacts=contacts.filter(c=>c.id!==+req.params.id); res.json({ok:true}); });
app.post('/api/contacts/import',(req,res) => { const{rows}=req.body; if(!Array.isArray(rows)) return res.status(400).json({error:'rows array'}); const imp=rows.filter(r=>r.name&&r.number).map(r=>({id:Date.now()+Math.random(),name:r.name.trim(),number:r.number.replace(/\D/g,''),status:'ativo',tags:[]})); contacts.push(...imp); res.json({imported:imp.length}); });

// Messages
app.get('/api/messages', (_, res) => res.json(messages.slice(-200)));
app.post('/api/send', async (req, res) => { const{number,text,contactName}=req.body; if(!number||!text) return res.status(400).json({error:'campos obrigatórios'}); const ok=await doSend(toJid(number),text,contactName); res.json({ok}); });

// Rules
app.get('/api/rules',      (_, res)   => res.json(autoRules));
app.post('/api/rules',     (req, res) => { const{keyword,response}=req.body; if(!keyword||!response) return res.status(400).json({error:'campos obrigatórios'}); const r={id:Date.now(),keyword:keyword.trim(),response:response.trim(),active:true}; autoRules.push(r); res.json(r); });
app.put('/api/rules/:id',  (req, res) => { autoRules=autoRules.map(r=>r.id===+req.params.id?{...r,...req.body,id:+req.params.id}:r); res.json({ok:true}); });
app.delete('/api/rules/:id',(req,res) => { autoRules=autoRules.filter(r=>r.id!==+req.params.id); res.json({ok:true}); });

// Logs
app.get('/api/logs',    (_, res) => res.json(logs.slice(0,500)));
app.delete('/api/logs', (_, res) => { logs=[]; res.json({ok:true}); });

// Settings
app.get('/api/settings', (_, res) => res.json(settings));
app.put('/api/settings', (req, res) => { settings={...settings,...req.body}; res.json(settings); });

app.get('/health', (_, res) => res.json({ ok:true, status:connStatus }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname,'public','index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 WA Automação v3.2 — porta ${PORT}`);
  console.log(`🔗 Debug: /api/debug\n`);
});
