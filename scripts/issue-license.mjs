import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalize, encodeEnvelope, toBase64Url } from '../src/crypto.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((item, index, all) => item.startsWith('--') ? [item.slice(2), all[index + 1]] : null).filter(Boolean));
if (!args.order || !args.license) {
  console.error('Usage: node scripts/issue-license.mjs --order "Opaque Stripe session reference" --license "Opaque fulfillment ID"');
  process.exit(2);
}

const keyPath = process.env.PERMITKEEP_LICENSE_PRIVATE_KEY || path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'secrets', 'permitkeep-license-private.jwk');
const privateJwk = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
const license = {
  product: 'permitkeep-pro-v1',
  grant: 'lifetime-v1',
  licenseId: String(args.license).trim(),
  orderRef: String(args.order).trim(),
  issuedAt: new Date().toISOString(),
};
const unsigned = { kind: 'permitkeep-license', protocol: 1, license };
const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(canonicalize(unsigned)));
console.log(encodeEnvelope({ ...unsigned, signature: toBase64Url(new Uint8Array(signature)) }));
