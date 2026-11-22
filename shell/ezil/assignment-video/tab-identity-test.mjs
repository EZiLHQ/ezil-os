import assert from 'node:assert/strict';
import {test} from 'node:test';
import {identifiesThisTab, STAGING_OS} from './current-tab.js';
import {assignmentIntent} from './shell.js';
const id='2d5fd5d2-ad3e-47ea-9a95-60eb51bce32a';
const repo='https://github.ezil.work/default/u-a9c3a9c3a9c3a9c3-a-'+id+'.git';
const href=STAGING_OS+'/app/code?repo='+encodeURIComponent(repo)+'&assignment='+id;
test('an ordinary Code link, duplicate selector, alternate origin or different repo has no recording intent',()=>{
    assert.equal(assignmentIntent(href,repo),id);
    assert.equal(assignmentIntent(href.split('&assignment')[0],repo),id);
    for (const [url,checkout] of [[href.replace('assignment='+id,'assignment=ffffffff-ffff-4fff-8fff-ffffffffffff'),repo],[href+'&assignment='+id,repo],
        [href.replace('os-staging.ezil.work','os.ezil.work'),repo],[href,repo.replace('a9c3','ade2')],
        [href.replace('/app/code','/app/settings'),repo],[href,'https://github.com/user/ordinary.git']])
        assert.equal(assignmentIntent(url,checkout),null);
});
test('only one live, silent browser video track attesting this individual document can pass',()=>{
    function stream({type='browser',state='live',origin=STAGING_OS,handle='one',audio=[],mixed=false,unknown=false}={}) {
        const track={readyState:state,getSettings:()=>({displaySurface:type}),getCaptureHandle:()=>unknown?null:{origin,handle}};
        return {getVideoTracks:()=>mixed?[track,track]:[track],getAudioTracks:()=>audio};
    }
    assert.equal(identifiesThisTab(stream(),STAGING_OS,'one'),true);
    for(const fields of [{type:'window'},{type:'monitor'},{state:'ended'},{origin:'https://other.invalid'},
        {handle:'second-tab-at-the-same-origin'},{unknown:true},{audio:[{}]},{mixed:true}])
        assert.equal(identifiesThisTab(stream(fields),STAGING_OS,'one'),false);
});
