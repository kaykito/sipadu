const db = require('../../../database');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const AVATAR_DIR = path.join(__dirname, '../../../public/uploads/avatars');

// Configure multer for avatar upload
const avatarStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Create directory if it doesn't exist
        if (!fs.existsSync(AVATAR_DIR)) {
            fs.mkdirSync(AVATAR_DIR, { recursive: true });
        }
        cb(null, AVATAR_DIR);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname).toLowerCase();
        const basename = 'avatar-' + req.session.user_id + '-' + Date.now();
        cb(null, basename + ext);
    }
});

const avatarFilter = function (req, file, cb) {
    const allowedTypes = /^\.(png|jpg|jpeg|gif)$/i;
    const ext = path.extname(file.originalname).toLowerCase();
    const mimeType = file.mimetype;

    if (allowedTypes.test(ext) && /image\/(png|jpg|jpeg|gif)/i.test(mimeType)) {
        cb(null, true);
    } else {
        cb(new Error('Hanya file gambar PNG, JPG, JPEG, atau GIF yang diperbolehkan!'), false);
    }
};

const uploadAvatar = multer({
    storage: avatarStorage,
    fileFilter: avatarFilter,
    limits: { fileSize: 800 * 1024 } // 800KB
});

// Hapus file avatar lama (hanya nama file, tanpa path dari luar folder avatar)
function removeAvatarFile(fileName) {
    if (!fileName) return;
    const filePath = path.join(AVATAR_DIR, path.basename(fileName));
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

// Tampilkan profil user yang sedang login
exports.index = async function (req, res) {
    try {
        const userId = req.session.user_id;
        if (!userId) {
            return res.redirect('/login');
        }

        const pool = await db.poolPromise;
        const result = await pool.request()
            .input('userID', db.sql.NVarChar, userId)
            .query(`SELECT u.keyUSER, u.userID, u.nmUSER, u.ketUSER, u.avatar, u.statusUSER, u.keyKLP, k.nmKLP, k.ketKLP
                    FROM APPUSER u
                    LEFT JOIN KELOMPOK k ON u.keyKLP = k.keyKLP
                    WHERE u.userID = @userID`);

        if (result.recordset.length === 0) {
            return res.status(404).send('User tidak ditemukan');
        }

        // Perangkat yang pernah dipakai login (lihat trackDeviceLogin di modul login)
        const devicesResult = await pool.request()
            .input('userID', db.sql.NVarChar, userId)
            .query(`
                SELECT keyDEVICE, deviceName, deviceOS, deviceType, browser, ipAddress, location, sessionID, isActive, lastAccess
                FROM USER_DEVICES
                WHERE userID = @userID
                ORDER BY lastAccess DESC
            `);

        const vars = {
            title: 'Profil Saya',
            subtitle: 'Informasi Profil',
            module: 'userProfile',
            user: result.recordset[0],
            devices: devicesResult.recordset,
            currentSessionId: req.sessionID,
        };

        const viewPath = 'userProfile/views/vw_data.html';
        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            res.render(viewPath, vars);
        } else {
            vars.content = viewPath;
            res.render('index', vars);
        }
    } catch (err) {
        console.error('Error in userProfile.index:', err);
        res.status(500).send('Error: ' + err.message);
    }
};

// Change password
exports.changePassword = async function (req, res) {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const userId = req.session.user_id;

    if (!userId) {
        return res.json({ success: false, message: 'Sesi login tidak ditemukan.' });
    }

    if (!currentPassword || !newPassword || !confirmPassword) {
        return res.json({ success: false, message: 'Semua field wajib diisi.' });
    }

    if (newPassword !== confirmPassword) {
        return res.json({ success: false, message: 'Konfirmasi password baru tidak cocok.' });
    }

    if (newPassword.length < 6) {
        return res.json({ success: false, message: 'Password baru minimal 6 karakter.' });
    }

    try {
        const pool = await db.poolPromise;
        const userResult = await pool.request()
            .input('userID', db.sql.NVarChar, userId)
            .query('SELECT keyUSER, PWD FROM APPUSER WHERE userID = @userID');

        if (userResult.recordset.length === 0) {
            return res.json({ success: false, message: 'User tidak ditemukan.' });
        }

        const storedPWD = userResult.recordset[0].PWD;
        let isPasswordValid = false;

        if (storedPWD.startsWith('$2b$') || storedPWD.startsWith('$2a$')) {
            isPasswordValid = await bcrypt.compare(currentPassword, storedPWD);
        } else {
            // Password lama masih plain text (lihat fallback yang sama di modul login)
            isPasswordValid = (currentPassword === storedPWD);
        }

        if (!isPasswordValid) {
            return res.json({ success: false, message: 'Password saat ini salah.' });
        }

        const hashedPWD = await bcrypt.hash(newPassword, 10);
        await pool.request()
            .input('keyUSER', db.sql.BigInt, userResult.recordset[0].keyUSER)
            .input('PWD', db.sql.NVarChar, hashedPWD)
            .query('UPDATE APPUSER SET PWD = @PWD WHERE keyUSER = @keyUSER');

        res.json({ success: true, message: 'Password berhasil diubah.' });
    } catch (err) {
        console.error('Error in changePassword:', err);
        res.json({ success: false, message: err.message });
    }
};

// Update user profile
exports.update = async function (req, res) {
    const data = req.body;
    const userId = req.session.user_id;

    if (!userId) {
        return res.json({ success: false, message: 'Sesi login tidak ditemukan.' });
    }

    const nmUSER = (data.nmUSER || '').trim();
    if (!nmUSER) {
        return res.json({ success: false, message: 'Nama wajib diisi.' });
    }

    try {
        const pool = await db.poolPromise;
        await pool.request()
            .input('userID', db.sql.NVarChar, userId)
            .input('nmUSER', db.sql.NVarChar, nmUSER)
            .input('ketUSER', db.sql.NVarChar, data.ketUSER || null)
            .query('UPDATE APPUSER SET nmUSER = @nmUSER, ketUSER = @ketUSER WHERE userID = @userID');

        req.session.user = nmUSER;
        res.json({ success: true, message: 'Profil berhasil diperbarui.' });
    } catch (err) {
        console.error('Error in update:', err);
        res.json({ success: false, message: err.message });
    }
};

// Upload avatar
exports.uploadAvatar = function (req, res) {
    uploadAvatar.single('avatar')(req, res, async function (err) {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.json({ success: false, message: 'Ukuran file terlalu besar. Maksimal 800KB.' });
            }
            return res.json({ success: false, message: 'Error upload: ' + err.message });
        } else if (err) {
            return res.json({ success: false, message: err.message });
        }

        if (!req.file) {
            return res.json({ success: false, message: 'Tidak ada file yang diupload.' });
        }

        const userId = req.session.user_id;
        if (!userId) {
            return res.json({ success: false, message: 'Sesi login tidak ditemukan.' });
        }

        try {
            const pool = await db.poolPromise;
            const fileName = req.file.filename;

            const userResult = await pool.request()
                .input('userID', db.sql.NVarChar, userId)
                .query('SELECT keyUSER, avatar FROM APPUSER WHERE userID = @userID');

            if (userResult.recordset.length === 0) {
                return res.json({ success: false, message: 'User tidak ditemukan.' });
            }

            const { keyUSER, avatar: oldAvatar } = userResult.recordset[0];

            await pool.request()
                .input('keyUSER', db.sql.BigInt, keyUSER)
                .input('avatar', db.sql.NVarChar, fileName)
                .query('UPDATE APPUSER SET avatar = @avatar WHERE keyUSER = @keyUSER');

            removeAvatarFile(oldAvatar);
            req.session.avatar = fileName;

            res.json({
                success: true,
                message: 'Avatar berhasil diupload.',
                filename: fileName,
                url: '/uploads/avatars/' + fileName
            });
        } catch (err) {
            console.error('Error in uploadAvatar:', err);
            res.json({ success: false, message: err.message });
        }
    });
};

// Reset avatar to default
exports.resetAvatar = async function (req, res) {
    const userId = req.session.user_id;

    if (!userId) {
        return res.json({ success: false, message: 'Sesi login tidak ditemukan.' });
    }

    try {
        const pool = await db.poolPromise;

        const userResult = await pool.request()
            .input('userID', db.sql.NVarChar, userId)
            .query('SELECT keyUSER, avatar FROM APPUSER WHERE userID = @userID');

        if (userResult.recordset.length === 0) {
            return res.json({ success: false, message: 'User tidak ditemukan.' });
        }

        const { keyUSER, avatar: oldAvatar } = userResult.recordset[0];

        await pool.request()
            .input('keyUSER', db.sql.BigInt, keyUSER)
            .query('UPDATE APPUSER SET avatar = NULL WHERE keyUSER = @keyUSER');

        removeAvatarFile(oldAvatar);
        req.session.avatar = null;

        res.json({ success: true, message: 'Avatar berhasil direset.' });
    } catch (err) {
        console.error('Error in resetAvatar:', err);
        res.json({ success: false, message: err.message });
    }
};

// Logout from device
exports.logoutDevice = async function(req, res) {
    try {
        const userId = req.session.user_id;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        let { keyDEVICE } = req.body;

        // Validate keyDEVICE
        if (keyDEVICE === undefined || keyDEVICE === null) {
            return res.status(400).json({ success: false, message: 'keyDEVICE is required' });
        }

        keyDEVICE = parseInt(keyDEVICE, 10);
        if (!Number.isInteger(keyDEVICE) || keyDEVICE <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid keyDEVICE value' });
        }

        const pool = await db.poolPromise;

        // Get device info including sessionID
        const deviceResult = await pool.request()
            .input('keyDEVICE', db.sql.Int, keyDEVICE)
            .input('userID', db.sql.NVarChar, userId)
            .query(`
                SELECT sessionID
                FROM USER_DEVICES
                WHERE keyDEVICE = @keyDEVICE AND userID = @userID
            `);

        if (deviceResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Perangkat tidak ditemukan' });
        }

        const sessionId = deviceResult.recordset[0].sessionID;

        // Update device status
        await pool.request()
            .input('keyDEVICE', db.sql.Int, keyDEVICE)
            .input('userID', db.sql.NVarChar, userId)
            .query(`
                UPDATE USER_DEVICES
                SET isActive = 0, sessionID = NULL
                WHERE keyDEVICE = @keyDEVICE AND userID = @userID
            `);

        // Destroy session if exists
        if (sessionId) {
            try {
                // Delete directly from Sessions table using SQL query
                await pool.request()
                    .input('sid', db.sql.NVarChar, sessionId)
                    .query(`DELETE FROM Sessions WHERE sid = @sid`);

                console.log(`🗑️ Destroyed session ${sessionId} for device ${keyDEVICE}`);
            } catch (sessionError) {
                console.error('Error destroying session:', sessionError);
                // Continue even if session destruction fails
            }
        }

        res.json({
            success: true,
            message: 'Perangkat berhasil dikeluarkan dan session dihapus'
        });

    } catch (error) {
        console.error('Error logging out device:', error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan sistem' });
    }
};

module.exports = exports;
