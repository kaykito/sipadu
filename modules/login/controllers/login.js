const db = require('../../../database');
const bcrypt = require('bcrypt');
const { buildAksesMenuFiturMap } = require('../../../helpers/akses');

// Helper function to detect device info from user agent
function getDeviceInfo(userAgent, ip) {
    const ua = userAgent.toLowerCase();
    let deviceType = 'laptop';
    let deviceOS = 'Unknown';
    let browser = 'Unknown';
    let deviceName = 'Unknown Device';

    // Detect device type
    if (ua.includes('mobile') || ua.includes('android')) {
        deviceType = 'mobile';
    } else if (ua.includes('tablet') || ua.includes('ipad')) {
        deviceType = 'tablet';
    }

    // Detect OS
    if (ua.includes('windows nt 10')) {
        deviceOS = 'Windows 10/11';
    } else if (ua.includes('windows nt 6.3')) {
        deviceOS = 'Windows 8.1';
    } else if (ua.includes('windows nt 6.2')) {
        deviceOS = 'Windows 8';
    } else if (ua.includes('windows nt 6.1')) {
        deviceOS = 'Windows 7';
    } else if (ua.includes('windows')) {
        deviceOS = 'Windows';
    } else if (ua.includes('mac os x')) {
        const match = ua.match(/mac os x (\d+[._]\d+)/);
        deviceOS = match ? `macOS ${match[1].replace('_', '.')}` : 'macOS';
    } else if (ua.includes('android')) {
        const match = ua.match(/android (\d+(\.\d+)?)/);
        deviceOS = match ? `Android ${match[1]}` : 'Android';
    } else if (ua.includes('iphone') || ua.includes('ipad')) {
        const match = ua.match(/os (\d+[._]\d+)/);
        deviceOS = match ? `iOS ${match[1].replace('_', '.')}` : 'iOS';
    } else if (ua.includes('linux')) {
        deviceOS = 'Linux';
    }

    // Detect browser
    if (ua.includes('edg/')) {
        browser = 'Edge';
    } else if (ua.includes('chrome/') && !ua.includes('edg')) {
        browser = 'Chrome';
    } else if (ua.includes('firefox/')) {
        browser = 'Firefox';
    } else if (ua.includes('safari/') && !ua.includes('chrome')) {
        browser = 'Safari';
    } else if (ua.includes('opera') || ua.includes('opr/')) {
        browser = 'Opera';
    }

    // Generate device name
    if (deviceType === 'mobile') {
        if (ua.includes('samsung')) deviceName = 'Samsung Mobile';
        else if (ua.includes('huawei')) deviceName = 'Huawei Mobile';
        else if (ua.includes('xiaomi')) deviceName = 'Xiaomi Mobile';
        else if (ua.includes('oppo')) deviceName = 'Oppo Mobile';
        else if (ua.includes('vivo')) deviceName = 'Vivo Mobile';
        else if (ua.includes('iphone')) deviceName = 'iPhone';
        else deviceName = 'Mobile Device';
    } else if (deviceType === 'tablet') {
        if (ua.includes('ipad')) deviceName = 'iPad';
        else deviceName = 'Tablet';
    } else {
        deviceName = deviceOS + ' Computer';
    }

    return {
        deviceType,
        deviceOS,
        browser,
        deviceName,
        ipAddress: ip
    };
}

// Helper function to save device login
async function trackDeviceLogin(userId, req) {
    try {
        const userAgent = req.headers['user-agent'] || '';
        const ip = req.ip || req.connection.remoteAddress || '';
        const sessionId = req.sessionID; // Get session ID
        const deviceInfo = getDeviceInfo(userAgent, ip);

        const pool = await db.poolPromise;

        // Check if device already exists
        const existingDevice = await pool.request()
            .input('userID', db.sql.NVarChar, userId)
            .input('deviceName', db.sql.NVarChar, deviceInfo.deviceName)
            .input('deviceOS', db.sql.NVarChar, deviceInfo.deviceOS)
            .input('browser', db.sql.NVarChar, deviceInfo.browser)
            .query(`
                SELECT keyDEVICE FROM USER_DEVICES 
                WHERE userID = @userID 
                  AND deviceName = @deviceName 
                  AND deviceOS = @deviceOS 
                  AND browser = @browser
            `);

        if (existingDevice.recordset.length > 0) {
            // Update existing device
            const keyDEVICE = existingDevice.recordset[0].keyDEVICE;
            await pool.request()
                .input('keyDEVICE', db.sql.Int, keyDEVICE)
                .input('ipAddress', db.sql.NVarChar, deviceInfo.ipAddress)
                .input('sessionID', db.sql.NVarChar, sessionId)
                .query(`
                    UPDATE USER_DEVICES 
                    SET isCurrent = 1, 
                        isActive = 1,
                        lastAccess = GETDATE(),
                        ipAddress = @ipAddress,
                        sessionID = @sessionID
                    WHERE keyDEVICE = @keyDEVICE
                `);
            
            console.log(`✅ Updated existing device ${keyDEVICE} for user ${userId}`);
        } else {
            // Set all other devices as not current
            await pool.request()
                .input('userID', db.sql.NVarChar, userId)
                .query(`UPDATE USER_DEVICES SET isCurrent = 0 WHERE userID = @userID`);

            // Get next keyDEVICE using transaction lock to ensure atomicity
            const insertResult = await pool.request()
                .input('userID', db.sql.NVarChar, userId)
                .input('deviceName', db.sql.NVarChar, deviceInfo.deviceName)
                .input('deviceOS', db.sql.NVarChar, deviceInfo.deviceOS)
                .input('deviceType', db.sql.NVarChar, deviceInfo.deviceType)
                .input('browser', db.sql.NVarChar, deviceInfo.browser)
                .input('ipAddress', db.sql.NVarChar, deviceInfo.ipAddress)
                .input('location', db.sql.NVarChar, 'Indonesia') // Could be enhanced with GeoIP
                .input('sessionID', db.sql.NVarChar, sessionId)
                .query(`
                    INSERT INTO USER_DEVICES 
                    (userID, deviceName, deviceOS, deviceType, browser, ipAddress, location, sessionID, isCurrent, isActive, lastAccess)
                    VALUES 
                    (@userID, @deviceName, @deviceOS, @deviceType, @browser, @ipAddress, @location, @sessionID, 1, 1, GETDATE());
                    SELECT SCOPE_IDENTITY() as keyDEVICE;
                `);
            let keyDEVICE = insertResult && insertResult.recordset && insertResult.recordset[0] ? insertResult.recordset[0].keyDEVICE : null;

            // Fallback: if keyDEVICE is null (table may not use IDENTITY), try to fetch the inserted row
            if (!keyDEVICE) {
                try {
                    const fallback = await pool.request()
                        .input('userID', db.sql.NVarChar, userId)
                        .input('deviceName', db.sql.NVarChar, deviceInfo.deviceName)
                        .input('sessionID', db.sql.NVarChar, sessionId)
                        .query(`
                            SELECT TOP 1 keyDEVICE FROM USER_DEVICES
                            WHERE userID = @userID AND deviceName = @deviceName AND sessionID = @sessionID
                            ORDER BY lastAccess DESC
                        `);
                    if (fallback.recordset.length > 0) {
                        keyDEVICE = fallback.recordset[0].keyDEVICE;
                    }
                } catch (e) {
                    console.warn('Could not determine keyDEVICE after insert:', e && e.message);
                }
            }

            console.log(`✅ Tracked new device ${keyDEVICE || '(unknown)'} for user ${userId}: ${deviceInfo.deviceName}`);
        }

    } catch (err) {
        console.error('Error tracking device login:', err);
    }
}

exports.logout = function (req, res) {
    req.session.destroy(function (err) {
        if (err) console.log(err);
        else res.redirect('/');
    });
};

// === HELPER: Destroy semua session aktif untuk user tertentu ===
async function destroyUserSessions(userId, currentSessionId = null) {
    try {
        const Sessions = db.sequelize.define('Sessions', {
            sid: { type: db.Sequelize.STRING, primaryKey: true },
            expires: db.Sequelize.DATE,
            data: db.Sequelize.TEXT
        }, { tableName: 'Sessions', timestamps: false });

        const now = new Date();
        
        // Cari semua session aktif untuk user ini
        const activeSessions = await Sessions.findAll({
            where: { 
                expires: { [db.Sequelize.Op.gt]: now }
            }
        });

        let destroyedCount = 0;
        
        // Destroy session-session yang bukan current session
        for (const session of activeSessions) {
            try {
                const sessionData = JSON.parse(session.data);
                if (sessionData.logged_in && sessionData.user_id === userId && session.sid !== currentSessionId) {
                    await Sessions.destroy({ where: { sid: session.sid } });
                    destroyedCount++;
                    console.log(`🗑️ Destroyed old session for user ${userId}: ${session.sid}`);
                }
            } catch (e) {
                // Skip invalid session data
                console.log(`⚠️ Skipping invalid session data for ${session.sid}`);
            }
        }
        
        return destroyedCount;
    } catch (err) {
        console.error('Error destroying user sessions:', err);
        return 0;
    }
}

exports.process = async function (req, res) {
    const userInput = req.body.userID;
    const userPassword = req.body.PWD;

    const query = 'SELECT TOP 1 * FROM APPUSER WHERE userID = @userID';
    const param = { name: 'userID', type: db.sql.NVarChar, value: userInput };

    try {
        const pool = await db.poolPromise;
        const userResult = await pool.request().input(param.name, param.type, param.value).query(query);

        const user = userResult.recordset[0];
        if (!user) {
            req.flash('info', 'User atau password salah');
            req.session.logged_in = false;
            return res.redirect('/login?msg=' + encodeURIComponent('User atau password salah'));
        }
        // Check password using bcrypt
        let isPasswordValid = false;
        
        // Cek apakah password di database adalah bcrypt hash
        if (user.PWD.startsWith('$2b$') || user.PWD.startsWith('$2a$')) {
            // Password adalah bcrypt hash, gunakan bcrypt.compare
            isPasswordValid = await bcrypt.compare(userPassword, user.PWD);
        } else {
            // Password adalah plain text (untuk backward compatibility)
            // TODO: hapus fallback ini setelah semua password di APPUSER sudah di-hash bcrypt
            isPasswordValid = (userPassword === user.PWD);
        }
        
        if (isPasswordValid) {
            // === CEK DAN DESTROY SESSION LAMA ===
            const destroyedSessions = await destroyUserSessions(user.userID);
            
            if (destroyedSessions > 0) {
                console.log(`🔄 User ${user.userID} logged in from new location, destroyed ${destroyedSessions} old session(s)`);
            }

            // Set session baru
            req.session.logged_in = true;
            req.session.user_id = user.userID;
            req.session.user = user.nmUSER;
            req.session.keyKLP = user.keyKLP;
            req.session.ketUSER = user.ketUSER;
            req.session.avatar = user.avatar; // Simpan avatar ke session
            req.session.login_time = new Date(); // Track login time

            // Ambil nama kelompok dari tabel KELOMPOK
            const klpResult = await pool.request().input('keyKLP', db.sql.BigInt, user.keyKLP).query('SELECT TOP 1 nmKLP FROM KELOMPOK WHERE keyKLP = @keyKLP');
            req.session.nmKLP = klpResult.recordset[0] ? klpResult.recordset[0].nmKLP : '';

            const { aksesMenu, fiturMap } = await buildAksesMenuFiturMap(user.keyKLP);
            req.session.aksesMenu = aksesMenu;
            req.session.fiturMap = fiturMap;

            // Track device login
            await trackDeviceLogin(user.userID, req);

            // Flash message jika ada session yang didestroy
            if (destroyedSessions > 0) {
                req.flash('info', `Login berhasil. ${destroyedSessions} session sebelumnya telah ditutup.`);
            } else {
                req.flash('success', 'Login berhasil');
            }

            // Pastikan session tersimpan sebelum redirect
            req.session.save((err) => {
                if (err) {
                    console.error('❌ Error saving session:', err);
                    req.flash('info', 'Terjadi kesalahan saat menyimpan session');
                    return res.redirect('/login');
                }
                console.log('✅ Session saved successfully, redirecting to dashboard');
                return res.redirect('/');
            });
        } else {
            req.flash('info', 'User atau password salah');
            req.session.logged_in = false;
            return res.redirect('/login?msg=' + encodeURIComponent('User atau password salah'));
        }
    } catch (err) {
        console.error(err);
        req.flash('info', 'Terjadi kesalahan');
        req.session.logged_in = false;
        return res.redirect('/login?msg=' + encodeURIComponent('Terjadi kesalahan'));
    }
};
