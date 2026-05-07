export interface RecentHack {
  id: string;
  title: string;
  content_thumbnail: string | null;
}

export interface HackerCardData {
  id: string;
  username: string;
  avatar: string | null;
  profile_image_small_url: string | null;
  is_verified: boolean;
  bio: string | null;
  posts: number;
  followers: number;
  following: number;
  recentHacks: RecentHack[];
  isFollowing: boolean;
}
