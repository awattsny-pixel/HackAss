// /robots.txt: a private preview asks every crawler to stay away. This is supplementary: the preview's protection is access control, not this file.
import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', disallow: '/' } };
}
