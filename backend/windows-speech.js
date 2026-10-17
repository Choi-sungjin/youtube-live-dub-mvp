import { spawn } from 'node:child_process';
import { readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export async function synthesizeWindowsSpeech({ text, settings, outputPath }) {
  if (process.platform !== 'win32') throw new Error('Windows speech is available only on a Windows local backend.');
  const temporaryPath = `${outputPath}.${randomUUID()}.wav`;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./windows-speech.ps1', import.meta.url))], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let errorText = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Windows speech timed out after 30 seconds.')); }, 30000);
      child.stderr.on('data', chunk => { errorText += chunk.toString('utf8'); });
      child.stdout.resume();
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.stdin.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Windows speech failed: ${errorText.trim().slice(0, 500) || `exit ${code}`}`));
      });
      // Text is passed as data through stdin, never interpolated into shell code.
      child.stdin.end(JSON.stringify({ text, language: settings.targetLang, speed: settings.speed, outputPath: temporaryPath }));
    });
    const data = await readFile(temporaryPath);
    const duration = wavDuration(data);
    await rename(temporaryPath, outputPath);
    return { duration, ttsModel: 'windows-sapi' };
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export function wavDuration(data) {
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Speech output is not a WAV file.');
  let byteRate = 0;
  let audioBytes = 0;
  for (let offset = 12; offset + 8 <= data.length;) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (offset + 8 + size > data.length) throw new Error('Speech WAV is truncated.');
    if (id === 'fmt ' && size >= 16) byteRate = data.readUInt32LE(offset + 16);
    if (id === 'data') audioBytes += size;
    offset += 8 + size + size % 2;
  }
  if (!byteRate || !audioBytes) throw new Error('Speech WAV contains no audio.');
  return audioBytes / byteRate;
}
