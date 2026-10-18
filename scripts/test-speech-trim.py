import runpy, tempfile, wave
from pathlib import Path
import numpy as np
trim = runpy.run_path(str(Path(__file__).resolve().parents[1]/'backend/trim-speech.py'))['trim_speech_file']
rate=16000
speech=(np.sin(np.arange(rate)*2*np.pi*220/rate)*10000).astype('<i2')
data=np.concatenate([np.zeros(rate//2,dtype='<i2'),speech,np.zeros(rate//2,dtype='<i2')])
with tempfile.TemporaryDirectory() as folder:
    file=Path(folder)/'fixture.wav'
    with wave.open(str(file),'wb') as out:
        out.setnchannels(1);out.setsampwidth(2);out.setframerate(rate);out.writeframes(data.tobytes())
    duration=trim(file)
    with wave.open(str(file),'rb') as source:
        result=np.frombuffer(source.readframes(source.getnframes()),dtype='<i2')
        assert source.getframerate()==rate
    assert abs(duration-1.2)<0.011
    assert np.array_equal(result[int(rate*.08):int(rate*.08)+rate],speech)
print('Silence trim: rate and every speech sample preserved; exterior padding reduced to 80/120 ms.')
