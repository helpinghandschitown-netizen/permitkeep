import { canonicalize, decodeEnvelope, fromBase64Url } from './crypto.mjs';

const PUBLIC_KEY = {"key_ops":["verify"],"ext":true,"kty":"EC","x":"vqkAvvrZdOOYvz8bfUHOTOq33lClPLC7vl2xJ0dsBF0","y":"DEdNYip0T9ZCrfyTDPz8j-JAbeXGB-Rsg6gJKR35BxI","crv":"P-256"};
const encoder = new TextEncoder();

export const LICENSE_STORAGE_KEY = 'permitkeep.license.v1';

export async function verifyLicenseCode(code) {
  try {
    const envelope = decodeEnvelope(code);
    if (envelope?.kind !== 'permitkeep-license' || envelope?.protocol !== 1 || !envelope.license || !envelope.signature) return null;
    const key = await crypto.subtle.importKey('jwk', PUBLIC_KEY, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const unsigned = { kind: envelope.kind, protocol: envelope.protocol, license: envelope.license };
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64Url(envelope.signature), encoder.encode(canonicalize(unsigned)));
    if (!valid || envelope.license.product !== 'permitkeep-pro-v1' || envelope.license.grant !== 'lifetime-v1') return null;
    if (!envelope.license.licenseId || !envelope.license.orderRef || !envelope.license.issuedAt) return null;
    if (String(envelope.license.licenseId).length > 100 || String(envelope.license.orderRef).length > 200 || Number.isNaN(Date.parse(envelope.license.issuedAt))) return null;
    return envelope.license;
  } catch {
    return null;
  }
}

export async function loadLicense(storage = globalThis.localStorage) {
  const code = storage?.getItem(LICENSE_STORAGE_KEY) || '';
  return { code, license: await verifyLicenseCode(code) };
}

export function saveLicense(code, storage = globalThis.localStorage) {
  storage?.setItem(LICENSE_STORAGE_KEY, String(code).trim());
}
