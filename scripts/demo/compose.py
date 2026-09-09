"""Label unchanged synthetic UI captures and prepare the Codex demo-reel manifest.

Run from repo root: python scripts/demo/compose.py
Then use the demo-reel skill's build_reel.py on the generated storyboard.json.
Requires Pillow. Raw images remain unchanged in the ignored capture directory.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import hashlib, json, subprocess

ROOT = Path('output/playwright/demo-usage')
ASSETS = Path('docs/assets')
FONT = Path('C:/Windows/Fonts/segoeui.ttf')
BOLD = Path('C:/Windows/Fonts/segoeuib.ttf')
# Fall back to common Linux fonts when rebuilding elsewhere.
if not FONT.exists():
    FONT = Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
    BOLD = Path('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')
font = ImageFont.truetype(str(FONT), 18)
title_font = ImageFont.truetype(str(BOLD), 26)
label = 'SYNTHETIC DEMO | Sample week: Aug 17-23, 2026 | List-price equivalents, not billing or achieved savings'
static = ['overview','workspaces','workspace-detail','sessions','session-detail',
          'recommendations','briefs','settings','glossary']
for name in static:
    raw = Image.open(ROOT/'raw'/f'{name}.png').convert('RGB')
    assert raw.size == (1440,1100), (name,raw.size)
    canvas = Image.new('RGB',(1440,1144),'#0b101c')
    canvas.paste(raw,(0,0))
    ImageDraw.Draw(canvas).text((24,1112),label,font=font,fill='#b8c7dd')
    canvas.save(ASSETS/f'{name}.png',optimize=True)

scenes = [
 ('overview','Start with a substantial week','See the scale of usage and a suggested next step.',5000),
 ('overview-limits','Check limits and costly sessions','Compare model use and context. Forecasting requires a configured limit.',5000),
 ('workspaces','Find where a change could matter','Compare workspace usage before choosing what to investigate.',5000),
 ('session-detail','Inspect one costly session','Use the session timeline and cost drivers to understand the work.',5000),
 ('recommendation-detail','Review a concrete context reduction','The dollar amount is a modeled weekly reduction, not achieved savings.',6000),
 ('recommendation-evidence','Check the evidence and assumptions','Review the source, removable tokens and pricing basis before editing.',6000),
 ('ledger','Return to inspect the effect','Separate seeded examples show improvement, measurement and inconclusive results.',7000),
]
manifest = {'title':'AgentWrangler: understand usage and choose one change',
 'note':'Synthetic historical sample. Projected reductions are not achieved savings. Ledger states are separate seeded examples.',
 'provenance':{'source_revision':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
 'source_state':'working tree; see docs/plans/demo-usage-refresh.md',
 'source_sha256':{name:hashlib.sha256(Path(name).read_bytes()).hexdigest()
                  for name in ['src/ui/api/fixtures.ts','src/ui/api/client.ts','scripts/demo/capture.js']},
 'capture_mode':'Vite --mode test; 127.0.0.1:47841; fixed clock 2026-08-24',
 'capture_commands':['npx vite --mode test --host 127.0.0.1 --port 47841 --strictPort',
 'playwright-cli -s=demo-usage run-code --filename scripts/demo/capture.js',
 'python scripts/demo/compose.py']}, 'scenes':[]}
for i,(name,title,caption,duration) in enumerate(scenes,1):
    raw = Image.open(ROOT/'raw'/f'{name}.png').convert('RGB')
    canvas = Image.new('RGB',(1440,1240),'#0b101c')
    draw = ImageDraw.Draw(canvas)
    draw.text((24,12),f'{i:02d} / {len(scenes):02d}   {title}',font=title_font,fill='#f1f5fc')
    draw.text((24,55),caption,font=font,fill='#b8c7dd')
    canvas.paste(raw,(0,96))
    draw.text((24,1208),label,font=font,fill='#b8c7dd')
    file=f'scene-{i:02d}.png'
    canvas.save(ROOT/file,optimize=True)
    manifest['scenes'].append({'file':file,'title':title,'caption':caption,'duration_ms':duration})
(ROOT/'storyboard.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
print(f'Composed {len(static)} public screenshots and {len(scenes)} reel scenes.')
