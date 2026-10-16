"""Package an approved generated cat sheet; preserve alpha and original artwork.

Usage: python scripts/build-lazy-cat-theme.py INPUT.png OUTPUT-DIRECTORY
Requires Pillow. This is asset conversion, not a generation/API client.
"""
import argparse
import base64
import io
import json
from pathlib import Path
from PIL import Image

def build(source, output):
    root=Path(__file__).resolve().parent.parent
    theme=json.loads((root/'public/themes/study-desk.supermd-theme.json').read_text())
    palettes=json.loads((root/'scripts/lazy-cat-palette.json').read_text())
    image=Image.open(source).convert('RGBA')
    if image.getchannel('A').getextrema()[0]!=0:raise ValueError('Expected transparent artwork')
    image.thumbnail((1200,1200),Image.Resampling.LANCZOS)
    data=io.BytesIO();image.save(data,format='WEBP',quality=88,method=6)
    if len(data.getvalue())>512*1024:raise ValueError('Theme artwork exceeds 512 KiB')
    theme['name']='Lazy Sunday cats'
    theme['accent']='violet'
    theme['assets']={'cats':'data:image/webp;base64,'+base64.b64encode(data.getvalue()).decode()}
    for mode,variant in theme['variants'].items():
        variant['colors']=palettes[mode]
        variant['artwork']={area:{'image':'asset:cats','fit':'cover','opacity':opacity} for area,opacity in [('reader',.24 if mode=='light' else .14),('sidebar',.12),('toolbar',.08)]}
    output.mkdir(parents=True,exist_ok=True)
    (output/'lazy-sunday-cats.webp').write_bytes(data.getvalue())
    target=output/'lazy-sunday-cats.supermd-theme.json'
    target.write_text(json.dumps(theme,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'theme':str(target),'artBytes':len(data.getvalue()),'size':image.size}))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('source',type=Path);parser.add_argument('output',type=Path)
    args=parser.parse_args();build(args.source,args.output)
