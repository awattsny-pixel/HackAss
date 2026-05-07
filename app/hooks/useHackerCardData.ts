import { useState, useCallback } from 'react';
import { HackerCardData } from '@/app/lib/user-cache';

export function useHackerCardData(username: string) {
  const [data, setData] = useState<HackerCardData | null>(null);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    if (data) return; // Already loaded
    
    setLoading(true);
    try {
      const response = await fetch(`/api/users/${username}/card-data`);
      if (!response.ok) throw new Error('Failed to fetch card data');
      
      const cardData = await response.json();
      setData(cardData);
    } catch (error) {
      console.error('Error fetching hacker card data:', error);
    } finally {
      setLoading(false);
    }
  }, [username, data]);

  return { data, loading, fetch };
}
