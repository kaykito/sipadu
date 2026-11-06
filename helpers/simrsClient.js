const https = require('https');
const http = require('http');

// Klien API SIM RS (finpub): ambil token lalu tarik data KasBlud per rentang tanggal.
// Konfigurasi dari .env: SIMRS_API_BASE_URL, SIMRS_CONS_ID, SIMRS_SECRET_KEY.
//
// Koneksi dipaksa IPv4 (family: 4): endpoint dibatasi per IP dan VPN hanya merutekan IPv4,
// sedangkan host juga punya record AAAA yang keluar lewat jalur non-VPN dan selalu dapat 403.

const TIMEOUT_MS = 60000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

let cachedToken = null; // { value, expiresAt }

function getConfig() {
    const baseUrl = (process.env.SIMRS_API_BASE_URL || '').trim();
    const consId = (process.env.SIMRS_CONS_ID || '').trim();
    const secretKey = (process.env.SIMRS_SECRET_KEY || '').trim();
    if (!baseUrl || !consId || !secretKey) {
        throw new Error('Konfigurasi API SIM RS belum lengkap (SIMRS_API_BASE_URL, SIMRS_CONS_ID, SIMRS_SECRET_KEY di .env)');
    }
    return { baseUrl: baseUrl.endsWith('/') ? baseUrl : baseUrl + '/', consId, secretKey };
}

function request(url, headers) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const client = target.protocol === 'http:' ? http : https;
        const req = client.request(target, { method: 'GET', headers: { Accept: 'application/json', ...headers }, family: 4, timeout: TIMEOUT_MS }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('timeout', () => req.destroy(new Error('Timeout menghubungi API SIM RS')));
        req.on('error', reject);
        req.end();
    });
}

function apiError(message, status, body) {
    const err = new Error(message);
    err.status = status;
    err.body = body;
    return err;
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

// Waktu kedaluwarsa dari klaim exp JWT; fallback 1 jam bila tidak terbaca
function tokenExpiry(token) {
    const payload = parseJson(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString('utf8'));
    return payload && payload.exp ? payload.exp * 1000 : Date.now() + 60 * 60 * 1000;
}

async function getToken(forceRefresh = false) {
    if (!forceRefresh && cachedToken && cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
        return cachedToken.value;
    }

    const { baseUrl, consId, secretKey } = getConfig();
    const res = await request(baseUrl + 'Token', { ConsId: consId, SecretKey: secretKey });
    if (res.status === 403 && /Access is denied/i.test(res.body)) {
        throw apiError('Akses ke API SIM RS ditolak (403). Pastikan server terhubung ke VPN / IP sudah di-whitelist.', 403);
    }
    if (res.status !== 200) {
        throw apiError('Gagal mengambil token SIM RS (HTTP ' + res.status + ')', res.status, res.body);
    }

    // Response berupa string JWT, kadang dibungkus tanda kutip JSON
    const raw = res.body.trim();
    const value = raw.startsWith('"') ? parseJson(raw) : raw;
    if (!value || String(value).split('.').length !== 3) {
        throw apiError('Format token SIM RS tidak dikenali', res.status, res.body);
    }

    cachedToken = { value, expiresAt: tokenExpiry(value) };
    return value;
}

// Tarik baris KasBlud (satu baris per rincian rekening) untuk rentang YYYY-MM-DD.
// Mengembalikan { status, endpoint, rows }; "Data Not Found" dianggap rows kosong.
async function getKasBlud(dari, sampai) {
    const { baseUrl } = getConfig();
    const endpoint = 'KasBlud/' + encodeURIComponent(dari) + '/' + encodeURIComponent(sampai);

    let token = await getToken();
    let res = await request(baseUrl + endpoint, { Authorization: 'Bearer ' + token });
    if (res.status === 401) {
        token = await getToken(true);
        res = await request(baseUrl + endpoint, { Authorization: 'Bearer ' + token });
    }

    const json = parseJson(res.body);
    if (res.status === 400 && json && /not found/i.test(json.status || '')) {
        return { status: res.status, endpoint: '/' + endpoint, rows: [] };
    }
    if (res.status === 403 && /Access is denied/i.test(res.body)) {
        throw apiError('Akses ke API SIM RS ditolak (403). Pastikan server terhubung ke VPN / IP sudah di-whitelist.', 403);
    }
    if (res.status !== 200 || !json || !Array.isArray(json.data)) {
        throw apiError('Gagal mengambil data kas SIM RS (HTTP ' + res.status + ')', res.status, json || res.body.slice(0, 500));
    }
    return { status: res.status, endpoint: '/' + endpoint, rows: json.data };
}

module.exports = { getToken, getKasBlud };
