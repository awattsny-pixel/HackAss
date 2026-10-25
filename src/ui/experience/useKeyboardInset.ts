'use client';
// Publishes the keyboard's height as --kb on the document root and a `kb-open` class (set whenever a keyboard is open, even if the browser has panned the page so --kb is 0), so bottom-pinned controls (the Hack page's Copy bar, the guided answer box) sit above
// the on-screen keyboard instead of behind it. Nothing is stored or sent; it only reads the visual viewport.
import { useEffect } from 'react';
import { keyboardInset, keyboardOpen } from './viewport.ts';

/** `onChange` runs after the inset changes (the exchange keeps its latest message in view when the keyboard opens). */
export function useKeyboardInset(onChange?: () => void): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      const kb = keyboardInset(window.innerHeight, vv.height, vv.offsetTop);
      root.style.setProperty('--kb', `${kb}px`);
      root.style.setProperty('--vvh', `${Math.round(vv.height)}px`); // the visible area (height and where it starts): a panel that must fit above the keyboard pins itself to this
      root.style.setProperty('--vvt', `${Math.round(vv.offsetTop)}px`);
      root.classList.toggle('kb-open', keyboardOpen(window.innerHeight, vv.height));
      onChange?.();
    };
    update();
    vv.addEventListener('resize', update); vv.addEventListener('scroll', update);
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); root.style.removeProperty('--kb'); root.style.removeProperty('--vvh'); root.style.removeProperty('--vvt'); root.classList.remove('kb-open'); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- subscribed once; `onChange` only reads refs
}
