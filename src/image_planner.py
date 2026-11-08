#!/usr/bin/env python3
"""Rhino Rig Layout Planner image input.

Reads one selected local image and creates a self-contained HTML viewer.
The input file is preserved and results are written to a separate folder.
"""
from __future__ import annotations

import argparse
import base64
import json
import hashlib
import os
from pathlib import Path
import struct
import stat
import sys
from datetime import datetime, timezone
import zlib

EXTENSIONS = frozenset({'.bmp', '.bin', '.png', '.jpg', '.jpeg', '.webp'})
MIN_IMAGE_BYTES = 12
MAX_INPUT_BYTES = 300 * 1024 * 1024
MAX_DIMENSION = 25000
MAX_PIXELS = 130_000_000
MAX_EMBED_BYTES = 48 * 1024 * 1024
DEFAULT_INPUT = Path.home() / 'OneDrive' / 'Pictures' / 'Frontier Developments' / 'Elite Dangerous'
DEFAULT_OUTPUT = Path.home() / 'Rig_Layout_Outputs'

class ImageRefusal(ValueError):
    pass


def needs_recall(info)->bool:
    return bool(getattr(info,'st_file_attributes',0)&(0x1000|0x40000|0x400000))


def unsafe_image_entry(info)->bool:
    """Accept ordinary local entries and hydrated Cloud Files; never name-surrogate links."""
    if stat.S_ISLNK(info.st_mode) or needs_recall(info):return True
    if not (getattr(info,'st_file_attributes',0)&0x400):return False
    tag=getattr(info,'st_reparse_tag',0)
    return (tag&~0xf000)!=0x9000001a


def header_kind(header: bytes) -> str:
    if len(header) >= 8 and header[:8] == b'\x89PNG\r\n\x1a\n':
        return 'png'
    if header[:3] == b'\xff\xd8\xff':
        return 'jpeg'
    if header[:2] == b'BM':
        return 'bmp'
    if header[:4] == b'RIFF' and header[8:12] == b'WEBP':
        return 'webp'
    return 'unrecognized'


def choose_latest(folder: Path) -> Path:
    if not folder.is_dir():
        raise ImageRefusal('SCREENSHOT_FOLDER_NOT_FOUND: ' + str(folder))
    entries=[]
    for p in folder.iterdir():
        try:
            if not p.is_file() or p.is_symlink() or p.suffix.lower() not in EXTENSIONS:
                continue
            st=p.stat()
            if st.st_size < MIN_IMAGE_BYTES or st.st_size > MAX_INPUT_BYTES:
                continue
            entries.append((st.st_mtime_ns,p.name.lower(),p))
        except (OSError,PermissionError):
            continue
    if not entries:
        raise ImageRefusal('NO_SCREENSHOT_CANDIDATES: check file extensions and folder')
    # Exact latest by modification time, not the first file we happen to decode.
    return max(entries)[2]


def _png_chunk(tag: bytes, payload: bytes) -> bytes:
    return (struct.pack('>I',len(payload)) + tag + payload +
            struct.pack('>I',zlib.crc32(tag + payload)&0xffffffff))


def bmp_to_png(data: bytes, max_side=2048) -> tuple[bytes,int,int,int,int]:
    if len(data)<54 or data[:2]!=b'BM':
        raise ImageRefusal('NOT_A_BITMAP')
    offset=struct.unpack_from('<I',data,10)[0]
    dib_len=struct.unpack_from('<I',data,14)[0]
    if dib_len<40 or len(data)<14+dib_len:
        raise ImageRefusal('UNSUPPORTED_BMP_DIB_HEADER')
    width,height,planes,depth,compression=struct.unpack_from('<iiHHI',data,18)
    if width<=0 or height==0 or abs(height)>MAX_DIMENSION or width>MAX_DIMENSION:
        raise ImageRefusal('BMP_DIMENSIONS_UNSUPPORTED')
    h=abs(height)
    if width*h>MAX_PIXELS or planes!=1 or depth not in (24,32) or compression!=0:
        raise ImageRefusal('BMP_SUPPORTED_ONLY_UNCOMPRESSED_24_OR_32_BIT: file not modified')
    stride=((width*depth+31)//32)*4
    if offset < 14+dib_len or offset+stride*h>len(data):
        raise ImageRefusal('BMP_TRUNCATED_OR_INVALID_PIXEL_OFFSET')
    factor=max(1, (max(width,h)+max_side-1)//max_side)
    ow=(width+factor-1)//factor
    oh=(h+factor-1)//factor
    comp=zlib.compressobj(level=6)
    pieces=[]
    for dy in range(oh):
        sy=min(h-1,dy*factor)
        source_y=(h-1-sy) if height>0 else sy
        base=offset+source_y*stride
        row=bytearray(1+3*ow)
        for dx in range(ow):
            sx=min(width-1,dx*factor)
            spot=base+sx*(depth//8)
            b,g,r=data[spot:spot+3]
            dest=1+dx*3
            row[dest:dest+3]=bytes((r,g,b))
        pieces.append(comp.compress(row))
    pieces.append(comp.flush())
    raw=b''.join(pieces)
    out=(b'\x89PNG\r\n\x1a\n'+
         _png_chunk(b'IHDR',struct.pack('>IIBBBBB',ow,oh,8,2,0,0,0))+
         _png_chunk(b'IDAT',raw)+_png_chunk(b'IEND',b''))
    return out,width,h,ow,oh


def compressed_dimensions(data:bytes,kind:str)->tuple[int,int]:
    """Bound declared dimensions before a browser decodes compressed image content."""
    width=height=0
    if kind=='png':
        if len(data)<33 or data[8:16]!=b'\x00\x00\x00\rIHDR':
            raise ImageRefusal('INVALID_PNG_DIMENSION_HEADER')
        width,height=struct.unpack_from('>II',data,16)
    elif kind=='jpeg':
        position=2
        while position<len(data):
            if data[position]!=255:
                raise ImageRefusal('INVALID_JPEG_MARKER')
            while position<len(data) and data[position]==255:position+=1
            if position>=len(data):break
            marker=data[position];position+=1
            if marker in (0xd9,0xda):break
            if marker==1 or 0xd0<=marker<=0xd8:continue
            if position+2>len(data):break
            length=struct.unpack_from('>H',data,position)[0]
            if length<2 or position+length>len(data):
                raise ImageRefusal('TRUNCATED_JPEG_SEGMENT')
            if marker in (0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf):
                if length<8:raise ImageRefusal('INVALID_JPEG_DIMENSIONS')
                height,width=struct.unpack_from('>HH',data,position+3)
                break
            position+=length
    elif kind=='webp':
        if len(data)<30 or struct.unpack_from('<I',data,4)[0]+8!=len(data):
            raise ImageRefusal('TRUNCATED_WEBP_CONTAINER')
        tag=data[12:16]
        chunk=struct.unpack_from('<I',data,16)[0]
        if 20+chunk>len(data):raise ImageRefusal('TRUNCATED_WEBP_CHUNK')
        if tag==b'VP8X' and chunk>=10:
            width=1+int.from_bytes(data[24:27],'little');height=1+int.from_bytes(data[27:30],'little')
        elif tag==b'VP8 ' and chunk>=10 and data[23:26]==b'\x9d\x01\x2a':
            width=struct.unpack_from('<H',data,26)[0]&0x3fff;height=struct.unpack_from('<H',data,28)[0]&0x3fff
        elif tag==b'VP8L' and chunk>=5 and data[20]==0x2f:
            bits=int.from_bytes(data[21:25],'little');width=(bits&0x3fff)+1;height=((bits>>14)&0x3fff)+1
    if min(width,height)<1 or max(width,height)>MAX_DIMENSION or width*height>MAX_PIXELS:
        raise ImageRefusal('COMPRESSED_IMAGE_DIMENSIONS_UNSUPPORTED')
    return width,height


def source_info(path:Path, allowed_root:Path|None=None)-> tuple[bytes,dict]:
    path=Path(path)
    if allowed_root is not None:
        root=Path(allowed_root)
        if path.parent!=root:
            raise ImageRefusal('IMAGE_OUTSIDE_SELECTED_FOLDER')
        for part in (root,*root.parents):
            info=part.lstat()
            if unsafe_image_entry(info):
                raise ImageRefusal('IMAGE_FOLDER_NOT_LOCAL_OR_IS_LINKED')
        if path.resolve().parent!=root.resolve():
            raise ImageRefusal('IMAGE_OUTSIDE_SELECTED_FOLDER')
    before=path.lstat()
    if not stat.S_ISREG(before.st_mode) or unsafe_image_entry(before):
        raise ImageRefusal('IMAGE_NOT_LOCAL_OR_IS_LINKED: make screenshots available on this device')
    if before.st_size<MIN_IMAGE_BYTES or before.st_size>MAX_INPUT_BYTES:
        raise ImageRefusal('IMAGE_SIZE_OUTSIDE_SAFE_BOUND')
    flags=os.O_RDONLY|getattr(os,'O_BINARY',0)|getattr(os,'O_NOFOLLOW',0)
    descriptor=os.open(path,flags)
    with os.fdopen(descriptor,'rb') as f:
        opened=os.fstat(f.fileno())
        if ((opened.st_dev,opened.st_ino)!=(before.st_dev,before.st_ino) or
            not stat.S_ISREG(opened.st_mode) or needs_recall(opened)):
            raise ImageRefusal('IMAGE_CHANGED_DURING_OPEN')
        data=f.read(MAX_INPUT_BYTES+1)
        closed=os.fstat(f.fileno())
    after=path.lstat()
    if (len(data)>MAX_INPUT_BYTES or len(data)!=before.st_size or
        before.st_mtime_ns!=after.st_mtime_ns or before.st_size!=after.st_size or
        (before.st_dev,before.st_ino)!=(after.st_dev,after.st_ino) or
        (before.st_size,before.st_mtime_ns)!=(closed.st_size,closed.st_mtime_ns) or
        unsafe_image_entry(after) or needs_recall(closed)):
        raise ImageRefusal('IMAGE_CHANGED_DURING_READ_OR_TOO_LARGE')
    kind=header_kind(data[:32])
    if kind=='unrecognized':
        raise ImageRefusal('UNKNOWN_IMAGE_HEADER_FOR_'+path.suffix.lower()+': a .bin name is not proof of a BMP image')
    if kind=='bmp':
        usable,w,h,ow,oh=bmp_to_png(data)
        mime='image/png'
    else:
        # Browser decodes supported PNG/JPEG/WebP; not auto-converted, no extension assumptions.
        if len(data)>MAX_EMBED_BYTES:
            raise ImageRefusal('LARGE_COMPRESSED_IMAGE_REQUIRES_CONVERSION_TO_PNG_BEFORE_LOCAL_EMBED')
        usable=data
        mime={'png':'image/png','jpeg':'image/jpeg','webp':'image/webp'}[kind]
        w,h=compressed_dimensions(data,kind)
        ow,oh=w,h
    receipt=dict(detected_format=kind,sha256=hashlib.sha256(data).hexdigest(),
                 source_bytes=len(data),
                 decoded_dimensions=[w,h] if w else None,planner_dimensions=[ow,oh] if ow else None,
                 image_downsample_factor=max(1,(w+ow-1)//ow) if ow else None,
                 note='Original image is unchanged; suggested rig positions are unverified geometric estimates')
    return b'data:'+mime.encode()+b';base64,'+base64.b64encode(usable),receipt


def make_report(image_path:Path, output_root:Path, template:Path, auto_open:bool)->Path:
    image,receipt=source_info(image_path)
    tmpl=template.read_text(encoding='utf-8')
    if tmpl.count('/*__EMBED_IMAGE__*/')!=1 or tmpl.count('/*__EMBED_META__*/')!=1:
        raise ImageRefusal('PLANNER_TEMPLATE_INTEGRITY')
    viewer_meta={k:receipt[k] for k in ('detected_format','source_bytes','sha256','decoded_dimensions','planner_dimensions')}
    info=json.dumps(viewer_meta,ensure_ascii=True).replace('<','\\u003c').replace('>','\\u003e').replace('&','\\u0026')
    final=tmpl.replace('/*__EMBED_IMAGE__*/',json.dumps(image.decode('ascii'))).replace('/*__EMBED_META__*/',info)
    output_root.mkdir(parents=True,exist_ok=True)
    for _ in range(8):
        stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S_%fZ')
        path=output_root / ('layout_'+stamp)
        try:
            path.mkdir()
            break
        except FileExistsError:
            pass
    else:
        raise ImageRefusal('UNABLE_TO_RESERVE_FRESH_OUTPUT')
    report=path/'planner.html'
    with report.open('x',encoding='utf-8') as f:f.write(final)
    (path/'image-info.json').write_text(json.dumps(receipt,indent=2,sort_keys=True)+'\n',encoding='utf-8')
    print('STATUS=SCREENSHOT_ONLY_PLANNER_CREATED')
    print('DETECTED_FORMAT='+receipt['detected_format'])
    print('REPORT_HTML='+str(report))
    print('LOCAL_IMAGE_MODE=TRUE')
    if auto_open:
        import webbrowser
        webbrowser.open(report.as_uri())
    return report


def main(argv=None)->int:
    parser=argparse.ArgumentParser(description='Offline screenshot-only rig layout experimental planner')
    parser.add_argument('--folder',type=Path,default=DEFAULT_INPUT)
    parser.add_argument('--image',type=Path,help='Optional explicit image instead of latest in folder')
    parser.add_argument('--output-root',type=Path,default=DEFAULT_OUTPUT)
    parser.add_argument('--no-open',action='store_true')
    parser.add_argument('--inspect-only',action='store_true')
    args=parser.parse_args(argv)
    try:
        selected=args.image if args.image else choose_latest(args.folder)
        if args.inspect_only:
            b=selected.read_bytes()[:32]
            print(json.dumps({'selected_name':selected.name,'extension':selected.suffix,'header_hex':b.hex(),
                'format':header_kind(b),'size':selected.stat().st_size},indent=2))
            return 0
        make_report(selected,args.output_root,Path(__file__).with_name('planner_template.html'),not args.no_open)
        return 0
    except (ImageRefusal,PermissionError,OSError) as e:
        print('STOP_NO_SOURCE_MUTATION='+str(e),file=sys.stderr)
        return 2

if __name__=='__main__':
    raise SystemExit(main())
