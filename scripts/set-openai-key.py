"""Store an OpenAI key locally without echoing it or changing the selected mode."""
import getpass
import os
from pathlib import Path
import re
import tempfile


def main():
    target = Path(__file__).resolve().parents[1] / 'backend' / '.env.local'
    key = getpass.getpass('OpenAI API key (hidden): ').strip()
    if not re.fullmatch(r'sk-[A-Za-z0-9_-]{20,}', key):
        raise SystemExit('Invalid key format. No file was changed.')
    lines = target.read_text().splitlines() if target.exists() else []
    lines = [line for line in lines if not re.match(r'^\s*OPENAI_API_KEY\s*=', line)]
    lines.append('OPENAI_API_KEY=' + key)
    fd, temporary = tempfile.mkstemp(prefix='.openai-key-', dir=target.parent)
    try:
        with os.fdopen(fd, 'w') as handle:
            handle.write('\n'.join(lines) + '\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
        target.chmod(0o600)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print('API key saved locally. Restart the dubbing server to use it.')


if __name__ == '__main__':
    main()
