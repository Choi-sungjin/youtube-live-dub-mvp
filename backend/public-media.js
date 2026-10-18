import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function publicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a,b,c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

export async function resolvePublicMediaUrl(value, resolver = lookup) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('공개 HTTPS MP4 주소만 지원합니다. 인증 정보나 별도 포트는 사용할 수 없습니다.');
  }
  const addresses = isIP(url.hostname) ? [{ address: url.hostname, family: isIP(url.hostname) }] :
    await resolver(url.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(item => !publicIPv4(item.address))) throw new Error('로컬·사설·예약 주소의 영상은 가져올 수 없습니다. MP4 파일 선택을 이용하세요.');
  return { url, address: addresses[0].address };
}

export async function openPublicMedia(value, redirects = 0) {
  if (redirects > 4) throw new Error('영상 주소의 리다이렉트가 너무 많습니다.');
  const { url, address } = await resolvePublicMediaUrl(value);
  const response = await new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'user-agent': 'LocalLiveDub/0.7', accept: 'video/mp4,text/html;q=0.5,*/*;q=0.1' },
      // Pin the validated address, including on every redirect, to prevent DNS rebinding.
      lookup: (_host, options, cb) => options.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4)
    }, resolve);
    req.setTimeout(120000, () => req.destroy(new Error('영상 다운로드 시간이 초과되었습니다.')));
    const deadline = setTimeout(() => req.destroy(new Error('영상 다운로드 제한 시간(5분)을 넘었습니다.')), 300000);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject);
  });
  if ([301,302,303,307,308].includes(response.statusCode)) {
    response.destroy();
    if (!response.headers.location) throw new Error('이동할 영상 주소가 없습니다.');
    return openPublicMedia(new URL(response.headers.location, url).href, redirects + 1);
  }
  if (response.statusCode !== 200) { response.destroy(); throw new Error(`공개 영상 요청 실패: HTTP ${response.statusCode}. 로그인·쿠키가 필요한 영상은 지원하지 않습니다.`); }
  return { response, url };
}

export function extractVideoUrls(html, baseUrl) {
  const urls = new Set();
  for (const match of html.matchAll(/<(?:video|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    try {
      const url = new URL(match[1].replace(/&amp;/g, '&'), baseUrl);
      if (url.protocol === 'https:' && /\.mp4(?:$|[?#])/i.test(url.href)) urls.add(url.href);
    } catch {}
  }
  return [...urls];
}

export function byteRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || start > end) return null;
  return { start, end, partial: true };
}
