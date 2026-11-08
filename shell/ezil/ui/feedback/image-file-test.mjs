import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
// Header fixtures are synthetic; decoder/canvas APIs below are explicit doubles.
const source=await readFile(new URL('./image-file.js',import.meta.url),'utf8');
const {uploaded_image_canvas}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
let calls,closed,draws,bitmapSize,bitmapImpl;
const oldBitmap=globalThis.createImageBitmap,oldDocument=globalThis.document,oldImage=globalThis.Image;
const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
function setup(w=800,h=600){
    calls=0;closed=0;draws=[];bitmapSize=[w,h];globalThis.Image=undefined;
    bitmapImpl=async()=>({width:bitmapSize[0],height:bitmapSize[1],close(){closed++;}});
    globalThis.createImageBitmap=(...args)=>{calls++;return bitmapImpl(...args);};
    globalThis.document={createElement(kind){assert.equal(kind,'canvas');
        return {width:0,height:0,getContext:()=>({drawImage:(...args)=>draws.push(args)})};}};
}
function png(w=800,h=600){
    const b=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(b);
    b.writeUInt32BE(13,8);b.write('IHDR',12);b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);return b;
}
function jpeg(w=800,h=600){
    const b=Buffer.from([255,216,255,192,0,17,8,0,0,0,0,3,1,17,0,2,17,0,3,17,0]);
    b.writeUInt16BE(h,7);b.writeUInt16BE(w,9);return b;
}
function webp(w=800,h=600,extended=false){
    const b=Buffer.alloc(extended?44:26);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WEBP',8);
    let o=12;if(extended){b.write('VP8X',o);b.writeUInt32LE(10,o+4);b.writeUIntLE(799,o+12,3);b.writeUIntLE(599,o+15,3);o+=18;}
    b.write('VP8L',o);b.writeUInt32LE(5,o+4);b[o+8]=47;b.writeUInt32LE(((w-1)|((h-1)<<14))>>>0,o+9);return b;
}
function file(bytes=png(),type='image/png'){return new Blob([bytes],{type});}
try{
await test('matching PNG, JPEG, WebP and extended WebP headers reach decoder',async()=>{
    for(const [bytes,type] of [[png(),'image/png'],[jpeg(),'image/jpeg'],[webp(),'image/webp'],[webp(800,600,true),'image/webp']]){
        setup();const c=await uploaded_image_canvas(file(bytes,type));
        assert.equal(c.width,800);assert.equal(c.height,600);assert.equal(calls,1);assert.equal(closed,1);
    }
});
await test('decoded orientation is respected, long edge fits1920 without upscaling',async()=>{
    setup(3000,4000);const c=await uploaded_image_canvas(file(png(4000,3000)));
    assert.deepEqual([c.width,c.height],[1440,1920]);assert.equal(closed,1);assert.deepEqual(draws[0].slice(1),[0,0,1440,1920]);
    setup(200,100);assert.equal((await uploaded_image_canvas(file(png(200,100)))).width,200);
});
await test('SVG, GIF, MIME mismatches, empty and truncated images never decode',async()=>{
    setup();assert.ok(await uploaded_image_canvas(file()));
    for(const f of [file(Buffer.from('<svg/>'),'image/svg+xml'),file(Buffer.from('GIF89a'),'image/gif'),
        file(png(),'image/jpeg'),file(jpeg(),'image/png'),file(Buffer.alloc(0)),file(png().subarray(0,25)),file(webp().subarray(0,24),'image/webp')]){
        setup();assert.equal(await uploaded_image_canvas(f),null);assert.equal(calls,0);
    }
});
await test('8MiB cap rejects before read and accepts its inclusive boundary',async()=>{
    setup();let read=false;
    assert.equal(await uploaded_image_canvas({type:'image/png',size:8*1024*1024+1,arrayBuffer(){read=true;}}),null);
    assert.equal(read,false);assert.equal(calls,0);
    const b=Buffer.alloc(8*1024*1024);png().copy(b);assert.ok(await uploaded_image_canvas(file(b)));
});
await test('header bombs and oversized hidden WebP frames reject before decode',async()=>{
    for(const [b,type] of [[png(4097,5),'image/png'],[png(0,5),'image/png'],[jpeg(5,4097),'image/jpeg'],[webp(4097,5),'image/webp'],[webp(8192,600,true),'image/webp']]){
        setup();assert.equal(await uploaded_image_canvas(file(b,type)),null);assert.equal(calls,0);
    }
    setup(4096,4096);assert.equal((await uploaded_image_canvas(file(png(4096,4096)))).width,1920);
});
await test('malformed JPEG segments and WebP chunks reject before decode',async()=>{
    const j=jpeg();j.writeUInt16BE(65535,4);const w=webp();w.writeUInt32LE(65535,16);
    for(const [b,type] of [[j,'image/jpeg'],[w,'image/webp']]){setup();assert.equal(await uploaded_image_canvas(file(b,type)),null);assert.equal(calls,0);}
    setup();assert.ok(await uploaded_image_canvas(file(jpeg(),'image/jpeg')));
});
await test('invalid decoded dimensions or unavailable canvas close bitmap without painting',async()=>{
    for(const size of [[0,4],[5,4097]]){setup(...size);assert.equal(await uploaded_image_canvas(file()),null);assert.equal(closed,1);assert.equal(draws.length,0);}
    setup();document.createElement=()=>({getContext:()=>null});assert.equal(await uploaded_image_canvas(file()),null);assert.equal(closed,1);
    setup();assert.ok(await uploaded_image_canvas(file()));
});
await test('abort stops promptly, skips pre-aborted work and closes a late bitmap',async()=>{
    setup();let done;bitmapImpl=()=>new Promise(resolve=>{done=resolve;});
    const controller=new AbortController(),pending=uploaded_image_canvas(file(),{signal:controller.signal});
    while(!done)await new Promise(resolve=>setImmediate(resolve));
    controller.abort();assert.equal(await pending,null);assert.equal(draws.length,0);

    done({width:800,height:600,close(){closed++;}});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,1);
    setup();assert.equal(await uploaded_image_canvas(file(),{signal:controller.signal}),null);assert.equal(calls,0);
    setup();assert.ok(await uploaded_image_canvas(file()));
});
await test('image fallback revokes URL, clears handlers and source after local draw',async()=>{
    setup();globalThis.createImageBitmap=undefined;let image,revoked=[];
    URL.createObjectURL=()=>'blob:local-test';URL.revokeObjectURL=url=>revoked.push(url);
    globalThis.Image=class{constructor(){image=this;this.naturalWidth=800;this.naturalHeight=600;}set src(v){this.value=v;if(v)queueMicrotask(()=>this.onload?.());}};
    assert.ok(await uploaded_image_canvas(file()));assert.deepEqual(revoked,['blob:local-test']);
    assert.equal(image.onload,null);assert.equal(image.onerror,null);assert.equal(image.value,'');assert.equal(draws.length,1);
});
await test('fallback error and abort revoke URL and prevent late painting',async()=>{
    for(const mode of ['error','abort']){
        setup();globalThis.createImageBitmap=undefined;let image,revoked=0;
        URL.createObjectURL=()=>'blob:local-test';URL.revokeObjectURL=()=>{revoked++;};
        globalThis.Image=class{constructor(){image=this;this.naturalWidth=800;this.naturalHeight=600;}set src(v){if(v&&mode==='error')queueMicrotask(()=>this.onerror?.());}};
        const controller=new AbortController(),pending=uploaded_image_canvas(file(),{signal:controller.signal});
        while(!image)await new Promise(resolve=>setImmediate(resolve));if(mode==='abort')controller.abort();
        assert.equal(await pending,null);assert.equal(revoked,1);assert.equal(image.onload,null);assert.equal(draws.length,0);
    }
});
await test('unsupported bitmap options use the image fallback',async()=>{
    setup();bitmapImpl=async()=>{throw new TypeError('unsupported options');};let revoked=0;
    URL.createObjectURL=()=>'blob:local-test';URL.revokeObjectURL=()=>{revoked++;};
    globalThis.Image=class{constructor(){this.naturalWidth=800;this.naturalHeight=600;}set src(v){if(v)queueMicrotask(()=>this.onload?.());}};
    assert.ok(await uploaded_image_canvas(file()));assert.equal(calls,1);assert.equal(revoked,1);
});
}finally{globalThis.createImageBitmap=oldBitmap;globalThis.document=oldDocument;globalThis.Image=oldImage;URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;}
