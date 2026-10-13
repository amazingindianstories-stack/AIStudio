import json
import math
from .image_prep import vision_request,response_text
from .vision_templates import T


def _clamp(value):
    try:
        number = float(value or 0)
        return max(0,min(100,number)) if math.isfinite(number) else None
    except (TypeError,ValueError):
        return None


def _judge(reference,candidate,extended,*,env=None,transport=None,signal=None):
    try:
        result = vision_request([{'text':'IMAGE 1 — ground-truth reference face of a specific person:'},
            {'inlineData':{'mimeType':reference['mimeType'],'data':reference['data']}},
            {'text':'IMAGE 2 — a generated cinematic frame whose main character is supposed to be that exact person:'},
            {'inlineData':{'mimeType':candidate['mimeType'],'data':candidate['data']}},
            {'text':T['candidateJudge' if extended else 'identityJudge']}],env=env,transport=transport,signal=signal)
        if result is None or not result.ok:
            return None
        parsed = json.loads(response_text(result))
        fields = ('identity','prominence','sharpness') if extended else ('identity',)
        scores = {field:_clamp(parsed[field]) if field in parsed else None for field in fields}
        if any(score is None for score in scores.values()):
            return None
        return scores if extended else scores['identity']
    except Exception:
        if signal:
            signal.check()
        return None


def judge_identity(reference,candidate,signal=None,**kwargs):
    return _judge(reference,candidate,False,signal=signal,**kwargs)


def judge_candidate(reference,candidate,signal=None,**kwargs):
    return _judge(reference,candidate,True,signal=signal,**kwargs)


def select_best_candidate(scores,slack=8):
    maximum = max((score['identity'] if score else -1 for score in scores),default=-1)
    if maximum == -1:
        return 0
    eligible = [(index,score) for index,score in enumerate(scores) if score and score['identity'] >= maximum-slack]
    return max(eligible,key=lambda item:(item[1]['prominence']+item[1]['sharpness'],item[1]['identity'],-item[0]))[0] if eligible else 0
