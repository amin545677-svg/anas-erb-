import fs from 'node:fs';
import crypto from 'node:crypto';

export const STAGING_PROJECT_ID = 'anas-erp-staging-a25e1';

function repairPrivateKeyNewlines(jsonText) {
  // Repair only literal CR/LF characters inside the JSON string value for private_key.
  // All other JSON syntax and string values remain byte-for-byte unchanged.
  let out = '';
  let inString = false;
  let escaped = false;
  let keyBuffer = '';
  let currentKey = '';
  let valueString = false;
  let valueEscaped = false;
  let pending = '';
  for (let i = 0; i < jsonText.length; i++) {
    const ch = jsonText[i];
    if (!inString) {
      if (ch === '"') {
        inString = true;
        keyBuffer = '';
        pending = '';
        valueString = false;
        valueEscaped = false;
      }
      out += ch;
      continue;
    }
    if (escaped) {
      if (!valueString && ch !== '"' && ch !== '\\\\') keyBuffer += '\\\\' + ch;
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\\\') {
      escaped = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      if (currentKey === 'private_key' && valueString) valueString = false;
      continue;
    }
    if (ch === ':' && !valueString) {
      currentKey = keyBuffer;
      out += ch;
      continue;
    }
    if (ch === '\\n' || ch === '\\r') {
      if (currentKey === 'private_key' && valueString) {
        if (ch === '\\r' && jsonText[i + 1] === '\\n') i++;
        out += '\\\\n';
        continue;
      }
      throw new Error('credential JSON contains an unescaped control character');
    }
    if (currentKey === 'private_key' && !valueString && !/\\s/.test(ch)) valueString = true;
    if (!valueString) keyBuffer += ch;
    out += ch;
  }
  return out;
}

export function decodeServiceAccountInput(input) {
  const trimmed = String(input ?? '').replace(/^\uFEFF/, '').trim();
  if (!trimmed) return null;

  let jsonText;
  if (trimmed.startsWith('{')) {
    jsonText = trimmed;
  } else {
    const compact = trimmed.replace(/\s+/g, '');
    if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 === 1) {
      throw new Error('credential is neither JSON nor valid Base64');
    }
    const decoded = Buffer.from(compact, 'base64');
    const canonical = decoded.toString('base64').replace(/=+$/, '');
    if (canonical !== compact.replace(/=+$/, '')) throw new Error('credential Base64 encoding is invalid');
    jsonText = decoded.toString('utf8').replace(/^\uFEFF/, '').trim();
  }

  let credential;
  try { credential = JSON.parse(jsonText); }
  catch { throw new Error('decoded credential is not valid JSON'); }

  if (
    credential?.type !== 'service_account' ||
    credential?.project_id !== STAGING_PROJECT_ID ||
    typeof credential?.client_email !== 'string' ||
    !/^[^@\s]+@anas-erp-staging-a25e1\.iam\.gserviceaccount\.com$/.test(credential.client_email) ||
    typeof credential?.private_key !== 'string' ||
    !credential.private_key.includes('-----BEGIN PRIVATE KEY-----') ||
    !credential.private_key.includes('-----END PRIVATE KEY-----')
  ) throw new Error('credential identity or private-key structure is not valid for isolated staging');

  for (const line of credential.private_key.split(/\r?\n/)) {
    if (line) process.stdout.write('::add-mask::' + line + '\n');
  }
  return { jsonText, credential };
}

export function validateOidc(provider, deployer) {
  return /^projects\/[^/]+\/locations\/global\/workloadIdentityPools\/[^/]+\/providers\/[^/]+$/.test(provider) &&
    /^[^@\s]+@anas-erp-staging-a25e1\.iam\.gserviceaccount\.com$/.test(deployer);
}

export function writeGithubEnv(name, value, target = process.env.GITHUB_ENV) {
  if (!target) throw new Error('GITHUB_ENV is unavailable');
  const delimiter = 'ANAS_STAGING_' + crypto.randomUUID().replace(/-/g, '');
  fs.appendFileSync(target, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export function prepareCredential({ input, provider = '', deployer = '', githubEnv, githubOutput }) {
  if (String(input ?? '').trim()) {
    const { jsonText, credential } = decodeServiceAccountInput(input);
    writeGithubEnv('STAGING_SERVICE_ACCOUNT_JSON', jsonText, githubEnv);
    if (githubOutput) fs.appendFileSync(githubOutput, 'auth_mode=json\n');
    return { mode: 'json', projectId: credential.project_id };
  }
  if (provider && deployer && validateOidc(provider, deployer)) {
    if (githubOutput) fs.appendFileSync(githubOutput, 'auth_mode=oidc\n');
    return { mode: 'oidc', projectId: STAGING_PROJECT_ID };
  }
  throw new Error('configure the staging Environment service-account secret (JSON or Base64), or both staging OIDC variables');
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
    const raw = String(process.env.DEPLOY_SERVICE_ACCOUNT_INPUT ?? '').trim();\n    const base64Detected = raw.length > 0 && !raw.startsWith('{');\n    const firstCode = raw.length ? raw.charCodeAt(0) : null;\n    const lastCode = raw.length ? raw.charCodeAt(raw.length - 1) : null;\n    console.error('STAGING PREFLIGHT DIAGNOSTIC: length=' + raw.length + ', firstCharCode=' + firstCode + ', lastCharCode=' + lastCode + ', isBase64Detected=' + base64Detected);\n    console.error('STAGING PREFLIGHT: ' + error.message);
    process.exit(1);
  }
}
