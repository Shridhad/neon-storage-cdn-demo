import { createRemoteJWKSet, jwtVerify } from 'jose';

// Neon Auth signs with EdDSA only; pinning it rules out alg-confusion downgrades.
const ALGORITHMS = ['EdDSA'];

// The id becomes a path segment of the object key, so anything outside this set is refused.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

// Verification failures that mean "this token is bad". Anything else (JWKS unreachable, timeouts) is rethrown
// so the caller answers 503 instead of telling a valid user their token is invalid.
const BAD_TOKEN = new Set([
  'ERR_JWT_EXPIRED',
  'ERR_JWT_INVALID',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
]);

// createRemoteJWKSet caches the key set and re-fetches when a token carries an unknown kid (key rotation).
const jwksByUrl = new Map();
export const resetJwks = () => jwksByUrl.clear();

function keySet(url) {
  if (!jwksByUrl.has(url)) jwksByUrl.set(url, createRemoteJWKSet(new URL(url)));
  return jwksByUrl.get(url);
}

// Returns { id, email } for a valid Neon Auth JWT in `Authorization: Bearer`, or null for a missing or invalid one.
export async function authenticate(request, env) {
  if (!env.NEON_AUTH_JWKS_URL || !env.NEON_AUTH_ISSUER || !env.NEON_AUTH_AUDIENCE) {
    throw new Error('Neon Auth is not configured (run setup-auth.sh)');
  }
  const token = /^Bearer (\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, keySet(env.NEON_AUTH_JWKS_URL), {
      issuer: env.NEON_AUTH_ISSUER,
      audience: env.NEON_AUTH_AUDIENCE,
      algorithms: ALGORITHMS,
      requiredClaims: ['sub', 'exp'],
    });
    if (!SAFE_ID.test(payload.sub)) return null;
    return { id: payload.sub, email: payload.email };
  } catch (err) {
    if (BAD_TOKEN.has(err?.code)) return null;
    throw err;
  }
}
