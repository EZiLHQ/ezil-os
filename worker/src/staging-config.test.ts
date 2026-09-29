import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { appPortFor, codePortFor, portFor } from './desktop-mode';

interface WorkerConfig {
  name: string;
  vars: Record<string, string>;
  routes: Array<{ pattern: string; zone_name: string }>;
  containers: Array<{ name?: string; class_name: string; image: string; max_instances: number }>;
  durable_objects: { bindings: Array<{ name: string; class_name: string; script_name?: string }> };
  migrations: Array<{ tag: string; new_sqlite_classes: string[] }>;
  r2_buckets: Array<{ binding: string; bucket_name: string }>;
}

const config = Bun.TOML.parse(readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')) as
  WorkerConfig & { env: { staging: WorkerConfig } };
const staging = config.env.staging;

describe('staging Worker resources and routes', () => {
  it('uses its own Worker, container application and local Sandbox namespace', () => {
    expect(staging.name).toBe('ezil-os-worker-staging');
    expect(staging.name).not.toBe(config.name);
    expect(staging.durable_objects.bindings).toEqual([{ name: 'Sandbox', class_name: 'Sandbox' }]);
    expect(staging.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['Sandbox'] }]);
    expect(staging.containers).toHaveLength(1);
    expect(staging.containers[0].name).toBe('ezil-os-worker-staging-sandbox');
    expect(staging.containers[0].class_name).toBe('Sandbox');
    expect(staging.containers[0].image).toBe(config.containers[0].image);
    expect(staging.containers[0].max_instances).toBeGreaterThan(0);
    for (const container of config.containers) {
      expect(staging.containers[0].name).not.toBe(container.name);
    }
  });

  it('binds separate workspace and telemetry buckets, neither shared with production', () => {
    expect(staging.r2_buckets).toEqual([
      { binding: 'SANDBOX_WORKSPACE_R2_BUCKET', bucket_name: 'ezil-sandbox-workspaces-staging' },
      { binding: 'TELEMETRY_R2_BUCKET', bucket_name: 'ezil-telemetry-spool-staging' },
    ]);
    const productionBuckets = config.r2_buckets.map((bucket) => bucket.bucket_name);
    for (const bucket of staging.r2_buckets) expect(productionBuckets).not.toContain(bucket.bucket_name);
  });

  it('explicitly configures neko with relay-only ICE and the separate bare zone', () => {
    expect(staging.vars).toEqual({
      SANDBOX_PREVIEW_ZONE_ROOT: 'ezil.work',
      SANDBOX_DEFAULT_DESKTOP_MODE: 'neko',
      SANDBOX_NEKO_ICE_POLICY: 'relay',
    });
  });

  it('covers the API and every preview token without claiming a zone catch-all', () => {
    const root = staging.vars.SANDBOX_PREVIEW_ZONE_ROOT;
    const tokens = [portFor('guacamole').token, portFor('neko').token,
      appPortFor('neko')!.token, codePortFor('neko')!.token];
    const expected = ['api-desktop-staging.ezil.work/*', ...tokens.map((token) => `*-${token}.${root}/*`)];
    expect(staging.routes.map((route) => route.pattern).sort()).toEqual(expected.sort());
    const productionZones = config.routes.map((route) => route.zone_name);
    const productionPatterns = config.routes.map((route) => route.pattern);
    for (const route of staging.routes) {
      expect(route.zone_name).toBe(root);
      expect(productionZones).not.toContain(route.zone_name);
      expect(productionPatterns).not.toContain(route.pattern);
    }
  });
});
