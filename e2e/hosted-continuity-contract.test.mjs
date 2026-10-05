import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const source=readFileSync(new URL('./hosted-continuity.mjs',import.meta.url),'utf8');
test('missing isolated computer exits nonzero and names the prerequisite before cloud access',()=>{
    const directory=mkdtempSync(join(tmpdir(),'ezil-missing-prerequisite-'));
    try {
        const env={...process.env,EZIL_E2E_APP:'https://os.ezil.org',EZIL_CONTINUITY_MODE:'short'};
        delete env.EZIL_E2E_COMPUTER_ID;
        const result=spawnSync(process.execPath,[fileURLToPath(new URL('./hosted-continuity.mjs',import.meta.url))],{
            cwd:directory,env,encoding:'utf8',timeout:10000,
        });
        assert.equal(result.status,1);
        const evidence=JSON.parse(readFileSync(join(directory,'hosted-continuity-evidence/short.json'),'utf8'));
        assert.equal(evidence.ok,false);
        assert.equal(evidence.missingPrerequisite,'EZIL_E2E_COMPUTER_ID');
        assert.equal(evidence.failedPhase,'setup');
        assert.equal('deployment' in evidence,false);
    } finally { rmSync(directory,{recursive:true,force:true}); }
});
test('hosted telemetry artifact whitelists current navigation counters and enums',()=>{
    const script=source.match(/const continuityInit = (\(\) => \{[\s\S]*?)\n  };\n  await context.addInitScript/)[1]+'\n}';
    let listener;
    const frame={src:'https://viewer.example/?ezilAttempt=current',contentWindow:{}};
    const window={addEventListener:(_event,fn)=>listener=fn};
    vm.runInNewContext('('+script+')()',{window,document:{querySelector:()=>frame},URL,Number,Object});
    const raw={bytesReceived:100,framesDecoded:3,width:1280,height:720,connectionState:'connected',relayProtocol:'tcp',localCandidateType:'relay',credential:'secret',address:'private',token:'secret'};
    listener({source:frame.contentWindow,origin:'https://viewer.example',data:{source:'ezil-mobile',type:'stream_vitals',attempt:'current',vitals:raw}});
    assert.equal(window.__continuityVitals.length,1);
    const saved=window.__continuityVitals[0];
    assert.equal(saved.framesDecoded,3);assert.equal(saved.relayProtocol,'tcp');
    for(const key of ['credential','address','token'])assert.equal(key in saved,false);
    listener({source:frame.contentWindow,origin:'https://viewer.example',data:{source:'ezil-mobile',type:'stream_vitals',attempt:'old',vitals:raw}});
    assert.equal(window.__continuityVitals.length,1);
});
test('cloud scenarios permit normal UDP before separate TCP/TLS fallback and read committed checkpoint',()=>{
    const initial=source.match(/browser = await chromium.launch\(\{ args: launchArgs \}\)/);
    assert.ok(initial);
    assert.ok(source.includes("fallback = true; await launch('desktop'); await live()"));
    assert.ok(source.includes("['r2','object','get'"));
    assert.ok(source.includes("/.ezil-snapshots/latest.json"));
    assert.ok(source.includes("checkpoint.sha256"));
    assert.ok(source.includes("el.classList.contains('vs-dark')"));
    assert.ok(source.includes('EZIL_CONTINUITY_IDENTITY_APP || APP'));
    assert.equal((source.match(/verifyCloudDeployment\(identityEnv\)/g)||[]).length,2);
});
test('failure acceptance uses signed backend controls with explicit cleanup and real stop refusal',()=>{
    const helper=source.slice(source.indexOf('  const fault = async'),source.indexOf('  const selected = await'));
    assert.ok(helper.includes('createHmac'));
    assert.ok(helper.includes('/acceptance-fault'));
    assert.equal(helper.includes('page.evaluate'),false,'Signed secret must remain in Node process');
    assert.ok(source.includes("await fault('turn_unavailable')"));
    assert.ok(source.includes("await fault('checkpoint_write_failed')"));
    assert.ok(source.includes("finally {await fault('clear');}"));
    assert.ok(source.includes("failedStop.terminated,false"));
    assert.ok(source.includes("Failed checkpoint replaced active runtime"));
    assert.ok(source.includes("failedStop.outcome,'flush_failed'"));
    assert.ok(source.includes('assert.deepEqual(afterFailedWrite, beforeFailedWrite'));
    assert.ok(source.indexOf("await fault('checkpoint_write_failed')") < source.indexOf("const beforeFailedWrite = readCommittedCheckpoint()"));
    assert.ok(source.includes("TURN failure Retry state"));
    assert.ok(source.includes("evidence.turnFailureRetry = true"));
});
test('cold Browser acceptance proves stopped compute and delivers frames before opening Code',()=>{
    assert.ok(source.includes("confirmCold.outcome === 'not_running' && confirmCold.terminated === false"));
    assert.ok(source.indexOf("await launch('desktop'); await live(225000)") < source.indexOf('let f = await openCode()'));
    assert.ok(source.includes('evidence.coldOpenMs = Date.now() - coldStartedAt'));
    assert.ok(source.includes('Warm Browser open replaced runtime'));
});
test('every persistence reopen verifies the restored shortcut with automatic save disabled',()=>{
    assert.ok(source.includes('"files.autoSave":"off"'));
    const verification=source.slice(source.indexOf('  const verifyEditor = async'),source.indexOf("  await close('code'); await verifyEditor()"));
    assert.ok(verification.includes('await verifyEditorShortcut'));
    assert.ok(verification.includes("page.keyboard.press('Control+Alt+K')"));
    assert.ok(verification.includes("command(f, 'File: Revert File')"));
    assert.ok(verification.includes('hash(persistedMarker)'));
});
test('long session acceptance requires a renewal after earlier recovery scenarios',()=>{
    assert.ok(source.includes('evidence.sessionHold = await verifyRelayLifetime'));
    assert.ok(source.includes('durationMs: lifetime, expectedRuntimeId: firstRelay.runtimeId'));
    assert.ok(source.includes('readRelay: relay, verifyViewer: live'));
    assert.ok(source.indexOf('verifyRelayLifetime({') > source.indexOf("phase('network recovery')"));
    assert.ok(source.indexOf('verifyRelayLifetime({') < source.indexOf("phase('renewal and reconnect')"));
});
