import fs from 'node:fs';
import crypto from 'node:crypto';

const STAGING_PROJECT_ID = 'anas-erp-staging-a25e1';

export function decodeServiceAccountInput(input) {
  const trimmed = String(input ?? '').replace(/^\uFEFF/, '').trim();
  if (!trimmed) return null;

  function parseCredentialJson(candidate, depth = 0) {
    const text = String(candidate ?? '').replace(/^\uFEFF/, '').trim();
    if (!text) throw new Error('credential payload is empty');

    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === 'string' && depth < 2) return parseCredentialJson(parsed, depth + 1);
      return parsed;
    } catch (firstError) {
      // Repair literal line breaks only while inside JSON string values. This
      // accommodates mobile-pasted PEM keys without changing JSON structure.
      let repaired = '';
      let inString = false;
      let escaped = false;
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (inString && ch.charCodeAt(0) < 0x20) {
          if (ch === '\n' || ch === '\r') {
            repaired += '\\n';
            if (ch === '\r' && text[i + 1] === '\n') i += 1;
          } else if (ch === '\t') repaired += '\\t';
          else if (ch === '\b') repaired += '\\b';
          else if (ch === '\f') repaired += '\\f';
          else repaired += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
          escaped = false;
          continue;
        }
        repaired += ch;
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
        } else if (ch === '"') {
          inString = true;
        }
      }
      let repairError;
      try {
        const parsed = JSON.parse(repaired);
        if (typeof parsed === 'string' && depth < 2) return parseCredentialJson(parsed, depth + 1);
        return parsed;
      } catch (error) {
        repairError = error;
      }
      // Some mobile encoders wrap a Base64 payload inside another Base64
      // layer. Decode at most twice, then rely on strict identity checks.
      const compact = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
      if (depth < 2 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.length % 4 !== 1) {
        const padded = compact + '='.repeat((4 - compact.length % 4) % 4);
        const decoded = Buffer.from(padded, 'base64').toString('utf8');
        if (decoded && decoded !== text) return parseCredentialJson(decoded, depth + 1);
      }
      throw new Error('decoded credential is not valid JSON (' + String(repairError?.message || firstError?.message || 'parse error').slice(0, 180) + '); verify the secret contains service-account JSON or Base64-encoded JSON');
    }
  }

  let jsonText = trimmed;
  let credential;
  if (!trimmed.startsWith('{')) {
    const compact = trimmed.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 === 1) {
      throw new Error('credential is neither JSON nor valid Base64');
    }
    const padded = compact + '='.repeat((4 - compact.length % 4) % 4);
    jsonText = Buffer.from(padded, 'base64').toString('utf8').replace(/^\uFEFF/, '').trim();
  }
  credential = parseCredentialJson(jsonText);
  // Pass canonical JSON to auth@v2; this also repairs literal PEM line breaks.
  jsonText = JSON.stringify(credential);

  if (
    credential?.type !== 'service_account' ||
    credential?.project_id !== STAGING_PROJECT_ID ||
    typeof credential?.client_email !== 'string' ||
    !/^[^@\s]+@anas-erp-staging-a25e1\.iam\.gserviceaccount\.com$/.test(credential.client_email) ||
    typeof credential?.private_key !== 'string' ||
    !credential.private_key.includes('-----BEGIN PRIVATE KEY-----') ||
    !credential.private_key.includes('-----END PRIVATE KEY-----')
  ) {
    throw new Error('credential identity or private-key structure is not valid for isolated staging');
  }

  for (const line of credential.private_key.split(/\r?\n/)) {
    if (line) process.stdout.write('::add-mask::' + line + '\n');
  }
  return { jsonText, credential };
}

export function validateOidc(provider, deployer) {
  return /^projects\/[^/]+\/locations\/global\/workloadIdentityPools\/[^/]+\/providers\/[^/]+$/.test(provider) &&
    /^[^@\s]+@anas-erp-staging-a25e1\.iam\.gserviceaccount\.com$/.test(deployer);
}

function writeGithubEnv(name, value, target = process.env.GITHUB_ENV) {
  if (!target) throw new Error('GITHUB_ENV is unavailable');
  const delimiter = 'ANAS_STAGING_' + crypto.randomUUID().replace(/-/g, '');
  fs.appendFileSync(target, name + '<<' + delimiter + '\n' + value + '\n' + delimiter + '\n');
}

export function prepareCredential({ input, provider = '', deployer = '', githubEnv, githubOutput }) {
  const hasOidcFallback = Boolean(provider && deployer && validateOidc(provider, deployer));
  if (String(input ?? '').trim()) {
    try {
      const { jsonText, credential } = decodeServiceAccountInput(input);
      writeGithubEnv('STAGING_SERVICE_ACCOUNT_JSON', jsonText, githubEnv);
      if (githubOutput) fs.appendFileSync(githubOutput, 'auth_mode=json\n');
      return { mode: 'json', projectId: credential.project_id };
    } catch (error) {
      // A malformed legacy secret must not block a separately configured,
      // staging-bound OIDC identity. The identity guard validates the actual
      // authenticated principal and project again before any deployment.
      if (!hasOidcFallback) throw error;
    }
  }

  if (hasOidcFallback) {
    if (githubOutput) fs.appendFileSync(githubOutput, 'auth_mode=oidc\n');
    return { mode: 'oidc', projectId: STAGING_PROJECT_ID };
  }

  throw new Error('configure a valid staging service-account secret (JSON or Base64), or both staging OIDC variables');
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    const result = prepareCredential({
      input: process.env.DEPLOY_SERVICE_ACCOUNT_INPUT,
      provider: process.env.WIF_PROVIDER,
      deployer: process.env.DEPLOYER_SERVICE_ACCOUNT
    });
    console.log('STAGING AUTH MODE: ' + (result.mode === 'json' ? 'service-account JSON (raw or Base64)' : 'OIDC fallback'));
  } catch (error) {
    const raw = String(process.env.DEPLOY_SERVICE_ACCOUNT_INPUT ?? '').trim();
    const firstChar = raw.length ? raw[0] : '<empty>';
    const lastChar = raw.length ? raw[raw.length - 1] : '<empty>';
    const isBase64Detected = raw.length > 0 && !raw.startsWith('{');
    console.error('STAGING PREFLIGHT DIAGNOSTIC: length=' + raw.length +
      ', firstChar=' + JSON.stringify(firstChar) +
      ', lastChar=' + JSON.stringify(lastChar) +
      ', isBase64Detected=' + isBase64Detected);
    console.error('STAGING PREFLIGHT: ' + error.message);
    process.exit(1);
  }
}
