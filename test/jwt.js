import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AUTH_ORIGIN } from './helpers.js';

export const USER_ID = '5456cdbe-a125-4990-80ab-791fb10331ef';
const KID = '361ea6f9-5432-4003-8240-08729459c851';

// Neon Auth signs EdDSA (Ed25519) JWTs and publishes the key at /.well-known/jwks.json.
export async function makeIssuer() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), alg: 'EdDSA', kid: KID }] };

  async function sign({ sub = USER_ID, iss = AUTH_ORIGIN, aud = AUTH_ORIGIN, exp = '15m', key = privateKey, extra = {} } = {}) {
    return new SignJWT({ email: 'probe@example.com', role: 'authenticated', id: sub, ...extra })
      .setProtectedHeader({ alg: 'EdDSA', kid: KID })
      .setSubject(sub)
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(key);
  }
  return { jwks, sign };
}

export async function otherKey() {
  return (await generateKeyPair('EdDSA', { crv: 'Ed25519' })).privateKey;
}
