// Local screenshot imports. The caller re-encodes the pixels before attaching; the redaction editor is the explicit Edit step.
// Original file bytes, filenames and metadata are never uploaded by this module.
const SOURCE_BYTES_MAX = 8 * 1024 * 1024;
// A pasted or saved screenshot from a 5K/6K or HiDPI display is wider than 4096 px. It is decoded once
// and scaled to LONG_EDGE_MAX, so the bound is on decode memory: 8192 px per side and ~42 Mpx in all.
const SOURCE_SIDE_MAX = 8192;
const SOURCE_PIXELS_MAX = 8192 * 5120;
const LONG_EDGE_MAX = 1920;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
function size_ok(w,h) {
    return Number.isInteger(w) && Number.isInteger(h) && w>0 && h>0
        && w<=SOURCE_SIDE_MAX && h<=SOURCE_SIDE_MAX && w*h<=SOURCE_PIXELS_MAX;
}
function header_size(b,type) {
    const v=new DataView(b.buffer,b.byteOffset,b.byteLength);
    const ascii=(start,text)=>[...text].every((c,i)=>b[start+i]===c.charCodeAt(0));
    if(type==='image/png') {
        if(b.length<33 || ![137,80,78,71,13,10,26,10].every((n,i)=>b[i]===n)
            || v.getUint32(8)!==13 || !ascii(12,'IHDR'))return null;
        return [v.getUint32(16),v.getUint32(20)];
    }
    if(type==='image/jpeg') {
        if(b.length<4 || b[0]!==255 || b[1]!==216 || b[2]!==255)return null;
        let o=2;
        while(o<b.length) {
            if(b[o++]!==255)return null;
            while(b[o]===255)o++;
            const marker=b[o++];
            if(marker===undefined || marker===0 || marker===218 || marker===217)return null;
            if(marker===1 || (marker>=208 && marker<=215))continue;
            if(o+2>b.length)return null;
            const length=v.getUint16(o);
            if(length<2 || o+length>b.length)return null;
            if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
                if(length<8 || !b[o+7] || length!==8+3*b[o+7])return null;
                return [v.getUint16(o+5),v.getUint16(o+3)];
            }
            o+=length;
        }
        return null;
    }
    if(b.length<20 || !ascii(0,'RIFF') || !ascii(8,'WEBP') || v.getUint32(4,true)+8!==b.length)return null;
    const u24=s=>b[s]|b[s+1]<<8|b[s+2]<<16;
    let o=12,canvas=null,frame=null;
    while(o+8<=b.length) {
        const length=v.getUint32(o+4,true),start=o+8,end=start+length;
        if(end+length%2>b.length)return null;
        let size=null;
        // Screenshots are static; reject animation frames whose nested raster headers are not inspected.
        if(ascii(o,'ANIM') || ascii(o,'ANMF'))return null;
        if(ascii(o,'VP8X')) {
            if(length!==10 || canvas || (b[start]&2))return null;
            size=[u24(start+4)+1,u24(start+7)+1];canvas=size;
        }else if(ascii(o,'VP8L')) {
            if(length<5 || b[start]!==47 || (b[start+4]&224))return null;
            const bits=v.getUint32(start+1,true);
            size=[(bits&16383)+1,((bits>>>14)&16383)+1];frame=size;
        }else if(ascii(o,'VP8 ')) {
            if(length<10 || (b[start]&1) || ![157,1,42].every((n,i)=>b[start+3+i]===n))return null;
            size=[v.getUint16(start+6,true)&16383,v.getUint16(start+8,true)&16383];frame=size;
        }
        // Check both canvas and raster so VP8X cannot hide a dimension bomb.
        if(size && !size_ok(...size))return null;
        o=end+length%2;
    }
    return o===b.length ? canvas??frame : null;
}
function bounded_wait(promise,signal,discard=()=>{}) {
    return new Promise((resolve,reject)=>{
        let finished=false;
        const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',fail);};
        const fail=()=>{
            if(finished)return;
            finished=true;cleanup();reject(new Error('Image cancelled or unavailable'));
        };
        const timer=setTimeout(fail,4000);
        signal?.addEventListener('abort',fail,{once:true});
        Promise.resolve(promise).then(value=>{
            if(finished){discard(value);return;}
            finished=true;cleanup();resolve(value);
        },fail);
        if(signal?.aborted)fail();
    });
}
function paint(image,w,h) {
    if(!size_ok(w,h))return null;
    const scale=Math.min(1,LONG_EDGE_MAX/Math.max(w,h));
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(w*scale));
    canvas.height=Math.max(1,Math.round(h*scale));
    const ctx=canvas.getContext('2d');
    if(!ctx)return null;
    ctx.drawImage(image,0,0,canvas.width,canvas.height);
    return canvas;
}
async function image_element(file,signal) {
    const ImageClass=globalThis.Image??globalThis.document?.defaultView?.Image;
    if(typeof ImageClass!=='function' || !globalThis.URL?.createObjectURL)return null;
    const image=new ImageClass(),url=URL.createObjectURL(file);
    try {
        const loaded=new Promise((resolve,reject)=>{
            image.onload=()=>resolve(image);
            image.onerror=()=>reject(new Error('Image unavailable'));
            image.src=url;
        });
        await bounded_wait(loaded,signal);
        if(signal?.aborted)return null;
        return paint(image,image.naturalWidth,image.naturalHeight);
    }finally{
        image.onload=image.onerror=null;
        try{image.src='';}catch{/* Still release the URL. */}
        URL.revokeObjectURL(url);
    }
}
/** Local PNG/JPEG/WebP file -> bounded canvas or null. Never uploads anything. */
export async function uploaded_image_canvas(file,{signal}={}) {
    let bitmap;
    try {
        if(signal?.aborted || !file || !TYPES.has(file.type) || !Number.isInteger(file.size)
            || file.size<1 || file.size>SOURCE_BYTES_MAX || typeof file.arrayBuffer!=='function')return null;
        const buffer=await bounded_wait(file.arrayBuffer(),signal);
        if(signal?.aborted || buffer.byteLength!==file.size)return null;
        const size=header_size(new Uint8Array(buffer),file.type);
        if(!size || !size_ok(...size))return null;
        if(typeof globalThis.createImageBitmap==='function') {
            try {
                bitmap=await bounded_wait(createImageBitmap(file,{imageOrientation:'from-image'}),signal,
                    late=>late?.close?.());
                if(signal?.aborted)return null;
                return paint(bitmap,bitmap.width,bitmap.height);
            }catch{
                if(signal?.aborted)return null;
                // Older browsers can lack bitmap decoding/options.
            }
        }
        return await image_element(file,signal);
    }catch{return null;}
    finally{bitmap?.close?.();}
}
