import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalize, encodeEnvelope, toBase64Url } from '../src/crypto.mjs';
import { verifyLicenseCode } from '../src/license.mjs';

const privateKeyPath = process.env.PERMITKEEP_LICENSE_PRIVATE_KEY || path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'secrets', 'permitkeep-license-private.jwk');

async function signedCode(overrides = {}) {
  const privateJwk = JSON.parse(fs.readFileSync(privateKeyPath, 'utf8'));
  const license = {
    product: 'permitkeep-pro-v1',
    grant: 'lifetime-v1',
    licenseId: 'lic_test_opaque',
    orderRef: 'cs_test_opaque',
    issuedAt: '2026-09-02T18:00:00.000Z',
    ...overrides,
  };
  const unsigned = { kind: 'permitkeep-license', protocol: 1, license };
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(canonicalize(unsigned)));
  return encodeEnvelope({ ...unsigned, signature: toBase64Url(new Uint8Array(signature)) });
}

test('valid PermitKeep Pro code verifies locally', async () => {
  const license = await verifyLicenseCode(await signedCode());
  assert.equal(license?.product, 'permitkeep-pro-v1');
  assert.equal(license?.orderRef, 'cs_test_opaque');
});

test('tampered and cross-product codes fail closed', async () => {
  const valid = await signedCode();
  assert.equal(await verifyLicenseCode(`${valid.slice(0, -1)}A`), null);
  assert.equal(await verifyLicenseCode(await signedCode({ product: 'another-product' })), null);
  assert.equal(await verifyLicenseCode('not-a-license'), null);
});
