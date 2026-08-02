/** Resolve the bot's public HTTPS base URL from platform env vars. */
export function resolvePlatformPublicUrl(): string | null {
  const explicit = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;

  const render = (process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
  if (render) return render;

  const railway = (process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  if (railway) return `https://${railway}`;

  return null;
}
