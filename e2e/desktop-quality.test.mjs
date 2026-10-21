import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPlacement, countRepeats, desktopQuality, echoSummary, latencySummary,
  parseConnectTimes, parseIpinfo, percentile, qualityChecks,
  QUALITY_STEP_IDS, TYPING_TEXT } from './desktop-quality.mjs';

test('ipinfo keeps egress fields without inferring compute placement', () => {
  assert.deepEqual(parseIpinfo('{"ip":"203.0.113.8","org":"AS64500 Example","city":"Singapore","region":"Central","country":"SG"}'),
    { ip: '203.0.113.8', org: 'AS64500 Example', city: 'Singapore', region: 'Central', country: 'SG' });
  assert.equal(parseIpinfo('{"ip":"2001:db8::1"}').ip, '2001:db8::1');
  assert.equal(parseIpinfo('{"city":"  Mumbai  "}').city, 'Mumbai');
});

test('ipinfo rejects invalid JSON, IPs and non-string fields without inventing data', () => {
  const empty = { ip: null, org: null, city: null, region: null, country: null };
  for (const value of ['', '<html>error</html>', 'null', '[]', '{"error":"rate limited"}',
    '{"ip":"999.1.1.1","city":32,"org":{},"region":" ","country":false}']) {
    assert.deepEqual(parseIpinfo(value), empty);
  }
});

test('nearest-rank latency percentiles handle 10 samples, empty and invalid samples', () => {
  const values = [10, 2, 9, 1, 4, 6, 5, 3, 8, 7];
  assert.equal(percentile(values, 50), 5);
  assert.equal(percentile(values, 95), 10);
  assert.equal(percentile(values, 0), 1);
  assert.equal(percentile(values, 100), 10);
  assert.deepEqual(values, [10, 2, 9, 1, 4, 6, 5, 3, 8, 7]);
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([NaN, -1, Infinity, null, '8', 0, 0.5], 95), 0.5);
  assert.deepEqual(latencySummary([1.5]), { samplesMs: [1.5], p50Ms: 1.5, p95Ms: 1.5, percentileMethod: 'nearest-rank' });
  for (const invalid of [-1, 101, NaN, '95']) assert.throws(() => percentile(values, invalid), RangeError);
});

test('repeat counting uses literal Unicode code points and preserves bounds', () => {
  assert.equal(countRepeats('', 'q'), 0);
  assert.equal(countRepeats('qqxqq', 'q'), 4);
  assert.equal(countRepeats('..a.', '.'), 3);
  assert.equal(countRepeats('🙂🙂é🙂', '🙂'), 3);
  assert.equal(countRepeats('éé e\u0301', 'é'), 2);
  for (const count of [1, 2, 59, 60]) assert.equal(countRepeats('q'.repeat(count), 'q'), count);
  for (const key of ['', 'qq', null]) assert.throws(() => countRepeats('q', key), TypeError);
});

test('typing fixture has exactly 200 characters and all requested scripts', () => {
  assert.equal(TYPING_TEXT.length, 200);
  assert.equal([...TYPING_TEXT].length, 200);
  for (const text of ['Az09', 'é', 'ß', 'ñ', '日本語', 'हिन्दी']) assert.ok(TYPING_TEXT.includes(text));
});

test('echo timing never reports an earlier key as the final character', () => {
  const inputs = [{ prefix: 'a', echoMs: 3 }, { prefix: 'ab', echoMs: 5 }];
  assert.equal(echoSummary(inputs, 'ab', 30).lastCharacterEchoMs, 5);
  assert.equal(echoSummary(inputs, 'abc', 30).lastCharacterEchoMs, null);
  assert.equal(echoSummary([], 'abc', null).lastCharacterEchoMs, null);
  assert.equal(echoSummary([{ prefix: 'abc', echoMs: null }], 'abc', null).p95Ms, null);
  assert.equal(echoSummary(inputs, 'ab', 30).timeUntilLastCharacterMs, 30);
});

test('unreachable guest IMDS does not turn successful placement into a failure', async () => {
  const quality = desktopQuality({ codeReady: true, codeFrame: async () => ({ url: () => 'https://code-box-aws.example.test' }),
    terminalRun: async () => ({ exitCode: 0, text: 'IPINFO_RC=0\nIPINFO={"ip":"203.0.113.9","city":"Singapore"}\n'
      + 'DMI=Amazon EC2|c7i.large\nIMDS_RC=28\nIMDS=\nHOSTNAME=guest\nNPROC=4\nMem: 7800 800 7000\n' }) });
  const evidence = {};
  assert.equal(await quality.placement(evidence), null);
  assert.equal(evidence.egressLocation.city, 'Singapore');
  assert.equal(evidence.hostPlacement.hostClass, 'aws');
  assert.equal(evidence.hostPlacement.region, null);
  assert.equal(evidence.hostPlacement.imds.exitCode, 28);
});

test('host placement uses hostname and DMI, keeping absent IMDS region unknown', () => {
  const aws = classifyPlacement('https://code-box-aws.example.test', 'Amazon EC2|c7i.large', '');
  assert.equal(aws.hostClass, 'aws'); assert.equal(aws.region, null);
  assert.equal(aws.dmiVendor, 'Amazon EC2'); assert.equal(aws.dmiProduct, 'c7i.large');
  const cloudflare = classifyPlacement('https://guac-box.example.test', 'QEMU|Standard PC', '');
  assert.equal(cloudflare.hostClass, 'cloudflare'); assert.equal(cloudflare.dmiClass, 'other');
  assert.equal(classifyPlacement('https://box-nekodesktop.example.test').hostClass, 'cloudflare');
  assert.equal(classifyPlacement('https://code.example.test/guac-?q=-aws.', 'Amazon EC2').hostClass, 'aws');
  assert.equal(classifyPlacement('https://code.example.test/guac-?q=-aws.').hostClass, 'unknown');
  assert.equal(classifyPlacement('about:blank', 'Amazon EC2', 'ap-south-1').region, 'ap-south-1');
  assert.equal(classifyPlacement('https://code.example.test', '', 'Unauthorized').region, null);
  assert.equal(classifyPlacement('https://guac-box.example.test', 'Amazon EC2').conflict, true);
});

test('curl connect seconds become milliseconds, retaining failed observations', () => {
  assert.deepEqual(parseConnectTimes('0.012345\r\nCONNECT_RC=0\r\n0.000000\nCONNECT_RC=7\nE2E_RC=0'),
    [{ connectMs: 12.345, exitCode: 0 }, { connectMs: 0, exitCode: 7 }]);
  assert.deepEqual(parseConnectTimes("$ curl -w '%{time_connect}'\nCONNECT_RC=0\n1.2 seconds\nCONNECT_RC=0"), []);
  assert.deepEqual(parseConnectTimes('0.100000\nCONNECT_RC=0\n'.repeat(5)).map(item => item.connectMs), [100, 100, 100, 100, 100]);
});

test('component failures preserve sibling PASS/SKIP evidence before failing the step', async () => {
  const evidence = {};
  await assert.rejects(qualityChecks(evidence, {
    first: async data => { data.samplesMs = [5]; throw new Error('sample failed'); },
    second: async data => { data.exactEquality = true; },
    third: async () => 'unavailable',
  }), /first/);
  assert.equal(evidence.first.status, 'FAIL'); assert.deepEqual(evidence.first.evidence.samplesMs, [5]);
  assert.equal(evidence.second.status, 'PASS'); assert.equal(evidence.second.evidence.exactEquality, true);
  assert.equal(evidence.third.status, 'SKIP'); assert.equal(evidence.third.reason, 'unavailable');
  assert.equal(await qualityChecks({}, { skipped: async () => 'missing' }), 'incomplete:skipped');
  assert.equal(await qualityChecks({}, { passed: async () => null }), null);
});

test('all quality steps exist and missing Code skips without accessing browser APIs', async () => {
  const quality = desktopQuality({ codeReady: false, browserReady: false });
  assert.deepEqual(Object.keys(quality), QUALITY_STEP_IDS);
  for (const name of ['placement', 'typing']) assert.equal(await quality[name]({}), 'code_unavailable');
});

test('browser health samples continue when Code is unavailable, using the page realm', async () => {
  const calls = [];
  const page = { url: () => 'https://os-staging.ezil.work/os',
    evaluate: async (_callback, args) => {
      calls.push(args);
      return Array.from({ length: 10 }, (_, index) => ({ ms: index + 1, ok: true, httpStatus: 200 }));
    } };
  const evidence = {};
  const quality = desktopQuality({ page, codeReady: false });
  assert.equal(await quality.latency(evidence), 'incomplete:codeOrigin,guestAiConnect');
  assert.deepEqual(calls, [{ url: '/api/health', method: 'GET' }]);
  assert.equal(evidence.osHealth.status, 'PASS');
  assert.equal(evidence.osHealth.evidence.p95Ms, 10);
  assert.equal(evidence.guestAiConnect.reason, 'code_unavailable');
});
