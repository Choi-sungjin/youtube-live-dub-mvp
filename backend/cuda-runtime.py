"""Register NVIDIA's optional pip DLLs without changing system PATH settings."""
import os
import sys
from pathlib import Path

handles = []
if os.name == 'nt':
    bins = list((Path(sys.prefix) / 'Lib/site-packages/nvidia').glob('*/bin'))
    handles = [os.add_dll_directory(str(folder)) for folder in bins]
    os.environ['PATH'] = os.pathsep.join(map(str, bins)) + os.pathsep + os.environ.get('PATH', '')
