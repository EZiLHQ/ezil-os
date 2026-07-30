/**
 * Unit tests for the redacted S3 workspace config validation harness.
 *
 * These tests never read or require actual credential VALUES — only
 * presence/absence of variable NAMES, and the disposable validation
 * prefix format. Safe to run without any S3 credentials configured.
 */

import { describe, expect, it } from 'bun:test';

import {
  buildValidationPrefix,
  checkWorkspaceEnvPresence,
  OPTIONAL_WORKSPACE_S3_VARS,
  REQUIRED_WORKSPACE_S3_VARS,
} from './validate-workspace-s3-config';

describe('REQUIRED_WORKSPACE_S3_VARS', () => {
  it('lists exactly the variable names consumed by resolveWorkspaceMountConfig() in the Worker', () => {
    expect(REQUIRED_WORKSPACE_S3_VARS).toEqual([
      'SANDBOX_WORKSPACE_S3_ENDPOINT',
      'SANDBOX_WORKSPACE_S3_BUCKET',
      'SANDBOX_WORKSPACE_S3_ACCESS_KEY_ID',
      'SANDBOX_WORKSPACE_S3_SECRET_ACCESS_KEY',
    ]);
  });
});

describe('checkWorkspaceEnvPresence', () => {
  it('reports all required vars absent when none are set', () => {
    const results = checkWorkspaceEnvPresence({});
    const required = results.filter((r) => r.required);
    expect(required).toHaveLength(REQUIRED_WORKSPACE_S3_VARS.length);
    expect(required.every((r) => r.present === false)).toBe(true);
  });

  it('reports a required var present without exposing its value', () => {
    const fakeEnv = { SANDBOX_WORKSPACE_S3_BUCKET: 'some-secret-bucket-name' };
    const results = checkWorkspaceEnvPresence(fakeEnv);
    const bucket = results.find((r) => r.name === 'SANDBOX_WORKSPACE_S3_BUCKET');
    expect(bucket?.present).toBe(true);
    // The presence record must never carry the raw value.
    expect(JSON.stringify(bucket)).not.toContain('some-secret-bucket-name');
  });

  it('reports optional vars separately from required vars', () => {
    const results = checkWorkspaceEnvPresence({});
    const optionalNames = results.filter((r) => !r.required).map((r) => r.name);
    expect(optionalNames).toEqual([...OPTIONAL_WORKSPACE_S3_VARS]);
  });

  it('treats whitespace-only values as absent', () => {
    const results = checkWorkspaceEnvPresence({ SANDBOX_WORKSPACE_S3_ENDPOINT: '   ' });
    const endpoint = results.find((r) => r.name === 'SANDBOX_WORKSPACE_S3_ENDPOINT');
    expect(endpoint?.present).toBe(false);
  });
});

describe('buildValidationPrefix', () => {
  it('builds the documented `/__ezil_validation__/<runId>` prefix format', () => {
    expect(buildValidationPrefix('run-123')).toBe('/__ezil_validation__/run-123');
  });

  it('strips unsafe characters from the runId', () => {
    expect(buildValidationPrefix('run/../../etc')).toBe('/__ezil_validation__/runetc');
  });

  it('throws when the runId is empty after sanitization', () => {
    expect(() => buildValidationPrefix('///')).toThrow();
  });
});
