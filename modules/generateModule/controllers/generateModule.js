const db = require('../../../database');
const fs = require('fs');
const path = require('path');
const { checkAccess } = require('../../../helpers/accessControl');

const MODULE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

// Menulis file source di server hanya masuk akal saat development.
function isGeneratorEnabled() {
    return process.env.NODE_ENV !== 'production' || process.env.GENERATOR_ENABLED === 'true';
}

// Tampilkan halaman utama generateModule
exports.index = async function (req, res) {
    try {
        if (!checkAccess(req, 'view')) {
            return res.status(403).send('Tidak memiliki akses');
        }

        const vars = {
            title: 'Generate Module',
            subtitle: 'Generate Module Management',
            module: 'generateModule',
            error_msg: req.query.error_msg || '',
            // Pass permissions to view
            permissions: req.session.aksesMenu?.generateModule || {},
            generatorEnabled: isGeneratorEnabled(),
        };

        const viewPath = 'generateModule/views/vw_index.html';
        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            res.render(viewPath, vars);
        } else {
            vars.content = viewPath;
            res.render('index', vars);
        }
    } catch (err) {
        console.error('Error in generateModule.index:', err);
        res.status(500).send('Error: ' + err.message);
    }
};

// Ambil data untuk DataTables
exports.data = async function (req, res) {
    if (!checkAccess(req, 'view')) {
        return res.status(403).json({ error: 'Tidak memiliki akses' });
    }
    try {
        const pool = await db.poolPromise;
        const result = await pool.request().query(`
            SELECT * FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_TYPE = 'BASE TABLE'
            ORDER BY TABLE_NAME
        `);
        res.json({
            data: result.recordset
        });
    } catch (err) {
        console.error('Error in generateModule.data:', err);
        res.status(500).json({ error: err.message });
    }
};

// Generate module baru (menulis modules/<moduleName>/controllers + views)
exports.buildModule = async function (req, res) {
    const { tableName, moduleName } = req.body;

    if (!checkAccess(req, 'add')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }
    if (!isGeneratorEnabled()) {
        return res.json({ success: false, message: 'Generator dinonaktifkan di production (set GENERATOR_ENABLED=true untuk mengaktifkan).' });
    }
    if (!tableName || !moduleName) {
        return res.json({ success: false, message: 'Parameter tidak lengkap.' });
    }
    if (!MODULE_NAME_PATTERN.test(moduleName) || !TABLE_NAME_PATTERN.test(tableName)) {
        return res.json({ success: false, message: 'Nama module/tabel hanya boleh huruf, angka, dan underscore.' });
    }

    try {
        const pool = await db.poolPromise;

        // Get table schema
        const schemaResult = await pool.request()
            .input('tableName', db.sql.NVarChar, tableName)
            .query(`
                SELECT
                    COLUMN_NAME,
                    DATA_TYPE,
                    CHARACTER_MAXIMUM_LENGTH,
                    IS_NULLABLE,
                    COLUMN_DEFAULT
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_NAME = @tableName
                ORDER BY ORDINAL_POSITION
            `);

        if (schemaResult.recordset.length === 0) {
            return res.json({ success: false, message: 'Tabel tidak ditemukan.' });
        }
        if (schemaResult.recordset.some((col) => !TABLE_NAME_PATTERN.test(col.COLUMN_NAME))) {
            return res.json({ success: false, message: 'Tabel memiliki nama kolom yang tidak didukung generator.' });
        }

        // Generate module structure
        const moduleStructure = generateModuleStructure(moduleName, tableName, schemaResult.recordset);

        // Create module directories and files
        const modulePath = path.join(__dirname, '../../', moduleName);
        const controllersPath = path.join(modulePath, 'controllers');
        const viewsPath = path.join(modulePath, 'views');

        if (fs.existsSync(modulePath)) {
            return res.json({ success: false, message: `Module ${moduleName} sudah ada. Hapus folder modules/${moduleName} dulu bila ingin generate ulang.` });
        }

        try {
            // Create directories if they don't exist
            if (!fs.existsSync(modulePath)) {
                fs.mkdirSync(modulePath, { recursive: true });
            }
            if (!fs.existsSync(controllersPath)) {
                fs.mkdirSync(controllersPath, { recursive: true });
            }
            if (!fs.existsSync(viewsPath)) {
                fs.mkdirSync(viewsPath, { recursive: true });
            }

            // Write controller file
            const controllerFilePath = path.join(controllersPath, `${moduleName}.js`);
            fs.writeFileSync(controllerFilePath, moduleStructure.controllerCode);

            // Write view file
            const viewFilePath = path.join(viewsPath, 'vw_data.html');
            fs.writeFileSync(viewFilePath, moduleStructure.viewCode);

            console.log(`Module ${moduleName} files created successfully`);

        } catch (fileErr) {
            console.error('Error creating module files:', fileErr);
            return res.json({
                success: false,
                message: 'Module berhasil digenerate tapi gagal menyimpan file: ' + fileErr.message
            });
        }

        res.json({
            success: true,
            message: 'Module berhasil digenerate dan disimpan.',
            data: moduleStructure
        });
    } catch (err) {
        console.error('Error in generateModule.generate:', err);
        res.json({ success: false, message: err.message });
    }
};

// Helper function to generate module structure
function generateModuleStructure(moduleName, tableName, columns) {
    const primaryKey = findPrimaryKey(columns);
    const structure = {
        moduleName,
        tableName,
        primaryKey,
        columns,
        controllerCode: generateControllerCode(moduleName, tableName, columns, primaryKey),
        viewCode: generateViewCode(moduleName, tableName, columns, primaryKey),
        routeInfo: `/${moduleName}/index`
    };

    return structure;
}

// Find primary key (simple heuristic - first column or ID column)
function findPrimaryKey(columns) {
    const idColumn = columns.find(col =>
        col.COLUMN_NAME.toLowerCase().includes('id') ||
        col.COLUMN_NAME.toLowerCase().includes('key')
    );
    return idColumn ? idColumn.COLUMN_NAME : columns[0].COLUMN_NAME;
}

// Generate controller code
function generateControllerCode(moduleName, tableName, columns, primaryKey) {
    let controllerTemplate = '';
    controllerTemplate += 'const db = require(\'../../../database\');\n';
    controllerTemplate += 'const { checkAccess } = require(\'../../../helpers/accessControl\');\n';
    controllerTemplate += '\n';
    controllerTemplate += '// Tampilkan halaman daftar ' + moduleName + '\n';
    controllerTemplate += 'exports.index = async function (req, res) {\n';
    controllerTemplate += '    if (!checkAccess(req, \'view\')) {\n';
    controllerTemplate += '        return res.status(403).send(\'Tidak memiliki akses\');\n';
    controllerTemplate += '    }\n';
    controllerTemplate += '    try {\n';
    controllerTemplate += '        const vars = {\n';
    controllerTemplate += '            title: \'Data ' + moduleName + '\',\n';
    controllerTemplate += '            subtitle: \'Daftar ' + moduleName + '\',\n';
    controllerTemplate += '            module: \'' + moduleName + '\',\n';
    controllerTemplate += '            error_msg: req.query.error_msg || \'\',\n';
    controllerTemplate += '        };\n';
    controllerTemplate += '\n';
    controllerTemplate += '        const viewPath = \'' + moduleName + '/views/vw_data.html\';\n';
    controllerTemplate += '        if (req.xhr || req.headers[\'x-requested-with\'] === \'XMLHttpRequest\') {\n';
    controllerTemplate += '            res.render(viewPath, vars);\n';
    controllerTemplate += '        } else {\n';
    controllerTemplate += '            vars.content = viewPath;\n';
    controllerTemplate += '            res.render(\'index\', vars);\n';
    controllerTemplate += '        }\n';
    controllerTemplate += '    } catch (err) {\n';
    controllerTemplate += '        console.error(\'Error in ' + moduleName + '.index:\', err);\n';
    controllerTemplate += '        res.status(500).send(\'Error: \' + err.message);\n';
    controllerTemplate += '    }\n';
    controllerTemplate += '};\n';
    controllerTemplate += '\n';
    controllerTemplate += '// Ambil data untuk DataTables\n';
    controllerTemplate += 'exports.data = async function (req, res) {\n';
    controllerTemplate += '    if (!checkAccess(req, \'view\')) {\n';
    controllerTemplate += '        return res.status(403).json({ success: false, message: \'Tidak memiliki akses\' });\n';
    controllerTemplate += '    }\n';
    controllerTemplate += '    try {\n';
    controllerTemplate += '        const pool = await db.poolPromise;\n';
    controllerTemplate += '        const result = await pool.request().query(`\n';
    controllerTemplate += '            SELECT * FROM ' + tableName + '\n';
    controllerTemplate += '            ORDER BY ' + primaryKey + '\n';
    controllerTemplate += '        `);\n';
    controllerTemplate += '        res.json({\n';
    controllerTemplate += '            data: result.recordset\n';
    controllerTemplate += '        });\n';
    controllerTemplate += '    } catch (err) {\n';
    controllerTemplate += '        console.error(\'Error in ' + moduleName + '.data:\', err);\n';
    controllerTemplate += '        res.status(500).json({ error: err.message });\n';
    controllerTemplate += '    }\n';
    controllerTemplate += '};\n';
    controllerTemplate += '\n';
    controllerTemplate += '// Get data by ID\n';
    controllerTemplate += 'exports.get = async function (req, res) {\n';
    controllerTemplate += '    if (!checkAccess(req, \'view\')) {\n';
    controllerTemplate += '        return res.status(403).json({ success: false, message: \'Tidak memiliki akses\' });\n';
    controllerTemplate += '    }\n';
    controllerTemplate += '    const { id } = req.params;\n';
    controllerTemplate += '    if (!id) {\n';
    controllerTemplate += '        return res.json({ success: false, message: \'Parameter tidak lengkap.\' });\n';
    controllerTemplate += '    }\n';
    controllerTemplate += '    try {\n';
    controllerTemplate += '        const pool = await db.poolPromise;\n';
    controllerTemplate += '        const result = await pool.request()\n';
    controllerTemplate += '            .input(\'' + primaryKey + '\', db.sql.BigInt, id)\n';
    controllerTemplate += '            .query(`SELECT * FROM ' + tableName + ' WHERE ' + primaryKey + ' = @' + primaryKey + '`);\n';
    controllerTemplate += '\n';
    controllerTemplate += '        if (result.recordset.length > 0) {\n';
    controllerTemplate += '            res.json({ success: true, data: result.recordset[0] });\n';
    controllerTemplate += '        } else {\n';
    controllerTemplate += '            res.json({ success: false, message: \'Data tidak ditemukan.\' });\n';
    controllerTemplate += '        }\n';
    controllerTemplate += '    } catch (err) {\n';
    controllerTemplate += '        res.json({ success: false, message: err.message });\n';
    controllerTemplate += '    }\n';
    controllerTemplate += '};\n';
    controllerTemplate += '\n';
    controllerTemplate += '// Insert new record\n';
    controllerTemplate += 'exports.insert = async function (req, res) {\n';
    controllerTemplate += '    if (!checkAccess(req, \'add\')) {\n';
    controllerTemplate += '        return res.status(403).json({ success: false, message: \'Tidak memiliki akses\' });\n';
    controllerTemplate += '    }\n';
    controllerTemplate += '    const data = req.body;\n';
    controllerTemplate += '\n';
    controllerTemplate += '    // Basic validation - exclude primary key from required fields for insert\n';
    controllerTemplate += '    const requiredFields = [' + columns.filter(col => col.IS_NULLABLE === 'NO' && col.COLUMN_NAME !== primaryKey).map(col => '\'' + col.COLUMN_NAME + '\'').join(', ') + '];\n';
    controllerTemplate += '    for (const field of requiredFields) {\n';
    controllerTemplate += '        if (!data[field]) {\n';
    controllerTemplate += '            return res.json({ success: false, message: `Field ${field} wajib diisi.` });\n';
    controllerTemplate += '        }\n';
    controllerTemplate += '    }\n';
    controllerTemplate += '\n';
    controllerTemplate += '    try {\n';
    controllerTemplate += '        const pool = await db.poolPromise;\n';
    controllerTemplate += '        const columnNames = [' + columns.filter(col => col.COLUMN_NAME !== primaryKey).map(col => '\'' + col.COLUMN_NAME + '\'').join(', ') + '];\n';
    controllerTemplate += '        const values = columnNames.map(col => \'@\' + col);\n';
    controllerTemplate += '        const sql = `INSERT INTO ' + tableName + ' (${columnNames.join(\', \')}) VALUES (${values.join(\', \')})`;\n';
    controllerTemplate += '\n';
    controllerTemplate += '        const request = pool.request();\n';
    controllerTemplate += '        columnNames.forEach(col => {\n';
    controllerTemplate += '            const columnDef = ' + JSON.stringify(columns) + '.find(c => c.COLUMN_NAME === col);\n';
    controllerTemplate += '            const value = data[col];\n';
    controllerTemplate += '            // Set appropriate SQL type based on DATA_TYPE\n';
    controllerTemplate += '            request.input(col, getSqlType(columnDef.DATA_TYPE), value || null);\n';
    controllerTemplate += '        });\n';
    controllerTemplate += '\n';
    controllerTemplate += '        await request.query(sql);\n';
    controllerTemplate += '        res.json({ success: true, message: \'' + moduleName + ' berhasil ditambahkan.\' });\n';
    controllerTemplate += '    } catch (err) {\n';
    controllerTemplate += '        res.json({ success: false, message: err.message });\n';
    controllerTemplate += '    }\n';
    controllerTemplate += '};\n';
    controllerTemplate += '\n';
    controllerTemplate += '// Update record\n';
    controllerTemplate += 'exports.update = async function (req, res) {\n';
    controllerTemplate += '    if (!checkAccess(req, \'edit\')) {\n';
    controllerTemplate += '        return res.status(403).json({ success: false, message: \'Tidak memiliki akses\' });\n';
    controllerTemplate += '    }\n';
    controllerTemplate += '    const data = req.body;\n';
    controllerTemplate += '    const id = data.' + primaryKey + ';\n';
    controllerTemplate += '\n';
    controllerTemplate += '    if (!id) {\n';
    controllerTemplate += '        return res.json({ success: false, message: \'ID tidak ditemukan.\' });\n';
    controllerTemplate += '    }\n';
    controllerTemplate += '\n';
    controllerTemplate += '    try {\n';
    controllerTemplate += '        const pool = await db.poolPromise;\n';
    controllerTemplate += '        const columnNames = [' + columns.filter(col => col.COLUMN_NAME !== primaryKey).map(col => '\'' + col.COLUMN_NAME + '\'').join(', ') + '];\n';
    controllerTemplate += '        const setClause = columnNames.map(col => `${col} = @${col}`).join(\', \');\n';
    controllerTemplate += '        const sql = `UPDATE ' + tableName + ' SET ${setClause} WHERE ' + primaryKey + ' = @' + primaryKey + '`;\n';
    controllerTemplate += '\n';
    controllerTemplate += '        const request = pool.request();\n';
    controllerTemplate += '        request.input(\'' + primaryKey + '\', db.sql.BigInt, id);\n';
    controllerTemplate += '        columnNames.forEach(col => {\n';
    controllerTemplate += '            const columnDef = ' + JSON.stringify(columns) + '.find(c => c.COLUMN_NAME === col);\n';
    controllerTemplate += '            const value = data[col];\n';
    controllerTemplate += '            request.input(col, getSqlType(columnDef.DATA_TYPE), value || null);\n';
    controllerTemplate += '        });\n';
    controllerTemplate += '\n';
    controllerTemplate += '        await request.query(sql);\n';
    controllerTemplate += '        res.json({ success: true, message: \'' + moduleName + ' berhasil diupdate.\' });\n';
    controllerTemplate += '    } catch (err) {\n';
    controllerTemplate += '        res.json({ success: false, message: err.message });\n';
    controllerTemplate += '    }\n';
    controllerTemplate += '};\n';
    controllerTemplate += '\n';
    controllerTemplate += '// Delete record\n';
    controllerTemplate += 'exports.delete = async function (req, res) {\n';
    controllerTemplate += '    if (!checkAccess(req, \'delete\')) {\n';
    controllerTemplate += '        return res.status(403).json({ success: false, message: \'Tidak memiliki akses\' });\n';
    controllerTemplate += '    }\n';
    controllerTemplate += '    const { id } = req.params;\n';
    controllerTemplate += '    if (!id) {\n';
    controllerTemplate += '        return res.json({ success: false, message: \'Parameter tidak lengkap.\' });\n';
    controllerTemplate += '    }\n';
    controllerTemplate += '\n';
    controllerTemplate += '    try {\n';
    controllerTemplate += '        const pool = await db.poolPromise;\n';
    controllerTemplate += '        await pool.request()\n';
    controllerTemplate += '            .input(\'' + primaryKey + '\', db.sql.BigInt, id)\n';
    controllerTemplate += '            .query(`DELETE FROM ' + tableName + ' WHERE ' + primaryKey + ' = @' + primaryKey + '`);\n';
    controllerTemplate += '\n';
    controllerTemplate += '        res.json({ success: true, message: \'' + moduleName + ' berhasil dihapus.\' });\n';
    controllerTemplate += '    } catch (err) {\n';
    controllerTemplate += '        res.json({ success: false, message: err.message });\n';
    controllerTemplate += '    }\n';
    controllerTemplate += '};\n';
    controllerTemplate += '\n';
    controllerTemplate += '// Helper function to get SQL type\n';
    controllerTemplate += 'function getSqlType(dataType) {\n';
    controllerTemplate += '    switch (dataType.toLowerCase()) {\n';
    controllerTemplate += '        case \'int\':\n';
    controllerTemplate += '        case \'bigint\':\n';
    controllerTemplate += '            return db.sql.BigInt;\n';
    controllerTemplate += '        case \'varchar\':\n';
    controllerTemplate += '        case \'nvarchar\':\n';
    controllerTemplate += '        case \'text\':\n';
    controllerTemplate += '        case \'ntext\':\n';
    controllerTemplate += '            return db.sql.NVarChar;\n';
    controllerTemplate += '        case \'datetime\':\n';
    controllerTemplate += '        case \'datetime2\':\n';
    controllerTemplate += '            return db.sql.DateTime;\n';
    controllerTemplate += '        case \'bit\':\n';
    controllerTemplate += '            return db.sql.Bit;\n';
    controllerTemplate += '        case \'decimal\':\n';
    controllerTemplate += '        case \'numeric\':\n';
    controllerTemplate += '            return db.sql.Decimal;\n';
    controllerTemplate += '        default:\n';
    controllerTemplate += '            return db.sql.NVarChar;\n';
    controllerTemplate += '    }\n';
    controllerTemplate += '};\n';
    controllerTemplate += '\n';
    controllerTemplate += 'module.exports = exports;\n';

    return controllerTemplate;
}

// Generate basic view code
function generateViewCode(moduleName, tableName, columns, primaryKey) {
    let viewTemplate = '';
    viewTemplate += '<div class="flex-grow-1 container-p-y container-fluid">\n';
    viewTemplate += '    <h5 class="fw-bold py-3 mb-4">\n';
    viewTemplate += '        <span class="text-muted fw-light">Sistem / <%= title %> /</span>\n';
    viewTemplate += '        <%= subtitle %>\n';
    viewTemplate += '    </h5>\n';
    viewTemplate += '    <% if (typeof error_msg !== \'undefined\' && error_msg) { %>\n';
    viewTemplate += '    <div class="alert alert-danger alert-dismissible" role="alert">\n';
    viewTemplate += '        <%= error_msg %>\n';
    viewTemplate += '        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>\n';
    viewTemplate += '    </div>\n';
    viewTemplate += '    <% } %>\n';
    viewTemplate += '    <div class="card">\n';
    viewTemplate += '        <div class="card-body">\n';
    viewTemplate += '            <div class="d-flex justify-content-between align-items-center mb-3">\n';
    viewTemplate += '                <h4><%= subtitle %></h4>\n';
    viewTemplate += '                <div class="mb-3 d-flex justify-content-end">\n';
    viewTemplate += '                    <button class="btn btn-primary btn-sm" onclick="openAddModal()">\n';
    viewTemplate += '                        <i class="bx bx-plus"></i>\n';
    viewTemplate += '                        Tambah ' + moduleName + '\n';
    viewTemplate += '                    </button>\n';
    viewTemplate += '                </div>\n';
    viewTemplate += '            </div>\n';
    viewTemplate += '            <table id="' + moduleName + 'Table" class="table table-bordered table-sm w-100">\n';
    viewTemplate += '                <thead>\n';
    viewTemplate += '                    <tr>\n';
    viewTemplate += '                        <th>No</th>\n';

    // Add column headers
    columns.forEach(col => {
        viewTemplate += '                        <th>' + col.COLUMN_NAME + '</th>\n';
    });

    viewTemplate += '                        <th>Aksi</th>\n';
    viewTemplate += '                    </tr>\n';
    viewTemplate += '                </thead>\n';
    viewTemplate += '                <tbody></tbody>\n';
    viewTemplate += '            </table>\n';
    viewTemplate += '        </div>\n';
    viewTemplate += '    </div>\n';
    viewTemplate += '</div>\n';
    viewTemplate += '\n';
    viewTemplate += '<!-- Modal Tambah ' + moduleName + ' -->\n';
    viewTemplate += '<div class="modal fade" id="addModal" tabindex="-1" aria-labelledby="addModalLabel" aria-hidden="true">\n';
    viewTemplate += '    <div class="modal-dialog modal-lg">\n';
    viewTemplate += '        <div class="modal-content">\n';
    viewTemplate += '            <div class="modal-header">\n';
    viewTemplate += '                <h5 class="modal-title" id="addModalLabel">Tambah ' + moduleName + '</h5>\n';
    viewTemplate += '                <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>\n';
    viewTemplate += '            </div>\n';
    viewTemplate += '            <form id="addForm">\n';
    viewTemplate += '                <div class="modal-body">\n';

    // Add form fields for insert
    columns.filter(col => col.COLUMN_NAME !== primaryKey).forEach(col => {
        viewTemplate += '                    <div class="mb-3">\n';
        viewTemplate += '                        <label for="add' + col.COLUMN_NAME + '" class="form-label">' + col.COLUMN_NAME + '</label>\n';
        viewTemplate += '                        <input type="' + getInputType(col.DATA_TYPE) + '" class="form-control" id="add' + col.COLUMN_NAME + '" name="' + col.COLUMN_NAME + '" ' + (col.IS_NULLABLE === 'NO' ? 'required' : '') + '>\n';
        viewTemplate += '                    </div>\n';
    });

    viewTemplate += '                </div>\n';
    viewTemplate += '                <div class="modal-footer justify-content-center">\n';
    viewTemplate += '                    <button type="submit" class="btn btn-success px-4"><b>Simpan</b></button>\n';
    viewTemplate += '                    <button type="button" class="btn btn-danger px-4" data-bs-dismiss="modal"><b>Batal</b></button>\n';
    viewTemplate += '                </div>\n';
    viewTemplate += '            </form>\n';
    viewTemplate += '        </div>\n';
    viewTemplate += '    </div>\n';
    viewTemplate += '</div>\n';
    viewTemplate += '\n';
    viewTemplate += '<!-- Modal Edit ' + moduleName + ' -->\n';
    viewTemplate += '<div class="modal fade" id="editModal" tabindex="-1" aria-labelledby="editModalLabel" aria-hidden="true">\n';
    viewTemplate += '    <div class="modal-dialog modal-lg">\n';
    viewTemplate += '        <div class="modal-content">\n';
    viewTemplate += '            <div class="modal-header">\n';
    viewTemplate += '                <h5 class="modal-title" id="editModalLabel">Edit ' + moduleName + '</h5>\n';
    viewTemplate += '                <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>\n';
    viewTemplate += '            </div>\n';
    viewTemplate += '            <form id="editForm">\n';
    viewTemplate += '                <input type="hidden" id="edit' + primaryKey + '" name="' + primaryKey + '">\n';
    viewTemplate += '                <div class="modal-body">\n';

    // Add form fields for edit
    columns.filter(col => col.COLUMN_NAME !== primaryKey).forEach(col => {
        viewTemplate += '                    <div class="mb-3">\n';
        viewTemplate += '                        <label for="edit' + col.COLUMN_NAME + '" class="form-label">' + col.COLUMN_NAME + '</label>\n';
        viewTemplate += '                        <input type="' + getInputType(col.DATA_TYPE) + '" class="form-control" id="edit' + col.COLUMN_NAME + '" name="' + col.COLUMN_NAME + '" ' + (col.IS_NULLABLE === 'NO' ? 'required' : '') + '>\n';
        viewTemplate += '                    </div>\n';
    });

    viewTemplate += '                </div>\n';
    viewTemplate += '                <div class="modal-footer justify-content-center">\n';
    viewTemplate += '                    <button type="submit" class="btn btn-success px-4"><b>Update</b></button>\n';
    viewTemplate += '                    <button type="button" class="btn btn-danger px-4" data-bs-dismiss="modal"><b>Batal</b></button>\n';
    viewTemplate += '                </div>\n';
    viewTemplate += '            </form>\n';
    viewTemplate += '        </div>\n';
    viewTemplate += '    </div>\n';
    viewTemplate += '</div>\n';
    viewTemplate += '\n';
    viewTemplate += '<script>\n';
    viewTemplate += '    $(function () {\n';
    viewTemplate += '        // DataTable ' + moduleName + '\n';
    viewTemplate += '        let dt = $(\'#' + moduleName + 'Table\').DataTable({\n';
    viewTemplate += '            paging: true,\n';
    viewTemplate += '            searching: true,\n';
    viewTemplate += '            info: true,\n';
    viewTemplate += '            destroy: true,\n';
    viewTemplate += '            ajax: {\n';
    viewTemplate += '                url: \'/' + moduleName + '/data\',\n';
    viewTemplate += '                dataSrc: \'data\'\n';
    viewTemplate += '            },\n';
    viewTemplate += '            columns: [\n';
    viewTemplate += '                { data: null, render: (data, type, row, meta) => meta.row + 1 },\n';

    // Add column definitions
    columns.forEach(col => {
        viewTemplate += '                { data: \'' + col.COLUMN_NAME + '\' },\n';
    });

    viewTemplate += '                { data: null, orderable: false, render: (data, type, row) => \'<button class=\"btn btn-warning btn-sm btn-edit\" data-' + primaryKey.toLowerCase() + '=\"\' + row.' + primaryKey + ' + \'"><i class=\"bx bx-edit\"></i></button> <button class=\"btn btn-danger btn-sm btn-delete\" data-' + primaryKey.toLowerCase() + '=\"\' + row.' + primaryKey + ' + \'"><i class=\"bx bx-trash\"></i></button>\' }\n';
    viewTemplate += '            ],\n';
    viewTemplate += '            order: [[1, \'asc\']]\n';
    viewTemplate += '        });\n';
    viewTemplate += '\n';
    viewTemplate += '        // Handler tombol edit\n';
    viewTemplate += '        $(document).on(\'click\', \'.btn-edit\', function () {\n';
    viewTemplate += '            const ' + primaryKey.toLowerCase() + ' = $(this).data(\'' + primaryKey.toLowerCase() + '\');\n';
    viewTemplate += '            $.get(\'/' + moduleName + '/get/\' + ' + primaryKey.toLowerCase() + ', function (res) {\n';
    viewTemplate += '                if (res.success && res.data) {\n';
    viewTemplate += '                    $(\'#edit' + primaryKey + '\').val(res.data.' + primaryKey + ');\n';

    // Add field assignments for edit
    columns.filter(col => col.COLUMN_NAME !== primaryKey).forEach(col => {
        viewTemplate += '                    $(\'#edit' + col.COLUMN_NAME + '\').val(res.data.' + col.COLUMN_NAME + ' || \'\');\n';
    });

    viewTemplate += '                    $(\'#editModal\').modal(\'show\');\n';
    viewTemplate += '                } else {\n';
    viewTemplate += '                    Swal.fire(\'Gagal\', res.message || \'Data tidak ditemukan\', \'error\');\n';
    viewTemplate += '                }\n';
    viewTemplate += '            });\n';
    viewTemplate += '        });\n';
    viewTemplate += '\n';
    viewTemplate += '        // Handler tombol hapus\n';
    viewTemplate += '        $(document).on(\'click\', \'.btn-delete\', function () {\n';
    viewTemplate += '            const ' + primaryKey.toLowerCase() + ' = $(this).data(\'' + primaryKey.toLowerCase() + '\');\n';
    viewTemplate += '            Swal.fire({\n';
    viewTemplate += '                title: \'Konfirmasi\',\n';
    viewTemplate += '                text: \'Apakah Anda yakin ingin menghapus data ini?\',\n';
    viewTemplate += '                icon: \'warning\',\n';
    viewTemplate += '                showCancelButton: true,\n';
    viewTemplate += '                confirmButtonColor: \'#d33\',\n';
    viewTemplate += '                cancelButtonColor: \'#3085d6\',\n';
    viewTemplate += '                confirmButtonText: \'Hapus\',\n';
    viewTemplate += '                cancelButtonText: \'Batal\'\n';
    viewTemplate += '            }).then((result) => {\n';
    viewTemplate += '                if (result.isConfirmed) {\n';
    viewTemplate += '                    $.ajax({\n';
    viewTemplate += '                        url: \'/' + moduleName + '/delete/\' + ' + primaryKey.toLowerCase() + ',\n';
    viewTemplate += '                        type: \'DELETE\',\n';
    viewTemplate += '                        success: function (res) {\n';
    viewTemplate += '                            if (res.success) {\n';
    viewTemplate += '                                Swal.fire(\'Sukses\', res.message, \'success\');\n';
    viewTemplate += '                                $(\'#' + moduleName + 'Table\').DataTable().ajax.reload();\n';
    viewTemplate += '                            } else {\n';
    viewTemplate += '                                Swal.fire(\'Gagal\', res.message, \'error\');\n';
    viewTemplate += '                            }\n';
    viewTemplate += '                        },\n';
    viewTemplate += '                        error: function () {\n';
    viewTemplate += '                            Swal.fire(\'Error\', \'Terjadi kesalahan sistem\', \'error\');\n';
    viewTemplate += '                        }\n';
    viewTemplate += '                    });\n';
    viewTemplate += '                }\n';
    viewTemplate += '            });\n';
    viewTemplate += '        });\n';
    viewTemplate += '\n';
    viewTemplate += '        // Handler tombol tambah\n';
    viewTemplate += '        window.openAddModal = function () {\n';
    viewTemplate += '            $(\'#addForm\')[0].reset();\n';
    viewTemplate += '            $(\'#addModal\').modal(\'show\');\n';
    viewTemplate += '        };\n';
    viewTemplate += '\n';
    viewTemplate += '        // Submit tambah ' + moduleName + '\n';
    viewTemplate += '        $(\'#addForm\').on(\'submit\', function (e) {\n';
    viewTemplate += '            e.preventDefault();\n';
    viewTemplate += '            const formData = {};\n';

    // Add form data assignments for insert
    columns.filter(col => col.COLUMN_NAME !== primaryKey).forEach(col => {
        viewTemplate += '            formData.' + col.COLUMN_NAME + ' = $(\'#add' + col.COLUMN_NAME + '\').val();\n';
    });

    viewTemplate += '            $.post(\'/' + moduleName + '/insert\', formData, function (res) {\n';
    viewTemplate += '                if (res.success) {\n';
    viewTemplate += '                    Swal.fire(\'Sukses\', res.message, \'success\');\n';
    viewTemplate += '                    $(\'#addModal\').modal(\'hide\');\n';
    viewTemplate += '                    $(\'#' + moduleName + 'Table\').DataTable().ajax.reload();\n';
    viewTemplate += '                } else {\n';
    viewTemplate += '                    Swal.fire(\'Gagal\', res.message, \'error\');\n';
    viewTemplate += '                }\n';
    viewTemplate += '            }).fail(function () {\n';
    viewTemplate += '                Swal.fire(\'Error\', \'Terjadi kesalahan sistem\', \'error\');\n';
    viewTemplate += '            });\n';
    viewTemplate += '        });\n';
    viewTemplate += '\n';
    viewTemplate += '        // Submit edit ' + moduleName + '\n';
    viewTemplate += '        $(\'#editForm\').on(\'submit\', function (e) {\n';
    viewTemplate += '            e.preventDefault();\n';
    viewTemplate += '            const formData = {\n';
    viewTemplate += '                ' + primaryKey + ': $(\'#edit' + primaryKey + '\').val()\n';
    viewTemplate += '            };\n';

    // Add form data assignments for update
    columns.filter(col => col.COLUMN_NAME !== primaryKey).forEach(col => {
        viewTemplate += '            formData.' + col.COLUMN_NAME + ' = $(\'#edit' + col.COLUMN_NAME + '\').val();\n';
    });

    viewTemplate += '            $.post(\'/' + moduleName + '/update\', formData, function (res) {\n';
    viewTemplate += '                if (res.success) {\n';
    viewTemplate += '                    Swal.fire(\'Sukses\', res.message, \'success\');\n';
    viewTemplate += '                    $(\'#editModal\').modal(\'hide\');\n';
    viewTemplate += '                    $(\'#' + moduleName + 'Table\').DataTable().ajax.reload();\n';
    viewTemplate += '                } else {\n';
    viewTemplate += '                    Swal.fire(\'Gagal\', res.message, \'error\');\n';
    viewTemplate += '                }\n';
    viewTemplate += '            }).fail(function () {\n';
    viewTemplate += '                Swal.fire(\'Error\', \'Terjadi kesalahan sistem\', \'error\');\n';
    viewTemplate += '            });\n';
    viewTemplate += '        });\n';
    viewTemplate += '    });\n';
    viewTemplate += '</script>\n';

    return viewTemplate;
}

// Helper function to get input type based on SQL data type
function getInputType(dataType) {
    switch (dataType.toLowerCase()) {
        case 'int':
        case 'bigint':
        case 'smallint':
        case 'tinyint':
            return 'number';
        case 'decimal':
        case 'numeric':
        case 'float':
        case 'real':
            return 'number';
        case 'datetime':
        case 'datetime2':
        case 'date':
            return 'datetime-local';
        case 'bit':
            return 'checkbox';
        case 'text':
        case 'ntext':
            return 'textarea';
        default:
            return 'text';
    }
}