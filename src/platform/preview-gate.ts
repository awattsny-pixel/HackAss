// The private-preview gate: WHICH paths a preview deployment serves, and WHICH headers every response carries. Pure (no environment, no Next.js import): the SAME rules
// are (1) turned into rewrites, a redirect and headers by next.config.js at BUILD time, and (2) evaluated by `decidePath` for tests and documentation. A test builds both and
// compares them, so they cannot drift.
//
// WHY next.config and not a proxy/middleware file: with a proxy present Next.js clones and buffers EVERY request body in memory before the route runs
// (experimental.proxyClientMaxBodySize, 10 MB by default). That would defeat the streaming body limit and the 3-second body deadline of the Auth and saved-work handlers
// (PX-2b/PX-3b). Rewrites, redirects and headers from next.config touch no request body. tests/preview-gate.test.ts forbids a proxy.ts / middleware.ts.
//
// This is a SAFETY NET, not the access protection. The preview needs real access control in front of it (docs/px3d); noindex and a path allowlist only reduce what a visitor who
// got through can reach and keep crawlers out. Nothing here authenticates anyone.
//
// Mode: a build/deployment is in PREVIEW mode unless APP_ENV is explicitly `local` or `ci` (and PREVIEW_GATE is not `on`). Staging, production, a missing and an invalid APP_ENV all
// fail CLOSED into preview mode, and PREVIEW_GATE=off cannot switch the gate off outside local/ci. The mode is fixed at BUILD time (rewrites are compiled into the build); /health
// reports the built mode and says "not ready" when the runtime environment is preview but the build was not.
export type GateMode = 'open' | 'preview';

export function gateModeFrom(appEnv: string | undefined, override: string | undefined): GateMode {
  const local = appEnv === 'local' || appEnv === 'ci';
  if (!local) return 'preview';                      // staging, production, unset, anything else: closed
  return override === 'on' ? 'preview' : 'open';     // local/ci: open for development unless the gate is asked for explicitly
}

/** The only files under public/ the preview serves (the experience's artwork). Anything else in public/ is refused. Keep in step with public/ (a test asserts it). */
export const PUBLIC_ASSETS: readonly string[] = Object.freeze(['/hack/hack-official.png', '/mascot.png', '/default-avatar.svg', '/default-hacker-avatar.png']);
const ASSET_SET: ReadonlySet<string> = new Set(PUBLIC_ASSETS);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every route the private preview serves, as regular-expression SOURCES without the leading slash and without anchors. Everything else (the legacy pages, `/api/**`,
 * `/auth/login`, `/auth/signup`, `/states`, any unknown path) is refused. `_next/image` is allowed here and then constrained to the preview's own artwork by a second rule.
 */
export const ALLOWED_SOURCES: readonly string[] = Object.freeze([
  'health', 'robots\\.txt',
  'spark(?:/catalog/[^/]+|/demo(?:/[^/]+)?)?', 'lab', 'reveal',
  'account/(?:sign-in|recover|prompts|results)', 'account/(?:prompts|results)/[^/]+',
  'auth/(?:callback|callback/exchange|recovery/request|session|session/verified|set-password|sign-in|sign-out)',
  'work/(?:prompts|prompts/[^/]+|prompts/[^/]+/results|saves|results|results/[^/]+|export)',
  '_next/static/.+', '_next/image',
  ...PUBLIC_ASSETS.map((a) => escapeRe(a.slice(1))),
]);
const ALLOWED = ALLOWED_SOURCES.map((s) => new RegExp(`^/${s}$`));

export type GateDecision = { readonly kind: 'allow' } | { readonly kind: 'redirect'; readonly to: string } | { readonly kind: 'block' };
const ALLOW: GateDecision = Object.freeze({ kind: 'allow' });
const BLOCK: GateDecision = Object.freeze({ kind: 'block' });

/** The decision the built rules make, as a function (tests and documentation). The built rewrites decide by path (and, for the image optimizer, the `url` query value); methods are decided by the route itself. */
export function decidePath(method: string, pathname: string, searchParams: { get(name: string): string | null }): GateDecision {
  const m = method.toUpperCase();
  if (pathname === '/') return m === 'GET' || m === 'HEAD' ? { kind: 'redirect', to: '/spark' } : BLOCK;
  if (pathname === '/_next/image') { const u = searchParams.get('url'); return u !== null && ASSET_SET.has(u) ? ALLOW : BLOCK; }  // the optimizer is an outbound-fetch surface: only the preview's own artwork
  return ALLOWED.some((r) => r.test(pathname)) ? ALLOW : BLOCK;
}

const HEADER_BASE = (https: boolean): readonly (readonly [string, string])[] => [
  ['X-Robots-Tag', 'noindex, nofollow, noarchive'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()'],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
  ...(https ? [['Strict-Transport-Security', 'max-age=15552000'] as const] : []),
];
/**
 * Headers every page and asset carries in addition to the base set. They are NOT applied to `/auth/**`: the email-link pages and the Auth handlers set their own stricter
 * CSP (`default-src 'none'`), framing and referrer headers, and a second, looser set must never replace or duplicate them.
 * The CSP is deliberately honest: Next.js hydration needs inline scripts and React uses inline styles, so `script-src` and `style-src` keep 'unsafe-inline'. It still forbids
 * framing, plugins, base-tag and form-target tricks, third-party connections and third-party scripts.
 */
const HEADER_PAGES = (https: boolean): readonly (readonly [string, string])[] => [
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'same-origin'],
  ['Content-Security-Policy', ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self' data:", "connect-src 'self'",
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'", ...(https ? ['upgrade-insecure-requests'] : [])].join('; ')],
];
export interface NextHeaderRule { readonly source: string; readonly headers: readonly { readonly key: string; readonly value: string }[] }
export interface NextRewriteRule { readonly source: string; readonly destination: string; readonly missing?: readonly { readonly type: 'query' | 'header'; readonly key: string; readonly value?: string }[] }
export interface NextRedirectRule { readonly source: string; readonly destination: string; readonly permanent: false }
const kv = (pairs: readonly (readonly [string, string])[]) => pairs.map(([key, value]) => ({ key, value }));

/**
 * The ORIGIN LOCK. Access protection sits at an edge in front of the host (an identity-aware proxy). On hosts that cannot restrict inbound traffic to that edge's addresses, the origin
 * would stay reachable directly and the edge could be bypassed. The lock closes that: the edge adds the header below with a shared secret to every request it forwards, and a preview
 * build answers everything WITHOUT the exact value with the same uniform 404 (only `/health` is exempt, for the host's own health check). The secret is a BUILD-time value (it is compiled
 * into the rewrite rules; set EDGE_LOCK_SECRET in the build environment) and travels in a request header, never in a URL.
 */
export const EDGE_LOCK_HEADER = 'x-hackass-edge';
export const EDGE_LOCK_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

/** What next.config.js installs in PREVIEW mode. `https` is true for staging/production builds (HSTS and upgrade-insecure-requests are sent only then). `edgeLockSecret`, when given, adds the origin lock. */
export function gateConfig(https: boolean, edgeLockSecret?: string): { headers: readonly NextHeaderRule[]; rewrites: readonly NextRewriteRule[]; redirects: readonly NextRedirectRule[] } {
  const assetsRe = PUBLIC_ASSETS.map(escapeRe).join('|');
  if (edgeLockSecret !== undefined && !EDGE_LOCK_SECRET_PATTERN.test(edgeLockSecret)) throw new Error('EDGE_LOCK_SECRET must be 32 to 128 characters of A-Z a-z 0-9 _ -');
  const lock: readonly NextRewriteRule[] = edgeLockSecret === undefined ? [] : [{ source: '/:gate((?!health$).+)', missing: [{ type: 'header', key: EDGE_LOCK_HEADER, value: `^${edgeLockSecret}$` }], destination: '/gate-blocked' }];
  return {
    headers: [
      { source: '/:path*', headers: kv(HEADER_BASE(https)) },
      { source: '/:gate((?!auth(?:/|$)).*)', headers: kv(HEADER_PAGES(https)) },
    ],
    rewrites: [
      ...lock,   // first: a request that did not come through the edge is refused before anything else is considered
      // the image optimizer: only the preview's own artwork may go through it (no outbound fetch)
      { source: '/_next/image', missing: [{ type: 'query', key: 'url', value: `(?:${assetsRe})` }], destination: '/gate-blocked' },
      // everything not allowed, any method, is answered by one uniform 404 route (which is itself excluded from the rule so it can never loop)
      { source: `/:gate((?!(?:gate-blocked|${ALLOWED_SOURCES.join('|')})$).+)`, destination: '/gate-blocked' },
    ],
    redirects: [{ source: '/', destination: '/spark', permanent: false }],
  };
}

/** The headers as one flat object for a page (tests and documentation): base plus page headers. */
export function previewHeaders(https: boolean): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries([...HEADER_BASE(https), ...HEADER_PAGES(https)].map(([k, v]) => [k.toLowerCase(), v])));
}
