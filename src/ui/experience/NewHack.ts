'use client';
// "New hack" / "Create a prompt": ONE guarded action shared by the sidebar, the phone bar and Home. It asks before replacing unsaved work (confirmThen('new')),
// then starts a blank draft in the same store the Lab and the save controller use.
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { useExperience } from './ExperienceProvider.tsx';

export function useNewHack(): () => void {
  const router = useRouter();
  const { confirmThen, dispatch } = useExperience();
  return useCallback(() => confirmThen('new', () => { dispatch({ type: 'startBlank' }); router.push('/lab'); }), [confirmThen, dispatch, router]);
}
