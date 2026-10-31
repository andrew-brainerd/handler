import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveRoku, devCurl, requirePassword } from './roku.mjs';

const root = path.resolve(import.meta.dirname, '..');
const { values: opts } = parseArgs({
  args: process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === '--')),
  options: {
    roku: { type: 'string', default: process.env.ROKU_IP },
    password: { type: 'string' },
  },
});

const ip = await resolveRoku(opts.roku);
const password = requirePassword(opts.password);
const page = devCurl(ip, password, '/plugin_inspect', ['-F', 'mysubmit=Screenshot', '-F', 'archive=']).toString();
const src = page.match(/pkgs\/dev\.(jpg|png)(\?[^"']*)?/)?.[0] ?? 'pkgs/dev.jpg';
const image = devCurl(ip, password, `/${src}`, []);
const out = path.join(root, 'build', `screenshot${path.extname(src.split('?')[0])}`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, image);
console.log(out);
