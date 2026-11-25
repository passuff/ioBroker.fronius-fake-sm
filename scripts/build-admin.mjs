import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcAdmin = join(root, 'src-admin');
const outCustom = join(root, 'admin', 'custom');

function run(cmd, args, cwd) {
    const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: true });
    if (r.status !== 0) {
        process.exit(r.status || 1);
    }
}

if (!existsSync(join(srcAdmin, 'node_modules'))) {
    run('npm', ['install'], srcAdmin);
}
run('npm', ['run', 'build'], srcAdmin);

rmSync(outCustom, { recursive: true, force: true });
mkdirSync(outCustom, { recursive: true });

const build = join(srcAdmin, 'build');
cpSync(join(build, 'customComponents.js'), join(outCustom, 'customComponents.js'));
if (existsSync(join(build, 'customComponents.js.map'))) {
    cpSync(join(build, 'customComponents.js.map'), join(outCustom, 'customComponents.js.map'));
}
if (existsSync(join(build, 'mf-manifest.json'))) {
    cpSync(join(build, 'mf-manifest.json'), join(outCustom, 'mf-manifest.json'));
}
if (existsSync(join(build, 'assets'))) {
    cpSync(join(build, 'assets'), join(outCustom, 'assets'), { recursive: true });
}
const staticJs = join(build, 'static', 'js');
if (existsSync(staticJs)) {
    mkdirSync(join(outCustom, 'static', 'js'), { recursive: true });
    cpSync(staticJs, join(outCustom, 'static', 'js'), { recursive: true });
}
cpSync(join(srcAdmin, 'src', 'i18n'), join(outCustom, 'i18n'), { recursive: true });
console.log('admin/custom updated');
