// A real HTTPS receiver on loopback, for a browser suite that must see a request actually leave Chromium. Playwright's
// route answers only the requests it can still attach to a frame: one sent while its document unloads (a keepalive from
// pagehide) can be continued to the network unseen. Chromium reaches this receiver only for the exact hosts the suite
// maps to it (`hostRules`), and accepts its certificate only through this run's SPKI pin (`spki`): the system trust store,
// every other host and every other certificate are untouched. Nothing is written to disk and no process is started.
import crypto from 'node:crypto';
import https from 'node:https';

// Just enough DER for one self-signed P-256 certificate.
const der=(tag,...parts)=>{const body=Buffer.concat(parts),n=body.length;
    return Buffer.concat([Buffer.from([tag,...(n<128?[n]:n<256?[0x81,n]:[0x82,n>>8,n&255])]),body]);};
const seq=(...parts)=>der(0x30,...parts);
const oid=dotted=>{const [a,b,...rest]=dotted.split('.').map(Number),bytes=[40*a+b];
    for(const v of rest){const out=[v&127];for(let x=v>>7;x;x>>=7)out.unshift(x&127|128);bytes.push(...out);}
    return der(0x06,Buffer.from(bytes));};
const utcTime=ms=>der(0x17,Buffer.from(new Date(ms).toISOString().replace(/[-:T]/g,'').slice(2,14)+'Z'));
const name=cn=>seq(der(0x31,seq(oid('2.5.4.3'),der(0x0c,Buffer.from(cn)))));

/** A fresh certificate naming exactly `hosts`, valid for a day. `spki` is the base64 SHA-256 of its public key. */
export function ephemeralCertificate(hosts,now=Date.now()){
    const {publicKey,privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'P-256'});
    const spki=publicKey.export({type:'spki',format:'der'}),ecdsaSha256=seq(oid('1.2.840.10045.4.3.2'));
    const tbs=seq(der(0xa0,der(0x02,Buffer.from([2]))),der(0x02,Buffer.from([1]),crypto.randomBytes(15)),ecdsaSha256,
        name(hosts[0]),seq(utcTime(now-3600000),utcTime(now+86400000)),name(hosts[0]),spki,
        der(0xa3,seq(seq(oid('2.5.29.17'),der(0x04,seq(...hosts.map(host=>der(0x82,Buffer.from(host)))))))));
    const cert=seq(tbs,ecdsaSha256,der(0x03,Buffer.from([0]),crypto.sign('sha256',tbs,privateKey)));
    return {cert:'-----BEGIN CERTIFICATE-----\n'+cert.toString('base64').match(/.{1,64}/g).join('\n')+'\n-----END CERTIFICATE-----\n',
        key:privateKey.export({type:'pkcs8',format:'pem'}),spki:crypto.createHash('sha256').update(spki).digest('base64')};
}

/**
 * Listens on 127.0.0.1 at an ephemeral port. Every request is kept in `received` (its Host, TLS server name, path, the
 * headers a delivery check needs, and its body parsed as JSON); `respond(entry)` answers one whose Host is in `hosts`,
 * anything else is a 404. Bodies are capped, slow requests time out, and `close()` ends every connection.
 */
export async function startLoopbackReceiver({hosts,respond,maxBody=65536,timeoutMs=10000}){
    const {cert,key,spki}=ephemeralCertificate(hosts);
    const received=[],faults=[],sockets=new Set();
    const fault=(kind,error)=>faults.push({kind,at:Date.now(),code:error?.code??null,message:String(error?.message??error).slice(0,160)});
    const server=https.createServer({cert,key,requestTimeout:timeoutMs,headersTimeout:timeoutMs,keepAliveTimeout:timeoutMs},(req,res)=>{
        const chunks=[];let size=0;
        req.on('data',chunk=>{size+=chunk.length;if(size<=maxBody)chunks.push(chunk);});
        req.on('error',error=>fault('request',error));
        req.on('end',()=>{
            let json=null;try{json=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{/* not JSON */}
            const entry={at:Date.now(),method:req.method,host:req.headers.host??null,servername:req.socket.servername||null,path:req.url,size,json,
                headers:Object.fromEntries(['content-type','x-ezil-assignment-video','origin','sec-fetch-site','sec-fetch-mode'].map(h=>[h,req.headers[h]??null]))};
            received.push(entry);
            let answer=null;
            if(hosts.includes(entry.host)&&size<=maxBody)try{answer=respond(entry);}catch(error){fault('respond',error);}
            const body=Buffer.from(answer?.body??'');
            res.writeHead(answer?.status??404,{'content-type':answer?.type??'text/plain','content-length':body.length}).end(body);
        });
    });
    server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
    server.on('tlsClientError',error=>fault('tls',error));
    server.on('clientError',(error,socket)=>{fault('client',error);socket.destroy();});
    server.on('error',error=>fault('server',error));
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
    const {port}=server.address();
    return {port,spki,cert,received,faults,
        hostRules:hosts.map(host=>'MAP '+host+' 127.0.0.1:'+port),
        /** One request from Node itself, trusting only this certificate: the receiver works before a browser is involved. */
        check:host=>new Promise((resolve,reject)=>{
            const from=received.length;
            const req=https.request({host:'127.0.0.1',port,servername:host,ca:cert,agent:false,method:'GET',path:'/receiver-check',headers:{host},timeout:timeoutMs},res=>{
                res.resume();res.on('end',()=>received[from]?.host===host&&received[from].servername===host?resolve(res.statusCode)
                    :reject(new Error('loopback receiver check not received')));});
            req.on('timeout',()=>req.destroy(new Error('loopback receiver check timed out')));
            req.on('error',reject);req.end();
        }),
        close:()=>new Promise(resolve=>{setTimeout(resolve,2000).unref();server.close(()=>resolve());server.closeAllConnections();
            for(const socket of sockets)socket.destroy();})};
}
