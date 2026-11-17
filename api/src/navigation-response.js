import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
const compress = promisify(gzip);

export async function sendNavigationJson(req, res, value) {
  res.vary('Accept-Encoding');
  res.set('Cache-Control', 'private, no-store');
  if (req.get('Accept-Encoding') && req.acceptsEncodings('gzip', 'identity') === 'gzip') {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) >= 1024) {
      const buffer = await compress(json);
      return res.type('json').set('Content-Encoding', 'gzip').send(buffer);
    }
  }
  return res.json(value);
}
