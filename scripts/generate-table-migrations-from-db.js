const fs = require('fs');
const path = require('path');
const sql = require('mssql');

require('dotenv').config();

const rootDir = path.resolve(__dirname, '..');
const outputDir = path.join(rootDir, 'migrations', 'tables');
const schemaName = process.env.DB_SCHEMA || 'dbo';

function q(name) {
    return `[${String(name).replace(/]/g, ']]')}]`;
}

function s(value) {
    return String(value).replace(/'/g, "''");
}

function fileSafeName(tableName) {
    return tableName.replace(/[^A-Za-z0-9_-]/g, '_');
}

function objectName(tableName) {
    return `${schemaName}.${tableName}`;
}

function qualifiedTable(tableName) {
    return `${q(schemaName)}.${q(tableName)}`;
}

function renderDataType(column) {
    const type = column.dataType.toLowerCase();
    const lengthTypes = new Set(['char', 'varchar', 'binary', 'varbinary']);
    const unicodeLengthTypes = new Set(['nchar', 'nvarchar']);
    const precisionTypes = new Set(['decimal', 'numeric']);
    const scaleTypes = new Set(['datetime2', 'datetimeoffset', 'time']);

    if (unicodeLengthTypes.has(type)) {
        return `${column.dataType.toUpperCase()}(${column.maxLength === -1 ? 'MAX' : column.maxLength / 2})`;
    }

    if (lengthTypes.has(type)) {
        return `${column.dataType.toUpperCase()}(${column.maxLength === -1 ? 'MAX' : column.maxLength})`;
    }

    if (precisionTypes.has(type)) {
        return `${column.dataType.toUpperCase()}(${column.precision},${column.scale})`;
    }

    if (scaleTypes.has(type)) {
        return `${column.dataType.toUpperCase()}(${column.scale})`;
    }

    if (type === 'float' && column.precision && column.precision !== 53) {
        return `${column.dataType.toUpperCase()}(${column.precision})`;
    }

    return column.dataType.toUpperCase();
}

function renderColumn(column) {
    if (column.isComputed) {
        return `    ${q(column.columnName)} AS ${column.computedDefinition}${column.isPersisted ? ' PERSISTED' : ''}`;
    }

    const parts = [
        `    ${q(column.columnName)}`,
        renderDataType(column),
    ];

    if (column.isIdentity) {
        parts.push(`IDENTITY(${column.seedValue || 1},${column.incrementValue || 1})`);
    }

    if (column.defaultDefinition) {
        parts.push(`DEFAULT ${column.defaultDefinition}`);
    }

    parts.push(column.isNullable ? 'NULL' : 'NOT NULL');
    return parts.join(' ');
}

function renderKeyConstraint(constraint) {
    if (!constraint) return null;
    const columns = constraint.columns
        .map((column) => `${q(column.columnName)} ${column.isDescendingKey ? 'DESC' : 'ASC'}`)
        .join(', ');
    return `    CONSTRAINT ${q(constraint.name)} ${constraint.type} ${constraint.indexType} (${columns})`;
}

function renderCreateTable(table, primaryKey, uniqueConstraints) {
    const columnLines = table.columns.map(renderColumn);
    const constraintLines = [
        renderKeyConstraint(primaryKey),
        ...uniqueConstraints.map(renderKeyConstraint),
    ].filter(Boolean);

    return [...columnLines, ...constraintLines].join(',\n');
}

function renderIndex(index) {
    const unique = index.isUnique ? 'UNIQUE ' : '';
    const type = index.typeDesc.replace(/_/g, ' ');
    const columns = index.columns
        .filter((column) => !column.isIncludedColumn)
        .map((column) => `${q(column.columnName)} ${column.isDescendingKey ? 'DESC' : 'ASC'}`)
        .join(', ');
    const includes = index.columns
        .filter((column) => column.isIncludedColumn)
        .map((column) => q(column.columnName));
    const includeSql = includes.length ? `\n    INCLUDE (${includes.join(', ')})` : '';
    const filterSql = index.filterDefinition ? `\n    WHERE ${index.filterDefinition}` : '';

    return `IF OBJECT_ID(N'${s(objectName(index.tableName))}', N'U') IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'${s(objectName(index.tableName))}')
        AND name = N'${s(index.indexName)}'
    )
BEGIN
    CREATE ${unique}${type} INDEX ${q(index.indexName)}
    ON ${qualifiedTable(index.tableName)} (${columns})${includeSql}${filterSql};
END
GO`;
}

function renderForeignKey(fk) {
    const sourceColumns = fk.columns.map((column) => q(column.parentColumn)).join(', ');
    const targetColumns = fk.columns.map((column) => q(column.referencedColumn)).join(', ');
    const deleteAction = fk.deleteAction && fk.deleteAction !== 'NO_ACTION'
        ? `\n    ON DELETE ${fk.deleteAction.replace(/_/g, ' ')}`
        : '';
    const updateAction = fk.updateAction && fk.updateAction !== 'NO_ACTION'
        ? `\n    ON UPDATE ${fk.updateAction.replace(/_/g, ' ')}`
        : '';

    return `IF OBJECT_ID(N'${s(objectName(fk.parentTable))}', N'U') IS NOT NULL
    AND OBJECT_ID(N'${s(objectName(fk.referencedTable))}', N'U') IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM sys.foreign_keys
        WHERE parent_object_id = OBJECT_ID(N'${s(objectName(fk.parentTable))}')
        AND name = N'${s(fk.name)}'
    )
BEGIN
    ALTER TABLE ${qualifiedTable(fk.parentTable)} WITH CHECK
    ADD CONSTRAINT ${q(fk.name)}
    FOREIGN KEY (${sourceColumns})
    REFERENCES ${qualifiedTable(fk.referencedTable)} (${targetColumns})${deleteAction}${updateAction};
END
GO`;
}

function cleanOutputDir() {
    fs.mkdirSync(outputDir, { recursive: true });
    for (const entry of fs.readdirSync(outputDir)) {
        if (entry.endsWith('.sql')) {
            fs.unlinkSync(path.join(outputDir, entry));
        }
    }
}

async function loadDatabaseSchema(pool) {
    const tablesResult = await pool.request()
        .input('schemaName', sql.NVarChar, schemaName)
        .query(`
            SELECT
                t.object_id AS objectId,
                t.name AS tableName
            FROM sys.tables t
            JOIN sys.schemas s ON s.schema_id = t.schema_id
            WHERE s.name = @schemaName
            ORDER BY t.name;
        `);

    const columnsResult = await pool.request()
        .input('schemaName', sql.NVarChar, schemaName)
        .query(`
            SELECT
                t.name AS tableName,
                c.column_id AS columnId,
                c.name AS columnName,
                ty.name AS dataType,
                c.max_length AS maxLength,
                c.precision AS precision,
                c.scale AS scale,
                c.is_nullable AS isNullable,
                c.is_identity AS isIdentity,
                ic.seed_value AS seedValue,
                ic.increment_value AS incrementValue,
                dc.definition AS defaultDefinition,
                c.is_computed AS isComputed,
                cc.definition AS computedDefinition,
                cc.is_persisted AS isPersisted
            FROM sys.tables t
            JOIN sys.schemas s ON s.schema_id = t.schema_id
            JOIN sys.columns c ON c.object_id = t.object_id
            JOIN sys.types ty ON ty.user_type_id = c.user_type_id
            LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
            LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
            LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
            WHERE s.name = @schemaName
            ORDER BY t.name, c.column_id;
        `);

    const keyResult = await pool.request()
        .input('schemaName', sql.NVarChar, schemaName)
        .query(`
            SELECT
                t.name AS tableName,
                kc.name AS constraintName,
                kc.type AS constraintType,
                i.type_desc AS indexType,
                c.name AS columnName,
                ic.key_ordinal AS keyOrdinal,
                ic.is_descending_key AS isDescendingKey
            FROM sys.key_constraints kc
            JOIN sys.tables t ON t.object_id = kc.parent_object_id
            JOIN sys.schemas s ON s.schema_id = t.schema_id
            JOIN sys.indexes i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id
            JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
            JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
            WHERE s.name = @schemaName
            ORDER BY t.name, kc.name, ic.key_ordinal;
        `);

    const indexResult = await pool.request()
        .input('schemaName', sql.NVarChar, schemaName)
        .query(`
            SELECT
                t.name AS tableName,
                i.name AS indexName,
                i.is_unique AS isUnique,
                i.type_desc AS typeDesc,
                i.filter_definition AS filterDefinition,
                c.name AS columnName,
                ic.key_ordinal AS keyOrdinal,
                ic.index_column_id AS indexColumnId,
                ic.is_descending_key AS isDescendingKey,
                ic.is_included_column AS isIncludedColumn
            FROM sys.indexes i
            JOIN sys.tables t ON t.object_id = i.object_id
            JOIN sys.schemas s ON s.schema_id = t.schema_id
            JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
            JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
            WHERE s.name = @schemaName
              AND i.name IS NOT NULL
              AND i.is_primary_key = 0
              AND i.is_unique_constraint = 0
              AND i.is_hypothetical = 0
            ORDER BY t.name, i.name, ic.is_included_column, ic.key_ordinal, ic.index_column_id;
        `);

    const fkResult = await pool.request()
        .input('schemaName', sql.NVarChar, schemaName)
        .query(`
            SELECT
                fk.name AS foreignKeyName,
                parentTable.name AS parentTable,
                parentColumn.name AS parentColumn,
                referencedTable.name AS referencedTable,
                referencedColumn.name AS referencedColumn,
                fkc.constraint_column_id AS columnOrdinal,
                fk.delete_referential_action_desc AS deleteAction,
                fk.update_referential_action_desc AS updateAction
            FROM sys.foreign_keys fk
            JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
            JOIN sys.tables parentTable ON parentTable.object_id = fk.parent_object_id
            JOIN sys.schemas parentSchema ON parentSchema.schema_id = parentTable.schema_id
            JOIN sys.columns parentColumn ON parentColumn.object_id = parentTable.object_id AND parentColumn.column_id = fkc.parent_column_id
            JOIN sys.tables referencedTable ON referencedTable.object_id = fk.referenced_object_id
            JOIN sys.columns referencedColumn ON referencedColumn.object_id = referencedTable.object_id AND referencedColumn.column_id = fkc.referenced_column_id
            WHERE parentSchema.name = @schemaName
            ORDER BY parentTable.name, fk.name, fkc.constraint_column_id;
        `);

    const tables = new Map();
    for (const row of tablesResult.recordset) {
        tables.set(row.tableName, { tableName: row.tableName, columns: [] });
    }

    for (const row of columnsResult.recordset) {
        const table = tables.get(row.tableName);
        if (!table) continue;
        table.columns.push({
            columnName: row.columnName,
            dataType: row.dataType,
            maxLength: row.maxLength,
            precision: row.precision,
            scale: row.scale,
            isNullable: Boolean(row.isNullable),
            isIdentity: Boolean(row.isIdentity),
            seedValue: row.seedValue,
            incrementValue: row.incrementValue,
            defaultDefinition: row.defaultDefinition,
            isComputed: Boolean(row.isComputed),
            computedDefinition: row.computedDefinition,
            isPersisted: Boolean(row.isPersisted),
        });
    }

    const keyConstraints = new Map();
    for (const row of keyResult.recordset) {
        const id = `${row.tableName}:${row.constraintName}`;
        if (!keyConstraints.has(id)) {
            keyConstraints.set(id, {
                tableName: row.tableName,
                name: row.constraintName,
                type: row.constraintType === 'PK' ? 'PRIMARY KEY' : 'UNIQUE',
                indexType: row.indexType.replace(/_/g, ' '),
                columns: [],
            });
        }
        keyConstraints.get(id).columns.push({
            columnName: row.columnName,
            keyOrdinal: row.keyOrdinal,
            isDescendingKey: Boolean(row.isDescendingKey),
        });
    }

    const indexes = new Map();
    for (const row of indexResult.recordset) {
        const id = `${row.tableName}:${row.indexName}`;
        if (!indexes.has(id)) {
            indexes.set(id, {
                tableName: row.tableName,
                indexName: row.indexName,
                isUnique: Boolean(row.isUnique),
                typeDesc: row.typeDesc,
                filterDefinition: row.filterDefinition,
                columns: [],
            });
        }
        indexes.get(id).columns.push({
            columnName: row.columnName,
            keyOrdinal: row.keyOrdinal,
            indexColumnId: row.indexColumnId,
            isDescendingKey: Boolean(row.isDescendingKey),
            isIncludedColumn: Boolean(row.isIncludedColumn),
        });
    }

    const foreignKeys = new Map();
    for (const row of fkResult.recordset) {
        const id = `${row.parentTable}:${row.foreignKeyName}`;
        if (!foreignKeys.has(id)) {
            foreignKeys.set(id, {
                name: row.foreignKeyName,
                parentTable: row.parentTable,
                referencedTable: row.referencedTable,
                deleteAction: row.deleteAction,
                updateAction: row.updateAction,
                columns: [],
            });
        }
        foreignKeys.get(id).columns.push({
            parentColumn: row.parentColumn,
            referencedColumn: row.referencedColumn,
            columnOrdinal: row.columnOrdinal,
        });
    }

    return {
        tables: [...tables.values()],
        keys: [...keyConstraints.values()],
        indexes: [...indexes.values()],
        foreignKeys: [...foreignKeys.values()],
    };
}

function writeTableFiles(schema) {
    cleanOutputDir();

    const keysByTable = new Map();
    for (const key of schema.keys) {
        if (!keysByTable.has(key.tableName)) keysByTable.set(key.tableName, []);
        keysByTable.get(key.tableName).push(key);
    }

    const indexesByTable = new Map();
    for (const index of schema.indexes) {
        if (!indexesByTable.has(index.tableName)) indexesByTable.set(index.tableName, []);
        indexesByTable.get(index.tableName).push(index);
    }

    const foreignKeysByTable = new Map();
    for (const fk of schema.foreignKeys) {
        if (!foreignKeysByTable.has(fk.parentTable)) foreignKeysByTable.set(fk.parentTable, []);
        foreignKeysByTable.get(fk.parentTable).push(fk);
    }

    const tableNames = schema.tables.map((table) => table.tableName).sort((a, b) => a.localeCompare(b));

    for (const table of schema.tables.sort((a, b) => a.tableName.localeCompare(b.tableName))) {
        const keys = keysByTable.get(table.tableName) || [];
        const primaryKey = keys.find((key) => key.type === 'PRIMARY KEY');
        const uniqueConstraints = keys.filter((key) => key.type === 'UNIQUE');
        const indexes = indexesByTable.get(table.tableName) || [];
        const foreignKeys = foreignKeysByTable.get(table.tableName) || [];
        const createBody = renderCreateTable(table, primaryKey, uniqueConstraints);
        const content = [
            '-- Auto-generated from the active database schema.',
            `-- Database: ${process.env.DB_NAME || ''}`,
            `-- Schema: ${schemaName}`,
            '-- Regenerate with: npm run generate:tables:db',
            '',
            `IF OBJECT_ID(N'${s(objectName(table.tableName))}', N'U') IS NULL`,
            'BEGIN',
            `    CREATE TABLE ${qualifiedTable(table.tableName)} (`,
            createBody,
            '    );',
            'END',
            'GO',
            '',
            ...indexes.map(renderIndex),
            ...foreignKeys.map(renderForeignKey),
        ].join('\n');

        fs.writeFileSync(path.join(outputDir, `${fileSafeName(table.tableName)}.create-table.sql`), `${content.trim()}\n`, 'utf8');
    }

    const readme = [
        '# Per-Table CREATE Scripts',
        '',
        'Folder ini dibuat otomatis dari metadata database aktif yang dikonfigurasi di `.env`.',
        '',
        'Regenerate:',
        '',
        '```bash',
        'npm run generate:tables:db',
        '```',
        '',
        'Catatan:',
        '- File ini mencerminkan schema database aktif saat generator dijalankan.',
        '- Setiap file berisi `CREATE TABLE` untuk satu tabel, ditambah index dan foreign key milik tabel tersebut.',
        '- Jalankan dengan urutan/dependency yang benar bila dipakai untuk restore database kosong.',
        '',
        `Jumlah tabel: ${tableNames.length}`,
        '',
        'Daftar tabel:',
        '',
        ...tableNames.map((tableName) => `- \`${tableName}\``),
        '',
    ].join('\n');

    fs.writeFileSync(path.join(outputDir, 'README.md'), readme, 'utf8');
}

async function main() {
    const pool = await sql.connect({
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        server: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 1433),
        database: process.env.DB_NAME,
        options: { encrypt: false, trustServerCertificate: true },
        connectionTimeout: 30000,
        requestTimeout: 30000,
    });

    try {
        const schema = await loadDatabaseSchema(pool);
        writeTableFiles(schema);
        console.log(`Generated ${schema.tables.length} per-table CREATE scripts from database ${process.env.DB_NAME}.`);
    } finally {
        await pool.close();
    }
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
