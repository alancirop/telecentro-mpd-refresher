/**
 * Telecentro MPD Refresher
 * Corre en GitHub Actions cada hora — sin servidor, todo en la nube.
 * Loguea en Telecentro API → channelStream para cada canal → guarda MPDs en Firestore
 * 
 * Secrets necesarios en GitHub:
 *   TC_EMAIL, TC_PASSWORD, FIREBASE_API_KEY
 */

const https = require('https');
const { URLSearchParams } = require('url');

const CONFIG = {
  email:       process.env.TC_EMAIL,
  password:    process.env.TC_PASSWORD,
  appId:       '7e1206215a493069e03c4ed792bde12410b84fe5f4c487d34c7a91715b2f1',
  identityKey: 'r0HiwadruqUJ9STaWlpResUDroD4lRO5',
  deviceId:    '2de81025-29fc-406b-97c9-1fc03063b11f',
  baseUrl:     'web-bev.telecentro.net.ar',
  firebaseProjectId: 'tv-familiar',
  firebaseApiKey:    process.env.FIREBASE_API_KEY,
  delayMs:     600,  // ms entre canales para no saturar
};

const CHANNEL_MAP = {
  "TNT Sports Premium": 1191, "TNT Sport": 1193, "ESPN": 1132,
  "ESPN 2": 64, "ESPN 3": 98, "ESPN más": 166,
  "Fox Sports": 28, "Fox Sports 2": 1, "Fox Sports 3": 116,
  "Fox Sports Premium": 1189, "TyC Sports": 4, "TyC Sports SD": 174,
  "DeporTV": 22, "América Sports": 151,
  "TNT": 31, "TNT HD": 177, "TNT Series": 110,
  "HBO": 120, "HBO 2": 121, "HBO Family": 10, "HBO Plus": 71,
  "Cinemax": 62, "Max E": 122, "Max Prime": 123, "Max Up": 73,
  "AXN": 59, "Sony": 58, "Sony Movies": 2114,
  "Fox": 45, "FX": 9, "Universal": 46, "Studio Universal": 180,
  "Warner": 60, "TCM": 145, "Film & Arts": 114, "CineCanal": 40,
  "AMC": 48, "AyE": 61, "Paramount": 16,
  "LN+": 2058, "TN": 137, "C5N": 152,
  "CNN": 103, "CNN Español": 102, "BBC": 107, "DW": 108, "France 24": 2378,
  "Telefe": 50, "Canal 13": 51, "América": 26, "Canal 9": 21,
  "TV Pública": 20, "Crónica": 23, "Canal 26": 24,
  "Disney Channel": 3, "Disney Junior": 65, "Nick": 15, "Nick Jr": 1133,
  "Cartoon Network": 158, "Boomerang": 99, "Discovery Kids": 8,
  "National Geographic": 5, "Discovery": 6, "History": 63,
  "History 2": 93, "Animal Planet": 126,
  "MTV": 136, "VH1": 164, "HTV": 79,
  "Comedy Central": 182, "Space": 30,
  "Gourmet": 19, "El Gourmet": 92,
  "Encuentro": 155, "Pakapaka": 157,
};

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function postForm(path, body, token) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === 'string' ? body : new URLSearchParams(body).toString();
    const headers = {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Accept':        'application/json',
      'Origin':        'https://ver.telecentroplay.com.ar',
      'Referer':       'https://ver.telecentroplay.com.ar/',
      'User-Agent':    'Mozilla/5.0 (Linux; Android 6.0) AppleWebKit/537.36 Chrome/147.0.0.0',
      'X-AN-WebService-AppId':       CONFIG.appId,
      'X-AN-WebService-IdentityKey': CONFIG.identityKey,
      'Content-Length': Buffer.byteLength(bodyStr),
    };
    if (token) headers['X-AN-WebService-CustomerAuthToken'] = token;

    const req = https.request({ hostname: CONFIG.baseUrl, path, method: 'POST', headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

// ─── Firestore REST (sin SDK, solo HTTPS) ─────────────────────────────────────
function firestoreSet(docId, fields) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ fields });
    const path = `/v1/projects/${CONFIG.firebaseProjectId}/databases/(default)/documents/telecentro_mpd/${docId}?key=${CONFIG.firebaseApiKey}`;
    const req = https.request({
      hostname: 'firestore.googleapis.com', path, method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('firestore timeout')); });
    req.write(body);
    req.end();
  });
}

const fsStr  = v => ({ stringValue:  String(v) });
const fsInt  = v => ({ integerValue: String(v) });
const fsBool = v => ({ booleanValue: v });

// ─── Login + CAS ──────────────────────────────────────────────────────────────
async function login() {
  const encPwd   = encodeURIComponent(CONFIG.password).replace(/\*/g, '%2A');
  const encEmail = encodeURIComponent(CONFIG.email);

  const resp = await postForm('/proxy/login', `email=${encEmail}&password=${encPwd}`, null);
  const jwt  = resp?.result?.newAuthToken;
  if (!jwt) throw new Error(`Login falló: ${JSON.stringify(resp).substring(0, 200)}`);
  console.log('✅ Login OK');

  try {
    await postForm('/proxy/casAddDevice', { deviceUniqueId: CONFIG.deviceId }, jwt);
    console.log('✅ casAddDevice OK');
  } catch(e) { console.warn('casAddDevice warn:', e.message); }

  const cas = await postForm('/proxy/casAuth', {
    casDeviceId: CONFIG.deviceId,
    name: 'ANDROID-TV Android/9',
    type: 'device_android_tv',
  }, jwt);
  const jwt2 = cas?.result?.newAuthToken || jwt;
  console.log('✅ CAS OK');
  return jwt2;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀 Telecentro MPD Refresher — ${new Date().toISOString()}`);

  const token = await login();
  const t0 = Date.now();
  let ok = 0, fail = 0, errors = [];

  const entries = Object.entries(CHANNEL_MAP);
  console.log(`\n📡 Procesando ${entries.length} canales...\n`);

  for (const [name, idChannel] of entries) {
    try {
      const resp = await postForm('/proxy/channelStream',
        { idChannel, deviceId: CONFIG.deviceId }, token);

      const raw = resp?.result?.url;
      const err = resp?.error;
      const mpd = raw ? raw.replace('http://', 'https://').replace(':80/', '/') : '';

      await firestoreSet(String(idChannel), {
        mpdUrl:      fsStr(mpd),
        channelName: fsStr(name),
        idChannel:   fsInt(idChannel),
        updatedAt:   fsInt(Date.now()),
        ok:          fsBool(!!mpd),
        errorCode:   fsInt(err?.code || 0),
        errorMsg:    fsStr(err?.message || ''),
      });

      if (mpd) {
        console.log(`  ✅ ${name} (${idChannel})`);
        ok++;
      } else {
        const errInfo = err ? `code=${err.code} ${err.message}` : 'sin URL';
        console.log(`  ❌ ${name} (${idChannel}) — ${errInfo}`);
        fail++;
        errors.push(`${name}: ${errInfo}`);
      }
    } catch(e) {
      console.log(`  ⚠️  ${name} (${idChannel}) — ${e.message}`);
      fail++;
      errors.push(`${name}: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, CONFIG.delayMs));
  }

  // Metadata del último run
  await firestoreSet('_meta', {
    lastRun:   fsStr(new Date().toISOString()),
    okCount:   fsInt(ok),
    failCount: fsInt(fail),
    totalMs:   fsInt(Date.now() - t0),
    errors:    fsStr(errors.slice(0, 10).join(' | ')),
  });

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n📊 Resultado: ${ok} OK, ${fail} errores en ${secs}s`);
  if (errors.length) console.log('Errores:', errors.join(', '));
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
