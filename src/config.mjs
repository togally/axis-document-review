import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { AliyunOssDocumentProvider, LocalProjectDocumentProvider } from './core.mjs';

function unavailableProvider({ id, label, error }) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    id,
    label,
    type: 'aliyun-oss',
    async listDocuments() {
      throw new Error(message);
    },
    async readDocument() {
      throw new Error(message);
    },
  };
}

async function readYaml(filePath) {
  return YAML.parse(await readFile(filePath, 'utf8')) ?? {};
}

function resolveOssProfile(config, registry) {
  const inline = config.oss ?? {};
  if (inline.bucket) return inline;
  const organizationId = config.organization?.id;
  const profileName = inline.profile;
  const organization = registry.organizations?.find((item) => item.id === organizationId);
  const profile = organization?.oss_profiles?.find((item) => item.name === profileName);
  if (!profile) {
    throw new Error(`OSS profile not found: ${organizationId ?? 'unknown'}/${profileName ?? 'unknown'}`);
  }
  return profile;
}

function requiredEnv(env, name, label) {
  if (!name) return undefined;
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (${label})`);
  return value;
}

function createDefaultOssClient(profile, env) {
  const require = createRequire(import.meta.url);
  const OSS = require('ali-oss');
  return new OSS({
    region: requiredEnv(env, profile.region_env, 'region'),
    endpoint: requiredEnv(env, profile.endpoint_env, 'endpoint'),
    accessKeyId: requiredEnv(env, profile.access_key_id_env, 'access key id'),
    accessKeySecret: requiredEnv(env, profile.access_key_secret_env, 'access key secret'),
    stsToken: profile.security_token_env ? env[profile.security_token_env] : undefined,
    bucket: profile.bucket,
  });
}

export async function createProvidersFromProject({
  repo,
  source = 'all',
  env = process.env,
  ossClientFactory = createDefaultOssClient,
} = {}) {
  if (!repo) throw new Error('Project repository path is required');
  if (!['all', 'local', 'oss'].includes(source)) throw new Error('source must be one of: all, local, oss');
  const root = path.resolve(repo);
  const providers = [];
  if (source === 'all' || source === 'local') {
    providers.push(new LocalProjectDocumentProvider({ repo: root, bucket: 'local-workspace' }));
  }
  if (source === 'all' || source === 'oss') {
    try {
      const config = await readYaml(path.join(root, '.axis', 'config.yml'));
      const registryPath = path.resolve(root, config.organization?.registry ?? '.axis/organizations.yml');
      const registry = await readYaml(registryPath);
      const profile = resolveOssProfile(config, registry);
      const id = `oss:${profile.bucket}:${profile.prefix || 'root'}`;
      providers.push(new AliyunOssDocumentProvider({
        id,
        label: `OSS · ${profile.bucket}`,
        bucket: profile.bucket,
        prefix: profile.prefix ?? '',
        client: ossClientFactory(profile, env),
      }));
    } catch (error) {
      providers.push(unavailableProvider({ id: 'oss:unavailable', label: 'OSS · 配置不可用', error }));
    }
  }
  return providers;
}
