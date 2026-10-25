/**
 * Middleware untuk auto-reset SEMUA session variable saat pindah menu
 * Hanya mempertahankan data login dan data master user
 */
module.exports = function (req, res, next) {
    // Skip untuk route statis, login, dan API non-module
    if (req.path.startsWith('/public') || req.path.startsWith('/assets') || req.path === '/favicon.ico' || req.path === '/login' || req.path.includes('/login/process')) {
        return next();
    }

    const pathSegments = req.path.split('/').filter(Boolean);
    const currentModule = pathSegments[0] || null;
    const previousModule = req.session.currentModule;
    const isGet = req.method === 'GET';
    const isMainModulePage = isGet && currentModule && (pathSegments.length === 1 || (pathSegments.length === 2 && pathSegments[1] === 'index'));

    // Hanya reset saat berpindah halaman utama module, bukan endpoint data internal
    if (isMainModulePage && previousModule && currentModule !== previousModule) {
        console.log(`🔄 Pindah menu: ${previousModule} → ${currentModule}`);

        // Daftar session variable yang HARUS DIPERTAHANKAN (whitelist)
        const preservedKeys = ['cookie', 'id', 'logged_in', 'user_id', 'user', 'keyKLP', 'ketUSER', 'nmKLP', 'avatar', 'login_time', 'aksesMenu', 'fiturMap', 'currentModule'];

        // Ambil semua keys yang ada di session
        const allSessionKeys = Object.keys(req.session);

        // Hapus SEMUA session KECUALI yang ada di whitelist
        allSessionKeys.forEach((key) => {
            if (!preservedKeys.includes(key)) {
                console.log(`  🗑️ Menghapus session.${key} = ${typeof req.session[key] === 'object' ? JSON.stringify(req.session[key]).substring(0, 50) + '...' : req.session[key]}`);
                delete req.session[key];
            }
        });

        console.log(`✅ Session dibersihkan untuk module: ${currentModule}`);
        console.log(`📦 Session yang tersisa:`, Object.keys(req.session));
    }

    // Update module aktif hanya saat membuka halaman utama module
    if (isMainModulePage) {
        req.session.currentModule = currentModule;
    }

    next();
};
