import { createMemoizedLoader } from '../lazy-load';

const loader = createMemoizedLoader(() => import('@simplewebauthn/server'));

/** @simplewebauthn/server 连带 @peculiar/asn1-*、tiny-cbor 等，只在首次通行密钥仪式/验签时加载。 */
export function loadWebAuthn() {
  return loader.load();
}

export function peekWebAuthn() {
  return loader.peek();
}

export function resetWebAuthnLoaderForTests() {
  loader.reset();
}
