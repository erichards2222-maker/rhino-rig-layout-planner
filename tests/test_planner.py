"""Synthetic standard-library-only tests for offline screenshot input and packaging."""
import os
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
import zlib
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1] / "src"))
from image_planner import (bmp_to_png, choose_latest, source_info,
                                      header_kind, ImageRefusal, make_report)


def synthetic_bmp(width=73,height=29):
    stride=((width*3+3)//4)*4
    row=bytes((105,40,98))*width+b'\x00'*(stride-3*width)
    pixels=row*height
    file_size=54+len(pixels)
    file_header=b'BM'+struct.pack('<IHHI',file_size,0,0,54)
    dib=struct.pack('<IiiHHIIiiII',40,width,height,1,24,0,len(pixels),2835,2835,0,0)
    return file_header+dib+pixels


def decode_test_png_rgba_header(data):
    assert data.startswith(b'\x89PNG\r\n\x1a\n')
    off=8;ihdr=None;z=[]
    while off+12<=len(data):
        n=struct.unpack_from('>I',data,off)[0];tag=data[off+4:off+8];chunk=data[off+8:off+8+n]
        if tag==b'IHDR':ihdr=struct.unpack('>IIBBBBB',chunk)
        if tag==b'IDAT':z.append(chunk)
        if tag==b'IEND':break
        off+=12+n
    return ihdr,zlib.decompress(b''.join(z))


class IOTests(unittest.TestCase):
    def test_bmp_header_under_bin_extension(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'Screenshot_0010.bin';b=synthetic_bmp();p.write_bytes(b)
            image,info=source_info(p)
            self.assertTrue(image.startswith(b'data:image/png;base64,'))
            self.assertEqual(info['detected_format'],'bmp')
            self.assertEqual(info['decoded_dimensions'],[73,29])
            self.assertEqual(p.read_bytes(),b)

    def test_unknown_bin_fails_without_conversion(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'Screenshot_0010.bin';p.write_bytes(b'proprietary?'+b'X'*2000)
            with self.assertRaisesRegex(ImageRefusal,'UNKNOWN_IMAGE_HEADER'):
                source_info(p)
            self.assertEqual(p.read_bytes()[:12],b'proprietary?')

    def test_select_exact_latest_source_by_mtime(self):
        with tempfile.TemporaryDirectory() as t:
            a=Path(t)/'Screenshot_0001.bmp';b=Path(t)/'Screenshot_0002.bin';data=synthetic_bmp()
            for p in (a,b):p.write_bytes(data)
            os.utime(a,(100,100));os.utime(b,(200,200))
            self.assertEqual(choose_latest(Path(t)),b)

    def test_bmp_downscale_preserves_png_size_and_colors(self):
        raw=synthetic_bmp();png,w,h,ow,oh=bmp_to_png(raw,max_side=40)
        self.assertEqual((w,h,ow,oh),(73,29,37,15))
        ihdr,scanlines=decode_test_png_rgba_header(png)
        self.assertEqual(ihdr[:2],(37,15))
        self.assertEqual(scanlines[:4],bytes((0,98,40,105)))

    def test_truncated_bmp_rejected(self):
        with self.assertRaisesRegex(ImageRefusal,'BMP_TRUNCATED'):
            bmp_to_png(synthetic_bmp()[:76])

    def test_latest_output_separate_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);inp=root/'Screenshot_0042.bmp';inp.write_bytes(synthetic_bmp());before=inp.read_bytes()
            output=root/'outputs';template=Path(__file__).resolve().parents[1] / 'src' / 'planner_template.html'
            with redirect_stdout(StringIO()):
                first=make_report(inp,output,template,False);second=make_report(inp,output,template,False)
            self.assertNotEqual(first,second)
            self.assertEqual(inp.read_bytes(),before)
            self.assertIn('data:image/png;base64',first.read_text(encoding='utf-8'))
            self.assertTrue((first.parent/'image-info.json').exists())
            self.assertTrue(second.exists())

    def test_no_image_in_browser_only_template(self):
        txt=(Path(__file__).resolve().parents[1] / 'index.html').read_text(encoding='utf-8')
        self.assertIn('const EMBED_IMAGE = null;',txt)
        self.assertNotIn('/*__EMBED_IMAGE__*/',txt)

    def test_wrong_file_extension_sniff_is_safe(self):
        self.assertEqual(header_kind(b'BM'+b'\x00'*30),'bmp')
        self.assertEqual(header_kind(b'\x89PNG\r\n\x1a\n'),'png')
        self.assertEqual(header_kind(b'\xff\xd8\xff\x00'),'jpeg')
        self.assertEqual(header_kind(b'\x00'*40),'unrecognized')

    @unittest.skipUnless(os.name == 'nt', 'Windows PowerShell launcher')
    def test_windows_launcher_builds_viewer_from_only_the_selected_folder(self):
        launcher = Path(__file__).resolve().parents[1] / 'windows' / 'RUN_LATEST_SCREENSHOT.ps1'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / 'Screenshot_0001.bmp'
            image.write_bytes(synthetic_bmp())
            outputs = root / 'reports'
            run = subprocess.run(['powershell.exe', '-NoProfile',
                            '-File', str(launcher), '-ScreenshotFolder', str(root),
                            '-OutputFolder', str(outputs), '-PythonExecutable', sys.executable,
                            '-NoOpen'], stdin=subprocess.DEVNULL, capture_output=True,
                           timeout=30)
            error = run.stderr.decode('utf-8', errors='replace')
            if run.returncode and ('PSSecurityException' in error or 'UnauthorizedAccess' in error):
                self.skipTest('Optional PowerShell launcher is blocked by the existing execution policy; no override used.')
            self.assertEqual(run.returncode, 0, error)
            reports = list(outputs.glob('layout_*/planner.html'))
            self.assertEqual(len(reports), 1)
            self.assertIn('data:image/png;base64', reports[0].read_text(encoding='utf-8'))
            self.assertEqual(image.read_bytes(), synthetic_bmp())

if __name__=='__main__':unittest.main()
