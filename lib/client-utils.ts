export function encodePassphrase(passphrase: string) {
  return encodeURIComponent(passphrase);
}

export function decodePassphrase(base64String: string) {
  return decodeURIComponent(base64String);
}

export function generateRoomId(): string {
  return `${randomString(4)}-${randomString(4)}`;
}

export function randomString(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const n = alphabet.length;

  // 우선 Web Crypto 사용 (브라우저/Node18+ 지원)
  const webCrypto: Crypto | undefined =
    typeof globalThis !== 'undefined' && (globalThis as any).crypto
      ? (globalThis as any).crypto
      : undefined;

  if (webCrypto && typeof (webCrypto as any).getRandomValues === 'function') {
    const out: string[] = new Array(length);
    const bytes = new Uint8Array(length);
    (webCrypto as any).getRandomValues(bytes);
    for (let i = 0; i < length; i++) out[i] = alphabet[bytes[i] % n];
    return out.join('');
  }

  // 폴백: Node crypto 또는 Math.random (마지막 수단)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodeCrypto = require('crypto');
    const bytes: Buffer = nodeCrypto.randomBytes(length);
    let s = '';
    for (let i = 0; i < length; i++) s += alphabet[bytes[i] % n];
    return s;
  } catch {
    let s = '';
    for (let i = 0; i < length; i++) s += alphabet[Math.floor(Math.random() * n)];
    return s;
  }
}
