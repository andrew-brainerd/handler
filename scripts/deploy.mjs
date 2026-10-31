import { parseArgs } from 'node:util';
import { resolveRoku, localAddressFor, requirePassword, buildChannelZip, installZip } from './roku.mjs';

const { values: opts } = parseArgs({
  args: process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === '--')),
  options: {
    roku: { type: 'string', default: process.env.ROKU_IP },
    password: { type: 'string' },
    relay: { type: 'string', default: process.env.TALLY_RELAY_URL },
    port: { type: 'string', default: '8790' },
    'zip-only': { type: 'boolean', default: false },
  },
});

const zipOnly = opts['zip-only'];
const ip = zipOnly && !opts.roku ? null : await resolveRoku(opts.roku);
const relayUrl = opts.relay ?? (ip && `http://${localAddressFor(ip)}:${opts.port}`);
if (!relayUrl) throw new Error('Pass --relay <url> when using --zip-only without --roku.');

const zip = buildChannelZip(relayUrl);
if (zipOnly) process.exit(0);
await installZip(ip, requirePassword(opts.password), zip);
