/**
 * Helper untuk cek akses menu berdasarkan session
 * Menggunakan nama module dari URL sebagai key akses
 */
function checkAccess(req, action = 'view') {
    // Ambil nama module dari request path, contoh: /otorisasi/index -> otorisasi
    const pathParts = req.path.split('/').filter(Boolean);
    const moduleName = pathParts[0]; // bagian pertama setelah /
    
    // Ambil nama menu dari session aksesMenu (menggunakan module name sebagai key)
    const menuAccess = req.session.aksesMenu;
    
    if (!menuAccess) return false;
    
    // Cari menu yang sesuai dengan module name (exact match)
    const menuKey = Object.keys(menuAccess).find(key => key === moduleName);
    
    if (!menuKey) return false;
    
    return menuAccess[menuKey]?.[action] || false;
}

module.exports = { checkAccess };