// dirk.it gate for the app builder: only members carrying the signed .dirk.it
// cookie issued by gate.dirk.it may use it. Everything else is bounced to the
// sign-in page on dirk.it. Fails closed if the secret is missing so the model
// key can never be driven from an unconfigured deployment.
interface Env {
  GATE_COOKIE_SECRET: string;
  GATE_LOGIN_URL: string;
  GATE_BYPASS: string; // set to "1" only to open the builder to everyone temporarily
}

const COOKIE = 'dirkit_ai';
const OPEN_PREFIXES = ['/assets/', '/icons/'];
const OPEN_PATHS = new Set(['/favicon.svg', '/favicon.ico', '/apple-touch-icon.png', '/social_preview_index.jpg', '/robots.txt']);

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): string {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function verify(value: string, secret: string): Promise<string | null> {
  const i = value.lastIndexOf('.');
  if (i < 0) return null;
  const payload = value.slice(0, i);
  const sig = value.slice(i + 1);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  if (!safeEqual(b64url(mac), sig)) return null;
  try {
    const j = JSON.parse(fromB64url(payload));
    return typeof j.x === 'number' && j.x > Date.now() && typeof j.e === 'string' ? j.e : null;
  } catch {
    return null;
  }
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  if (OPEN_PATHS.has(url.pathname) || OPEN_PREFIXES.some((p) => url.pathname.startsWith(p))) return context.next();

  if (context.env.GATE_BYPASS === '1') return context.next();
  const secret = context.env.GATE_COOKIE_SECRET;
  if (!secret) return new Response('The app builder is not configured yet (missing gate secret).', { status: 503 });

  const cookies = context.request.headers.get('cookie') || '';
  const m = cookies.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  const email = m ? await verify(decodeURIComponent(m[1]), secret) : null;
  if (!email) {
    const login = (context.env.GATE_LOGIN_URL || 'https://dirk.it/chat/') + '?next=build';
    const wantsHtml = context.request.method === 'GET' && (context.request.headers.get('accept') || '').includes('text/html');
    return wantsHtml ? Response.redirect(login, 302) : new Response('Sign in at ' + login, { status: 401 });
  }
  return context.next();
};
