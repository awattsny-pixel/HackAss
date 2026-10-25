// How much of the layout viewport the on-screen keyboard (or any other overlay that shrinks only the VISUAL viewport) covers. Small differences are the browser's own bars, not a keyboard.
export const KEYBOARD_MIN = 120;
/** Whether a keyboard is open: the visual viewport is much shorter than the layout viewport. This does not depend on the pan offset: iOS Safari pans the visual viewport by the keyboard's height to reveal the focused field, which leaves nothing "covered" at the layout bottom but the keyboard is still open. */
export function keyboardOpen(layoutHeight: number, visualHeight: number): boolean {
  return Math.round(layoutHeight - visualHeight) >= KEYBOARD_MIN;
}
/** How far up bottom-pinned controls must move to clear the keyboard: what is covered at the layout viewport's bottom. 0 when no keyboard is open, and also when the browser has already panned the page so the layout bottom is the visible bottom. */
export function keyboardInset(layoutHeight: number, visualHeight: number, visualOffsetTop: number): number {
  if (!keyboardOpen(layoutHeight, visualHeight)) return 0;
  return Math.max(0, Math.round(layoutHeight - visualHeight - visualOffsetTop));
}
