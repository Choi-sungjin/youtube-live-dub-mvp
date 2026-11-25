"""Remove only quiet exterior padding; preserve all interior samples and rate."""
import wave
import numpy as np

def trim_speech_file(path):
    with wave.open(str(path), 'rb') as source:
        params=source.getparams()
        raw=source.readframes(source.getnframes())
    if params.sampwidth != 2: return params.nframes / params.framerate
    samples=np.frombuffer(raw,dtype='<i2').reshape(-1,params.nchannels)
    frame=max(1,round(params.framerate*0.01))
    energy=np.array([np.sqrt(np.mean((samples[i:i+frame].astype(float)/32768)**2)) for i in range(0,len(samples),frame)])
    active=np.flatnonzero(energy > 0.0003)
    if not len(active): return params.nframes / params.framerate
    start=max(0,int(active[0]*frame-params.framerate*0.08))
    end=min(len(samples),int((active[-1]+1)*frame+params.framerate*0.12))
    trimmed=samples[start:end].copy()
    ramp=min(max(1,round(params.framerate*0.005)),len(trimmed)//8)
    if ramp > 1:
        gain=0.5*(1.0-np.cos(np.pi*np.arange(ramp)/ramp)).reshape(-1,1)
        trimmed[:ramp]=np.round(trimmed[:ramp].astype(float)*gain).astype('<i2')
        trimmed[-ramp:]=np.round(trimmed[-ramp:].astype(float)*gain[::-1]).astype('<i2')
    with wave.open(str(path), 'wb') as target:
        target.setparams(params)
        target.writeframes(trimmed.tobytes())
    return (end-start)/params.framerate
