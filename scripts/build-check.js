const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const sourceRoots = [
    'app.js',
    'auth.js',
    'database.js',
    'router.js',
    'helpers',
    'middleware',
    'migrations',
    'modules',
    'scripts',
];

const ignoredDirectories = new Set([
    'node_modules',
    '.git',
    'public',
    'storage',
    'uploads',
]);

function collectJavaScriptFiles(targetPath, files = []) {
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
        const name = path.basename(targetPath);
        if (ignoredDirectories.has(name)) return files;

        for (const entry of fs.readdirSync(targetPath)) {
            collectJavaScriptFiles(path.join(targetPath, entry), files);
        }
        return files;
    }

    if (targetPath.endsWith('.js')) {
        files.push(targetPath);
    }
    return files;
}

const files = sourceRoots
    .map((entry) => path.join(rootDir, entry))
    .filter((targetPath) => fs.existsSync(targetPath))
    .flatMap((targetPath) => collectJavaScriptFiles(targetPath));

let failed = false;

for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
        cwd: rootDir,
        encoding: 'utf8',
    });

    if (result.status !== 0) {
        failed = true;
        const relativeFile = path.relative(rootDir, file);
        console.error(`Syntax check failed: ${relativeFile}`);
        if (result.stderr) console.error(result.stderr.trim());
        if (result.stdout) console.error(result.stdout.trim());
    }
}

if (failed) {
    process.exit(1);
}

console.log(`Build check passed: ${files.length} JavaScript files validated.`);
