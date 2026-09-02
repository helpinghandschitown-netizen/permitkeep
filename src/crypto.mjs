const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
  return base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function fromBase64Url(value) {
  const normalized = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/u.test(normalized)) throw new Error('Invalid encoded value.');
  const padded = normalized.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('binary');
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function encodeEnvelope(value) {
  return toBase64Url(encoder.encode(JSON.stringify(value)));
}

export function decodeEnvelope(value) {
  const input = String(value || '').trim();
  if (!input || input.length > 120000) throw new Error('License code is empty or too large.');
  return JSON.parse(decoder.decode(fromBase64Url(input)));
}
