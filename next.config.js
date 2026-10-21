// PX-3e: the private-preview gate is compiled in at BUILD time from src/platform/preview-gate.ts (Node strips the types; the same rules are tested against a real server).
// eslint-disable-next-line @typescript-eslint/no-require-imports -- next.config.js is CommonJS; the pure gate module is shared with the tests
const { gateConfig, gateModeFrom } = require('./src/platform/preview-gate.ts');
const gateMode = gateModeFrom(process.env.APP_ENV, process.env.PREVIEW_GATE);
const edgeLock = process.env.EDGE_LOCK_SECRET || undefined;   // build-time origin lock (see src/platform/preview-gate.ts); only meaningful in preview mode
const gate = gateMode === 'preview' ? gateConfig(process.env.APP_ENV === 'staging' || process.env.APP_ENV === 'production', edgeLock) : null;

/** @type {import('next').NextConfig} */
const nextConfig = {
  // an alternative build directory (local verification builds the gate and the open mode side by side)
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // the mode this build was made in, for /health (inlined at build time)
  env: { PX_BUILT_GATE: gateMode, PX_BUILT_EDGE_LOCK: gate && edgeLock ? 'on' : 'off' },
  async rewrites() { return gate ? { beforeFiles: [...gate.rewrites], afterFiles: [], fallback: [] } : []; },
  async redirects() { return gate ? [...gate.redirects] : []; },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
      },
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
      },
      {
        protocol: 'https',
        hostname: 'www.tiktok.com',
      },
      {
        protocol: 'https',
        hostname: 'www.instagram.com',
      },
      {
        protocol: 'https',
        hostname: 'instagram.com',
      },
      {
        protocol: 'https',
        hostname: 'img.youtube.com',
      },
      {
        protocol: 'https',
        hostname: 'i.vimeocdn.com',
      },
    ],
  },
  async headers() {
    if (gate) return [...gate.headers];   // preview: one coherent set (no duplicates with the open-mode rules below)
    const common = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ];
    return ['/spark/:path*', '/spark', '/lab', '/reveal', '/states', '/account/:path*'].map((source) => ({ source, headers: common }));
  },
};

module.exports = nextConfig;
