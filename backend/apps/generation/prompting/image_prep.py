import base64
import io
import json
import math
import os
import time
from urllib.parse import quote
from .vision_templates import T
from apps.generation.providers.transport import HttpTransport

API_ROOT = 'https://generativelanguage.googleapis.com/v1beta'


def prep_reference(mime_type,data):
    try:
        from PIL import Image
        with Image.open(io.BytesIO(base64.b64decode(data))) as image:
            if max(image.size) <= 2048:
                return {'mimeType':mime_type,'data':data}
            image.thumbnail((2048,2048),Image.Resampling.LANCZOS)
            if image.mode != 'RGB':
                image = image.convert('RGB')
            output = io.BytesIO()
            image.save(output,format='JPEG',quality=92)
            return {'mimeType':'image/jpeg','data':base64.b64encode(output.getvalue()).decode()}
    except Exception:
        return {'mimeType':mime_type,'data':data}


def crispen(mime_type,data):
    ext = {'image/jpeg':'.jpg[Q=80]','image/png':'.png','image/webp':'.webp[Q=80]'}.get(mime_type)
    if not ext:
        return {'mimeType':mime_type,'data':data}
    try:
        # libvips implements the same sigma/m1/m2 operation as Sharp. If the
        # optional native runtime is unavailable, preserve the original bytes.
        import pyvips
        image = pyvips.Image.new_from_buffer(base64.b64decode(data),'')
        image = image.sharpen(sigma=1,m1=0.5,m2=0.3)
        return {'mimeType':mime_type,'data':base64.b64encode(image.write_to_buffer(ext)).decode()}
    except Exception:
        return {'mimeType':mime_type,'data':data}


def vision_request(parts,*,env=None,transport=None,signal=None,thinking=False):
    env = os.environ if env is None else env
    key = env.get('GOOGLE_API_KEY')
    if not key:
        return None
    model = env.get('GEMINI_DETECT_MODEL') or 'gemini-2.5-flash'
    config = {'responseMimeType':'application/json','temperature':0}
    if thinking:
        config['thinkingConfig'] = {'thinkingBudget':0}
    transport = transport or HttpTransport(allowed_hosts=['generativelanguage.googleapis.com'])
    return transport.request('POST',f'{API_ROOT}/models/{quote(model,safe="")}:generateContent',
        headers={'Content-Type':'application/json','x-goog-api-key':key},
        body={'contents':[{'role':'user','parts':parts}],'generationConfig':config},signal=signal)


def response_text(result):
    body = result.json()
    candidates = body.get('candidates') or []
    parts = (candidates[0].get('content',{}).get('parts',[]) if candidates else [])
    return next((part['text'] for part in parts if isinstance(part.get('text'),str)),None)


def parse_box(value):
    if not isinstance(value,list) or len(value) != 4:
        return None
    try:
        ymin,xmin,ymax,xmax = [float(item or 0) for item in value]
        if not all(math.isfinite(number) for number in (ymin,xmin,ymax,xmax)) or ymax <= ymin or xmax <= xmin:
            return None
        return {'ymin':ymin,'xmin':xmin,'ymax':ymax,'xmax':xmax}
    except (ValueError,TypeError):
        return None


def detect_identity_boxes(mime_type,data,*,env=None,transport=None,signal=None,wait=None):
    wait = wait or (lambda ms:signal.wait(ms) if signal else time.sleep(ms/1000))
    for attempt in range(2):
        response = vision_request([{'inlineData':{'mimeType':mime_type,'data':data}},{'text':T['identityDetection']}],
            env=env,transport=transport,signal=signal,thinking=True)
        if response is None:
            return None
        retry = response.status == 429 or response.status >= 500
        if response.ok:
            try:
                parsed = json.loads(response_text(response))
                face = parse_box(parsed.get('face_box_2d'))
                panels = [box for item in parsed.get('panel_boxes') or [] if (box:=parse_box(item))]
                person = parsed.get('person_reference') is True or bool(face) or bool(panels)
                return {'personReference':person,'boxes':{'face':face,'panels':panels} if person and (face or panels) else None}
            except (ValueError,TypeError,AttributeError):
                retry = True
        if not retry:
            return None
        if attempt == 0:
            wait(1500)
    return None


def to_pixels(box,width,height,pad):
    w,h = (box['xmax']-box['xmin'])/1000*width,(box['ymax']-box['ymin'])/1000*height
    left = max(0,math.floor(box['xmin']/1000*width-w*pad+0.5))
    top = max(0,math.floor(box['ymin']/1000*height-h*pad+0.5))
    right = min(width,math.floor(box['xmin']/1000*width+w*(1+pad)+0.5))
    bottom = min(height,math.floor(box['ymin']/1000*height+h*(1+pad)+0.5))
    return {'left':left,'top':top,'width':right-left,'height':bottom-top} if right-left >= 64 and bottom-top >= 64 else None


def covered_by(a,b):
    x = min(a['left']+a['width'],b['left']+b['width'])-max(a['left'],b['left'])
    y = min(a['top']+a['height'],b['top']+b['height'])-max(a['top'],b['top'])
    return x*y/(a['width']*a['height']) if x > 0 and y > 0 else 0


def analyze_identity_reference(mime_type,data,max_crops=3,*,env=None,transport=None,signal=None,wait=None):
    env = os.environ if env is None else env
    unknown = {'personReference':None,'crops':[]}
    if env.get('FACE_CROP_MIDDLEWARE') == '0':
        return unknown
    try:
        detection = detect_identity_boxes(mime_type,data,env=env,transport=transport,signal=signal,wait=wait)
        if not detection:
            return unknown
        if not detection['personReference'] or not detection['boxes']:
            return {'personReference':detection['personReference'],'crops':[]}
        from PIL import Image
        with Image.open(io.BytesIO(base64.b64decode(data))) as image:
            width,height = image.size
            area = width*height
            face,panels = detection['boxes']['face'],detection['boxes']['panels']
            rects = []
            if face:
                raw_area = (face['xmax']-face['xmin'])/1000*width*(face['ymax']-face['ymin'])/1000*height
                rect = to_pixels(face,width,height,0.45)
                if rect and raw_area <= area*0.5:
                    rects.append(rect)
            for panel in panels:
                if len(rects) >= max_crops:
                    break
                rect = to_pixels(panel,width,height,0.04)
                if not rect or rect['width']*rect['height'] > area*0.85 or any(covered_by(rect,prev)>0.6 or covered_by(prev,rect)>0.6 for prev in rects):
                    continue
                rects.append(rect)
            crops = []
            for rect in rects[:max_crops]:
                crop = image.crop((rect['left'],rect['top'],rect['left']+rect['width'],rect['top']+rect['height']))
                crop.thumbnail((1536,1536),Image.Resampling.LANCZOS)
                output = io.BytesIO()
                crop.convert('RGB').save(output,format='JPEG',quality=95)
                crops.append({'mimeType':'image/jpeg','data':base64.b64encode(output.getvalue()).decode()})
            return {'personReference':True,'crops':crops}
    except Exception:
        if signal:
            signal.check()
        return unknown


def identity_crops(mime_type,data,max_crops=3,**kwargs):
    return analyze_identity_reference(mime_type,data,max_crops,**kwargs)['crops']


def detect_reference_role(mime_type,data,*,env=None,transport=None,signal=None):
    try:
        result = vision_request([{'inlineData':{'mimeType':mime_type,'data':data}},{'text':T['roleDetection']}],
            env=env,transport=transport,signal=signal,thinking=True)
        if result is None or not result.ok:
            return None
        role = json.loads(response_text(result)).get('role')
        return role if role in ('person','outfit','location','style','prop','object') else None
    except Exception:
        if signal:
            signal.check()
        return None
