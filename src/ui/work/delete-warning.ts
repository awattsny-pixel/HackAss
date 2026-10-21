/** The sentence the delete confirmation shows. The count comes from the prompt's detail, so the member sees exactly what will be removed with it. */
export function deleteWarning(resultCount: number): string {
  return resultCount > 0 ? `Deleting this prompt also permanently deletes its ${resultCount} saved result${resultCount === 1 ? '' : 's'}. This can’t be undone.` : 'Deleting this prompt permanently removes it. This can’t be undone.';
}
