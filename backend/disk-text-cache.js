import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function createDiskTextCache(directory) {
  const fileFor = key => {
    if (!/^[a-f0-9]{20}$/.test(key)) throw new Error('Invalid cache key');
    return path.join(directory, `${key}.json`);
  };
  return {
    async get(key) {
      try {
        const value = JSON.parse(await readFile(fileFor(key), 'utf8'));
        return value?.key === key && typeof value.text === 'string' ? value.text : '';
      } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return '';
        console.warn(`Translation cache read skipped: ${error.code || error.name}`);
        return '';
      }
    },
    async set(key, text) {
      if (!text) return;
      const destination = fileFor(key);
      try {
        await mkdir(directory, { recursive: true });
        const temporary = `${destination}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ key, text }), 'utf8');
        await rename(temporary, destination);
      } catch (error) {
        console.warn(`Translation cache write skipped: ${error.code || error.name}`);
      }
    }
  };
}
