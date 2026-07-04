/* ============================================================
   auth.js — 本番モード（Cloudflare Workers + D1 + AWS SES）
   ============================================================
   設定: WORKER_URL を実際の Worker URL に変更してください
   ============================================================ */

// ── 設定 ──────────────────────────────────────────────────
const WORKER_URL = 'https://tamjump-member-api.animalb001.workers.dev';

const SQUARE_PAYMENT_LINK = 'https://square.link/u/w9nRYlU1';

// ── セッション管理（localStorage にトークンを保持） ──────
const SESSION_KEY = 'tamj_session';
const USER_KEY    = 'tamj_user';

function _getToken()            { return localStorage.getItem(SESSION_KEY); }
function _setToken(token)       { localStorage.setItem(SESSION_KEY, token); }
function _clearToken()          { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(USER_KEY); }
function _getCachedUser()       { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } }
function _setCachedUser(user)   { localStorage.setItem(USER_KEY, JSON.stringify(user)); }

// ── Worker API ヘルパー ──────────────────────────────────
async function _apiCall(path, options = {}) {
    const token = _getToken();
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch(WORKER_URL + path, {
        ...options,
        headers,
        credentials: 'include',
    });
    return res;
}

// ── State ──
let _currentUser = null;

// ══════════════════════════════════════════════════════════
// Public API（既存ページと完全互換）
// ══════════════════════════════════════════════════════════

// 認証状態を確認してコールバックを呼ぶ
function onAuthReady(callback) {
    const token = _getToken();
    if (!token) {
        _currentUser = null;
        callback(null);
        return;
    }
    // キャッシュがあればすぐに返す（UX向上）
    const cached = _getCachedUser();
    if (cached) {
        _currentUser = cached;
        callback(cached);
    }
    // バックグラウンドでサーバー確認
    _apiCall('/api/auth/me').then(async res => {
        if (res.ok) {
            const data = await res.json();
            const user = {
                email:       data.user.email,
                displayName: data.user.name,
                uid:         'cf_' + data.user.id,
                plan:        data.user.plan,
            };
            _currentUser = user;
            _setCachedUser(user);
            // プラン同期
            setPlan(user.plan === 'paid' ? 'pro' : 'free');
            if (!cached) callback(user);
        } else {
            // セッション切れ
            _clearToken();
            _currentUser = null;
            if (cached) callback(null);
        }
    }).catch(() => {
        // ネットワークエラー時はキャッシュを信頼
        if (!cached) callback(null);
    });
}

// 会員登録
async function registerUser(email, password, displayName, turnstileToken) {
    try {
        const res = await _apiCall('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({ email: email.trim().toLowerCase(), password, name: displayName || email.split('@')[0], turnstileToken }),
        });
        const data = await res.json();
        if (res.ok) {
            return { ok: true };
        }
        return { ok: false, error: data.error || '登録に失敗しました。' };
    } catch (e) {
        return { ok: false, error: 'ネットワークエラーが発生しました。' };
    }
}

// ログイン
async function loginUser(email, password) {
    try {
        const res = await _apiCall('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
        });
        const data = await res.json();
        if (res.ok) {
            // セッション保存
            const user = {
                email:       data.user.email,
                displayName: data.user.name,
                uid:         'cf_' + data.user.id,
                plan:        data.user.plan,
            };
            if (data.session_id) _setToken(data.session_id);
            _setCachedUser(user);
            _currentUser = user;
            setPlan(user.plan === 'paid' ? 'pro' : 'free');
            return { ok: true, user };
        }
        if (data.code === 'EMAIL_NOT_VERIFIED') {
            return { ok: false, error: 'メールアドレスが確認されていません。登録時に送ったメールを確認してください。' };
        }
        return { ok: false, error: data.error || 'メールアドレスまたはパスワードが正しくありません。' };
    } catch (e) {
        return { ok: false, error: 'ネットワークエラーが発生しました。' };
    }
}

// ログアウト
async function logoutUser() {
    try {
        await _apiCall('/api/auth/logout', { method: 'POST' });
    } catch {}
    _clearToken();
    _currentUser = null;
    localStorage.removeItem('tamj_plan');
    localStorage.removeItem('tamj_tickets');
    location.href = getRelativePath('login.html');
}

// パスワードリセット（Worker に実装後に有効化。今はメッセージのみ）
async function resetPassword(email) {
    return { ok: true };
}

// 認証必須ページ用ガード
function requireAuth() {
    onAuthReady(user => {
        if (!user) {
            const returnUrl = encodeURIComponent(location.pathname + location.search);
            location.href = getRelativePath('login.html') + '?return=' + returnUrl;
        } else {
            document.body.classList.add('auth-ready');
            updateAuthUI(user);
        }
    });
}

// ── 決済（Square） ──────────────────────────────────────
function startPayment(toolId) {
    const tickets = getTickets();
    if (tickets[toolId] && tickets[toolId] > Date.now()) return true;

    if (!SQUARE_PAYMENT_LINK || SQUARE_PAYMENT_LINK === '#') {
        alert('決済リンクは準備中です。しばらくお待ちください。');
        return false;
    }
    const paymentUrl = SQUARE_PAYMENT_LINK
        + '?email=' + encodeURIComponent(_currentUser?.email || '')
        + '&reference_id=' + encodeURIComponent(_currentUser?.uid || 'anonymous');
    location.href = paymentUrl;
    return false;
}

function handlePaymentSuccess() {
    const params = new URLSearchParams(location.search);
    const toolId = params.get('paid');
    if (toolId) {
        const tickets = getTickets();
        tickets[toolId] = Date.now() + (24 * 60 * 60 * 1000);
        localStorage.setItem('tamj_tickets', JSON.stringify(tickets));
        history.replaceState(null, '', location.pathname);
        return true;
    }
    return false;
}

function getTickets() {
    try { return JSON.parse(localStorage.getItem('tamj_tickets') || '{}'); } catch { return {}; }
}

function hasValidTicket(toolId) {
    if (isPro()) return true;
    const tickets = getTickets();
    return tickets[toolId] && tickets[toolId] > Date.now();
}

// ── プラン管理 ────────────────────────────────────────────
function getPlan() {
    try {
        const raw = localStorage.getItem('tamj_plan');
        if (!raw) return 'free';
        try { const d = JSON.parse(raw); if (d && d.plan) return 'pro'; } catch {}
        if (raw === 'pro') return 'pro';
        return 'free';
    } catch { return 'free'; }
}
function setPlan(plan) { localStorage.setItem('tamj_plan', plan); }
function isPro()       { return getPlan() === 'pro'; }

// ── 月次利用カウント ─────────────────────────────────────
function _usageKey() {
    const d   = new Date();
    const uid = (_currentUser?.email || 'anon').replace(/[^a-z0-9]/g, '_');
    return 'tamj_usage_' + uid + '_' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function getUsageCount()  { try { return parseInt(localStorage.getItem(_usageKey()) || '0', 10); } catch { return 0; } }
function incrementUsage() { const c = getUsageCount() + 1; localStorage.setItem(_usageKey(), String(c)); return c; }
function getRemainingUses() { if (isPro()) return Infinity; return Math.max(0, 3 - getUsageCount()); }
function canUseService()    { if (isPro()) return true; return getUsageCount() < 3; }

// ── UI更新 ────────────────────────────────────────────────
function updateAuthUI(user) {
    document.querySelectorAll('[data-auth]').forEach(el => {
        const when = el.dataset.auth;
        el.style.display =
            (when === 'logged-in'  && user)  ? '' :
            (when === 'logged-out' && !user) ? '' : 'none';
    });
    document.querySelectorAll('[data-user-name]').forEach(el => {
        el.textContent = user?.displayName || user?.email?.split('@')[0] || '';
    });
}

// ── ユーティリティ ────────────────────────────────────────
function getRelativePath(file) {
    return location.pathname.includes('/members/') ? '../' + file : file;
}

document.addEventListener('DOMContentLoaded', () => { handlePaymentSuccess(); });
