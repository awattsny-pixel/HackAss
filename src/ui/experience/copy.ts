// Clipboard export: the ONLY way text leaves the experience. Nothing is sent anywhere by HackAss.
export type CopyResult = 'copied' | 'blocked';
export async function copyText(text: string): Promise<CopyResult> {
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.append(t); t.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    t.remove();
    return ok ? 'copied' : 'blocked';
  }
}
export const COPIED = 'Copied to clipboard · nothing saved or published';
export const COPY_BLOCKED = 'Clipboard blocked here. Select the text and copy it manually.';
