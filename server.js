const express = require('express');
const path    = require('path');
const QRCode  = require('qrcode');
const pino    = require('pino');
 
const {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
 
const app = express();
 
// ── CORS — permite qualquer origem (Netlify, Railway, localhost) ──────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') { res.sendStatus(200); return; }
  next();
});
 
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
 
// ── State ──────────────────────────────────────────────────────────────────
let sock         = null;
let qrBase64     = null;
let pairingCode  = null;
let connStatus   = 'disconnected';
let contacts     = [];
let messages     = [];
let autoRules    = [];
let logs         = [];
let reconnMode   = false;
let reconnPhone  = '';
let settings     = {
  delayMin:5, delayMax:15, safeMode:true,
  maxPerHour:60, humanSim:true,
  defaultMsg:'Olá! Em breve retornamos.',
};
 
// ── Helpers ────────────────────────────────────────────────────────────────
const nowTime  = () => new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
const nowFull  = () => new Date().toLocaleString('pt-BR');
const rndDelay = (a,b) => (Math.floor(Math.random()*(b-a+1))+a)*1000;
const toJid    = n => { const c=n.replace(/\D/g,''); return c.includes('@')?c:`${c}@s.whatsapp.net`; };
 
function handleAutoReply(jid, from, text) {
  for (const r of autoRules) {
    if (!r.active) continue;
    if (text.toLowerCase().includes(r.keyword.toLowerCase())) {
      setTimeout(() => doSend(jid, r.response, from, true),
        rndDelay(settings.delayMin, settings.delayMax));
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
  } catch(err) {
    logs.unshift({ id:Date.now(), contact:name||jid, number:jid, text, time:nowFull(), status:'erro: '+err.message });
    return false;
  }
}
 
// ── WhatsApp socket ────────────────────────────────────────────────────────
async function startSocket(usePairing=false, phone='') {
  if (connStatus === 'connected') return;
 
  reconnMode  = usePairing;
  reconnPhone = phone;
  connStatus  = 'connecting';
  qrBase64    = null;
  pairingCode = null;
 
  console.log(`\n🔄 Iniciando socket... modo: ${usePairing?'pairing code':'QR Code'}`);
  if (usePairing) console.log(`📱 Número: ${phone}`);
 
  try {
    const { version } = await fetchLatestBaileysVersion();
    console.log(`✅ Baileys versão: ${version.join('.')}`);
 
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
 
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
 
    // ── Solicitar pairing code após socket abrir ──
    if (usePairing && !state.creds.registered) {
      let attempts = 0;
      const tryCode = async () => {
        attempts++;
        console.log(`🔑 Tentativa ${attempts} de gerar código de vinculação...`);
        try {
          const clean = phone.replace(/\D/g,'');
          if (!clean || clean.length < 10) {
            console.error('❌ Número inválido:', clean);
            connStatus = 'disconnected';
            return;
          }
          const code = await sock.requestPairingCode(clean);
          pairingCode = code.match(/.{1,4}/g)?.join('-') || code;
          connStatus  = 'pairing';
          console.log(`\n╔═══════════════════════════════╗`);
          console.log(`║  🔑 CÓDIGO: ${pairingCode.padEnd(19)}║`);
          console.log(`╚═══════════════════════════════╝\n`);
        } catch (e) {
          console.error(`❌ Erro na tentativa ${attempts}:`, e.message);
          if (attempts < 3) {
            console.log(`⏳ Tentando novamente em 5s...`);
            setTimeout(tryCode, 5000);
          } else {
            console.error('❌ Falhou após 3 tentativas. Tente novamente.');
            pairingCode = null;
            connStatus  = 'disconnected';
          }
        }
      };
      // Aguarda 5s para o socket se estabilizar
      setTimeout(tryCode, 5000);
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
        console.log(`🔴 Conexão encerrada. Código: ${code} | LoggedOut: ${loggedOut}`);
        connStatus  = 'disconnected';
        qrBase64    = null;
        pairingCode = null;
        sock        = null;
        if (!loggedOut) {
          console.log('♻️  Reconectando em 5s...');
          setTimeout(() => startSocket(reconnMode, reconnPhone), 5000);
        }
      }
 
      if (connection === 'open') {
        connStatus  = 'connected';
        qrBase64    = null;
        pairingCode = null;
        console.log('✅ WhatsApp conectado com sucesso!');
      }
    });
 
    // Mensagens recebidas
    sock.ev.on('messages.upsert', ({ messages: msgs, type }) => {
      if (type !== 'notify') return;
      for (const msg of msgs) {
        if (!msg.message || msg.key.fromMe) continue;
        const text = msg.message.conversation
          || msg.message.extendedTextMessage?.text || '';
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
 
  } catch(err) {
    console.error('❌ Erro ao iniciar socket:', err.message);
    connStatus = 'disconnected';
  }
}
 
// ── API ────────────────────────────────────────────────────────────────────
 
// Status
app.get('/api/status', (_, res) => {
  res.json({ status: connStatus });
});
 
// QR + Pairing code polling
app.get('/api/qrcode', (_, res) => {
  console.log(`📡 Poll: status=${connStatus} | pairingCode=${pairingCode||'null'} | qr=${qrBase64?'sim':'não'}`);
  res.json({ qr: qrBase64, pairingCode, status: connStatus });
});
 
// Conectar via QR Code
app.post('/api/connect', (_, res) => {
  if (connStatus === 'connected') return res.json({ ok:true, already:true });
  startSocket(false, '');
  res.json({ ok:true, mode:'qr' });
});
 
// Conectar via Código de Vinculação
app.post('/api/connect-pairing', (req, res) => {
  const { phoneNumber } = req.body;
  console.log(`📱 Pedido de pairing code para: ${phoneNumber}`);
  if (!phoneNumber) return res.status(400).json({ error:'phoneNumber obrigatório' });
  if (connStatus === 'connected') return res.json({ ok:true, already:true });
  startSocket(true, phoneNumber);
  res.json({ ok:true, mode:'pairing', message:'Código sendo gerado, aguarde até 10s' });
});
 
// Desconectar
app.post('/api/disconnect', async (_, res) => {
  try { if (sock) { await sock.logout(); sock = null; } } catch(_) {}
  connStatus = 'disconnected'; qrBase64 = null; pairingCode = null;
  res.json({ ok:true });
});
 
// ── Contacts ──
app.get('/api/contacts',      (_, res)    => res.json(contacts));
app.post('/api/contacts',     (req, res)  => {
  const { name, number } = req.body;
  if (!name||!number) return res.status(400).json({error:'campos obrigatórios'});
  const c = { id:Date.now(), name:name.trim(), number:number.replace(/\D/g,''), status:'ativo', tags:[] };
  contacts.push(c); res.json(c);
});
app.put('/api/contacts/:id',  (req, res)  => {
  contacts = contacts.map(c => c.id===+req.params.id ? {...c,...req.body,id:+req.params.id} : c);
  res.json({ok:true});
});
app.delete('/api/contacts/:id',(req, res) => {
  contacts = contacts.filter(c => c.id!==+req.params.id); res.json({ok:true});
});
app.post('/api/contacts/import',(req,res) => {
  const{rows}=req.body;
  if(!Array.isArray(rows)) return res.status(400).json({error:'rows array'});
  const imp = rows.filter(r=>r.name&&r.number).map(r=>({
    id:Date.now()+Math.random(), name:r.name.trim(),
    number:r.number.replace(/\D/g,''), status:'ativo', tags:[],
  }));
  contacts.push(...imp); res.json({imported:imp.length});
});
 
// ── Messages ──
app.get('/api/messages', (_, res) => res.json(messages.slice(-200)));
app.post('/api/send', async (req, res) => {
  const{number,text,contactName}=req.body;
  if(!number||!text) return res.status(400).json({error:'campos obrigatórios'});
  const ok = await doSend(toJid(number), text, contactName);
  res.json({ok});
});
 
// ── Rules ──
app.get('/api/rules',      (_, res)   => res.json(autoRules));
app.post('/api/rules',     (req, res) => {
  const{keyword,response}=req.body;
  if(!keyword||!response) return res.status(400).json({error:'campos obrigatórios'});
  const r={id:Date.now(),keyword:keyword.trim(),response:response.trim(),active:true};
  autoRules.push(r); res.json(r);
});
app.put('/api/rules/:id',  (req, res) => {
  autoRules=autoRules.map(r=>r.id===+req.params.id?{...r,...req.body,id:+req.params.id}:r);
  res.json({ok:true});
});
app.delete('/api/rules/:id',(req,res) => {
  autoRules=autoRules.filter(r=>r.id!==+req.params.id); res.json({ok:true});
});
 
// ── Logs ──
app.get('/api/logs',    (_, res) => res.json(logs.slice(0,500)));
app.delete('/api/logs', (_, res) => { logs=[]; res.json({ok:true}); });
 
// ── Settings ──
app.get('/api/settings', (_, res)    => res.json(settings));
app.put('/api/settings', (req, res)  => { settings={...settings,...req.body}; res.json(settings); });
 
// ── Health check ──
app.get('/health', (_, res) => res.json({ ok:true, status:connStatus, contacts:contacts.length }));
 
// SPA fallback
app.get('*', (_, res) => res.sendFile(path.join(__dirname,'public','index.html')));
 
// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n╔═══════════════════════════════════════╗`);
  console.log(`║  🚀 WA Automação v3.1 — CORS Fixado   ║`);
  console.log(`║  Porta: ${String(PORT).padEnd(30)} ║`);
  console.log(`╚═══════════════════════════════════════╝\n`);
  console.log('Rotas disponíveis:');
  console.log('  GET  /api/status           → status atual');
  console.log('  GET  /api/qrcode           → QR / pairing code');
  console.log('  POST /api/connect          → QR Code');
  console.log('  POST /api/connect-pairing  → Código de 8 dígitos\n');
});
