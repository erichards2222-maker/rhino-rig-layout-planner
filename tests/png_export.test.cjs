'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const zlib=require('node:zlib');
const {test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../src/png_export.js'),'utf8');
const api=vm.runInNewContext(source+'\n;({PngExport,cleanPng})',{ArrayBuffer,Uint8Array,Uint32Array,DataView,Blob});
const signature=Buffer.from([137,80,78,71,13,10,26,10]);

// Independent, bit-at-a-time CRC and PNG reader; neither uses exporter helpers.
function checksum(bytes){let c=0xffffffff;for(const byte of bytes){c^=byte;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(type,data=Buffer.alloc(0)){
 const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4,'ascii');Buffer.from(data).copy(b,8);
 b.writeUInt32BE(checksum(b.subarray(4,b.length-4)),b.length-4);return b;
}
function header(width=3,height=2,color=6,depth=8){const b=Buffer.alloc(13);b.writeUInt32BE(width);b.writeUInt32BE(height,4);b[8]=depth;b[9]=color;return chunk('IHDR',b);}
function read(bytes){
 const b=Buffer.from(bytes);assert.deepEqual(b.subarray(0,8),signature);let p=8;const out=[];
 while(p<b.length){const n=b.readUInt32BE(p),end=p+12+n;assert.ok(end<=b.length);const type=b.toString('ascii',p+4,p+8),data=b.subarray(p+8,end-4);assert.equal(checksum(b.subarray(p+4,end-4)),b.readUInt32BE(end-4));out.push({type,data});p=end;}
 assert.equal(p,b.length);return out;
}
function image(extra=[],after=[],color=6){
 const pixels=color===6?Buffer.from([255,0,0,255,0,255,0,128,0,0,255,0,4,5,6,255,255,255,255,200,0,0,0,33]):Buffer.from([0,1,2,2,1,0]);
 const stride=color===6?12:3,rows=Buffer.concat([Buffer.from([0]),pixels.subarray(0,stride),Buffer.from([0]),pixels.subarray(stride)]);
 const compressed=zlib.deflateSync(rows);const palette=color===3?[chunk('PLTE',Buffer.from([255,0,0,0,255,0,0,0,255])),chunk('tRNS',Buffer.from([255,127,0]))]:[];
 const bytes=Buffer.concat([signature,header(3,2,color),...extra,...palette,chunk('IDAT',compressed.subarray(0,3)),chunk('IDAT',compressed.subarray(3)),...after,chunk('IEND')]);
 return {bytes,pixels};
}
function decode(bytes){
 const chunks=read(bytes),h=chunks.find(c=>c.type==='IHDR').data,width=h.readUInt32BE(0),height=h.readUInt32BE(4),color=h[9];
 assert.equal(h[8],8);assert.ok([3,6].includes(color));
 const raw=zlib.inflateSync(Buffer.concat(chunks.filter(c=>c.type==='IDAT').map(c=>c.data))),stride=width*(color===6?4:1),pixels=[];
 assert.equal(raw.length,(stride+1)*height);
 const palette=chunks.find(c=>c.type==='PLTE')?.data,alpha=chunks.find(c=>c.type==='tRNS')?.data;
 for(let y=0;y<height;y++){
  const p=y*(stride+1);assert.equal(raw[p],0);
  if(color===6)pixels.push(...raw.subarray(p+1,p+1+stride));
  else for(const index of raw.subarray(p+1,p+1+stride))pixels.push(...palette.subarray(index*3,index*3+3),alpha?.[index]??255);
 }
 return Buffer.from(pixels);
}
function sanitized(bytes){return Buffer.from(api.PngExport.sanitize(bytes));}

test('post-encoding sanitation drops nonessential chunks and preserves RGBA pixels and IDAT bytes',()=>{
 const sentinels=['deBG','tEXt','iTXt','zTXt','eXIf','tIME','pHYs','aaAA'];
 const fixture=image(sentinels.slice(0,4).map(type=>chunk(type,Buffer.from('example-note'))),sentinels.slice(4).map(type=>chunk(type,Buffer.from('example-note'))));
 const original=Buffer.from(fixture.bytes),out=sanitized(fixture.bytes);
 assert.deepEqual(read(out).map(c=>c.type),['IHDR','IDAT','IDAT','IEND']);
 assert.equal(out.includes(Buffer.from('example-note')),false);
 assert.deepEqual(decode(out),fixture.pixels);assert.deepEqual(decode(out),decode(original));
 assert.deepEqual(Buffer.concat(read(out).filter(c=>c.type==='IDAT').map(c=>c.data)),Buffer.concat(read(original).filter(c=>c.type==='IDAT').map(c=>c.data)));
 assert.deepEqual(fixture.bytes,original);
});

test('indexed palette and transparency survive with identical decoded pixels',()=>{
 const f=image([chunk('deBG',Buffer.alloc(16))],[],3),out=sanitized(f.bytes);
 assert.deepEqual(read(out).map(c=>c.type),['IHDR','PLTE','tRNS','IDAT','IDAT','IEND']);
 assert.deepEqual(decode(out),decode(f.bytes));
 assert.deepEqual(decode(out),Buffer.from([255,0,0,255,0,255,0,127,0,0,255,0,0,0,255,0,0,255,0,127,255,0,0,255]));
});

test('fixed color information is retained exactly and output is idempotent',()=>{
 const gamma=Buffer.alloc(4);gamma.writeUInt32BE(45455);
 const color=[chunk('gAMA',gamma),chunk('cHRM',Buffer.alloc(32)),chunk('sRGB',Buffer.from([0])),chunk('sBIT',Buffer.from([8,8,8,8])),chunk('cICP',Buffer.from([1,13,0,1])),chunk('mDCV',Buffer.alloc(24)),chunk('cLLI',Buffer.alloc(8))];
 const f=image(color,[chunk('deBG',Buffer.alloc(16))]),out=sanitized(f.bytes);
 const retained=read(out);for(const c of color)assert.ok(out.includes(c));
 assert.deepEqual(retained.map(c=>c.type),['IHDR','gAMA','cHRM','sRGB','sBIT','cICP','mDCV','cLLI','IDAT','IDAT','IEND']);
 assert.deepEqual(sanitized(out),out);assert.deepEqual(decode(out),decode(f.bytes));
});

test('browser-facing Blob result contains scrubbed bytes directly with no canvas re-encode',async()=>{
 const f=image([chunk('deBG',Buffer.alloc(16))]);const out=await api.cleanPng(new Blob([f.bytes],{type:'image/png'}));
 assert.equal(out.type,'image/png');assert.deepEqual(Buffer.from(await out.arrayBuffer()),sanitized(f.bytes));
 await assert.rejects(api.cleanPng(null),/not saved/);await assert.rejects(api.cleanPng({size:api.PngExport.maxBytes+1,arrayBuffer(){throw Error('must not read');}}),/oversized/);
});

test('bad signatures, CRCs including discarded chunks, truncations and excess bytes fail closed',()=>{
 const f=image([chunk('deBG',Buffer.alloc(16))]).bytes;
 const badSignature=Buffer.from(f);badSignature[0]=0;
 const badCRC=Buffer.from(f);badCRC[45]^=1;
 for(const b of [badSignature,badCRC,f.subarray(0,20),f.subarray(0,f.length-1),Buffer.concat([f,Buffer.from([0])])])assert.throws(()=>sanitized(b),/not saved/);
 const longLength=Buffer.from(f);longLength.writeUInt32BE(0xffffffff,33);assert.throws(()=>sanitized(longLength),/chunk length/);
});

test('critical chunk order, palette requirements and duplicate chunks are enforced',()=>{
 const f=read(image().bytes),data=f.filter(c=>c.type==='IDAT').map(c=>chunk(c.type,c.data));
 const cases=[
  [chunk('tEXt'),header(),...data,chunk('IEND')],
  [header(),header(),...data,chunk('IEND')],
  [header(),data[0],chunk('tEXt'),data[1],chunk('IEND')],
  [header(),...data,chunk('PLTE',Buffer.from([1,2,3])),chunk('IEND')],
  [header(3,2,3),...data,chunk('IEND')],
  [header(),chunk('ABCD'),...data,chunk('IEND')],
  [header(),chunk('abca'),...data,chunk('IEND')],
  [header(),chunk('IDAT'),chunk('IEND')],
  [header(),...data],
  [header(),...data,chunk('IEND',Buffer.from([0]))],
  [header(),...data,chunk('sRGB',Buffer.from([0])),chunk('IEND')],
  [header(),chunk('sRGB',Buffer.from([0])),chunk('sRGB',Buffer.from([0])),...data,chunk('IEND')],
 ];
 for(const chunks of cases)assert.throws(()=>sanitized(Buffer.concat([signature,...chunks])),/not saved/);
});

test('malformed headers and transparency/color records fail without emitting an image',()=>{
 const data=read(image().bytes).filter(c=>c.type==='IDAT').map(c=>chunk(c.type,c.data));
 for(const head of [header(0),header(25001),header(25000,25000),header(3,2,7),header(3,2,6,4)])assert.throws(()=>sanitized(Buffer.concat([signature,head,...data,chunk('IEND')])),/header/);
 for(const c of [chunk('tRNS',Buffer.from([0])),chunk('gAMA',Buffer.alloc(4)),chunk('cHRM',Buffer.alloc(31)),chunk('sRGB',Buffer.from([4])),chunk('sBIT',Buffer.from([8,8,8,0])),chunk('cICP',Buffer.from([1,13,1,1]))])assert.throws(()=>sanitized(Buffer.concat([signature,header(),c,...data,chunk('IEND')])),/not saved/);
});

test('unsupported profiles and animation fail visibly rather than retaining text or changing interpretation',()=>{
 for(const type of ['iCCP','acTL','fcTL','fdAT'])assert.throws(()=>sanitized(image([chunk(type,Buffer.from('example-note'))]).bytes),/unsupported/);
});

test('chunk count and input size bounds prevent unbounded metadata traversal',()=>{
 const f=image(Array.from({length:16385},()=>chunk('aaAA'))).bytes;assert.throws(()=>sanitized(f),/chunk count/);
 assert.throws(()=>api.PngExport.sanitize('not bytes'),/not saved/);
 assert.throws(()=>api.PngExport.sanitize(new Uint8Array(api.PngExport.maxBytes+1)),/oversized/);
});
