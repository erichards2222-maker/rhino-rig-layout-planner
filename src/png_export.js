'use strict';
// Keep encoded pixels unchanged. Validate the PNG container, then copy only
// image data and this fixed-format color/transparency allowlist (PNG 3).
const PngExport = (() => {
 const MAX_BYTES=96*1024*1024, MAX_CHUNKS=16384;
 const signature=[137,80,78,71,13,10,26,10];
 const allowed=new Set(['IHDR','PLTE','IDAT','IEND','tRNS','gAMA','cHRM','sRGB','sBIT','cICP','mDCV','cLLI']);
 const table=new Uint32Array(256);
 for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;table[i]=c>>>0;}
 function fail(message){throw Error('PNG export was not saved: '+message);}
 function crc(bytes,start,end){let c=0xffffffff;for(let i=start;i<end;i++)c=table[(c^bytes[i])&255]^(c>>>8);return (c^0xffffffff)>>>0;}
 function sanitize(input){
  const source=input instanceof ArrayBuffer?new Uint8Array(input):ArrayBuffer.isView(input)?new Uint8Array(input.buffer,input.byteOffset,input.byteLength):null;
  if(!source||source.length<45||source.length>MAX_BYTES)fail('invalid or oversized image.');
  // Own the input throughout parsing, including callers that reuse their buffers.
  const bytes=new Uint8Array(source),view=new DataView(bytes.buffer);
  if(!signature.every((b,i)=>bytes[i]===b))fail('invalid image signature.');
  const parts=[bytes.subarray(0,8)],seen=new Set();
  let pos=8,count=0,total=8,color,depth,palette=0,idat=false,idatEnded=false,ended=false,dataSize=0;
  const beforePixels=()=>{if(idat||palette)fail('color information is out of order.');};
  while(pos<bytes.length){
   if(++count>MAX_CHUNKS||pos+12>bytes.length)fail('invalid chunk count or truncated image.');
   const length=view.getUint32(pos),end=pos+12+length;
   if(length>0x7fffffff||end>bytes.length)fail('invalid chunk length.');
   const type=String.fromCharCode(...bytes.subarray(pos+4,pos+8)),start=pos+8;
   if(!/^[A-Za-z]{4}$/.test(type)||type[2]!==type[2].toUpperCase())fail('invalid chunk type.');
   if(crc(bytes,pos+4,start+length)!==view.getUint32(start+length))fail('image checksum failed.');
   if(count===1&&type!=='IHDR')fail('missing image header.');
   if(type!=='IDAT'&&idat)idatEnded=true;
   if(type!=='IDAT'&&seen.has(type)&&allowed.has(type))fail('duplicate image chunk.');
   if(type==='IHDR'){
    if(count!==1||length!==13)fail('invalid image header.');
    const width=view.getUint32(start),height=view.getUint32(start+4);
    depth=bytes[start+8];color=bytes[start+9];
    const depths={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
    if(!width||!height||width>25000||height>25000||width*height>130000000||!depths[color]?.includes(depth)||bytes[start+10]!==0||bytes[start+11]!==0||bytes[start+12]>1)fail('unsupported image header.');
   }else if(type==='PLTE'){
    if(idat||seen.has('tRNS')||[0,4].includes(color)||length===0||length>768||length%3)fail('invalid palette.');
    palette=length/3;if(color===3&&palette>2**depth)fail('palette exceeds sample depth.');
   }else if(type==='IDAT'){
    if(idatEnded||(color===3&&!palette))fail('image data is out of order.');
    idat=true;dataSize+=length;
   }else if(type==='IEND'){
    if(length!==0||!idat||!dataSize||end!==bytes.length)fail('invalid image ending.');
    ended=true;
   }else if(type==='tRNS'){
    if(idat||[4,6].includes(color)||(color===0&&length!==2)||(color===2&&length!==6)||(color===3&&(!palette||!length||length>palette)))fail('invalid transparency.');
    if(color===0&&view.getUint16(start)>2**depth-1)fail('invalid transparency sample.');
    if(color===2&&[0,2,4].some(i=>view.getUint16(start+i)>2**depth-1))fail('invalid transparency sample.');
   }else if(type==='gAMA'){
    beforePixels();if(length!==4||view.getUint32(start)===0)fail('invalid gamma.');
   }else if(type==='cHRM'){
    beforePixels();if(length!==32)fail('invalid chromaticities.');
   }else if(type==='sRGB'){
    beforePixels();if(length!==1||bytes[start]>3)fail('invalid color rendering intent.');
   }else if(type==='sBIT'){
    beforePixels();const n={0:1,2:3,3:3,4:2,6:4}[color],max=color===3?8:depth;
    if(length!==n||Array.from(bytes.subarray(start,start+length)).some(b=>b===0||b>max))fail('invalid significant bits.');
   }else if(['cICP','mDCV','cLLI'].includes(type)){
    beforePixels();if(length!==({cICP:4,mDCV:24,cLLI:8}[type]))fail('invalid color information.');
    if(type==='cICP'&&(bytes[start+2]!==0||bytes[start+3]>1))fail('unsupported color matrix.');
   }else if(type==='iCCP'){
    // An arbitrary profile may contain descriptive text. Do not retain that
    // text or silently discard the profile and change color interpretation.
    fail('embedded color profiles are unsupported; use a standard RGB canvas export.');
   }else if(['acTL','fcTL','fdAT'].includes(type)){
    fail('animated images are unsupported.');
   }else if(type[0]===type[0].toUpperCase())fail('unsupported critical image chunk.');
   if(allowed.has(type)){parts.push(bytes.subarray(pos,end));total+=end-pos;}
   seen.add(type);pos=end;
  }
  if(!ended)fail('missing image ending.');
  const output=new Uint8Array(total);let offset=0;for(const part of parts){output.set(part,offset);offset+=part.length;}
  return output;
 }
 async function clean(blob){
  if(!blob||typeof blob.arrayBuffer!=='function'||!Number.isFinite(blob.size)||blob.size<45||blob.size>MAX_BYTES)fail('invalid or oversized encoded image.');
  return new Blob([sanitize(await blob.arrayBuffer())],{type:'image/png'});
 }
 return Object.freeze({sanitize,clean,allowed:Object.freeze([...allowed]),maxBytes:MAX_BYTES});
})();
async function cleanPng(blob){return PngExport.clean(blob);}
