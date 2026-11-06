const sql = require('mssql');
const { Sequelize } = require('sequelize');

// Load environment variables
require('dotenv').config();

const config = {
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    server: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 1433,
    database: process.env.DB_NAME || '',
    options: {
        encrypt: false,
        trustServerCertificate: true,
    },
    pool: {
        max: 1,
        min: 0,
        idleTimeoutMillis: 30000,
    },
    connectionTimeout: 30000,
    requestTimeout: 30000,
};

const poolPromise = sql.connect(config);

// Instance Sequelize hanya untuk session store (tabel Sessions).
// Default ke database yang sama dengan DB_* karena login & userProfile juga
// membaca/menghapus tabel Sessions lewat koneksi mssql di atas.
const sequelize = new Sequelize(
    process.env.DB_SEQUELIZE_NAME || process.env.DB_NAME || '',
    process.env.DB_SEQUELIZE_USER || process.env.DB_USER || '',
    process.env.DB_SEQUELIZE_PASSWORD || process.env.DB_PASSWORD || '',
    {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 1433,
        dialect: 'mssql',
        // Untuk mssql, opsi tedious harus di dalam dialectOptions.options; kalau di level atas diabaikan
        // sehingga encrypt default true dan TLS gagal saat DB_HOST berupa IP (mis. 127.0.0.1).
        dialectOptions: {
            options: {
                encrypt: false,
                trustServerCertificate: true,
            },
        },
        logging: false, // nonaktifkan log query
        pool: {
            max: 5,
            min: 0,
            idle: 10000,
        },
    }
);

module.exports = {
    sql,
    poolPromise,
    sequelize,
    Sequelize,
};
