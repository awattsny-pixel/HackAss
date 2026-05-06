# Hack Aggregator - React Components

## Overview

Three main React components have been created for the Hack Aggregator frontend, converting the HTML demos to fully functional Next.js TypeScript components with glassmorphic design.

## Components

### 1. **HackFeedPage** (`app/components/HackFeedPage.tsx`)
The main feed view featuring a card stack that scrolls through hacks.

**Features:**
- Full-screen scrollable card stack with wheel event handling
- Glassmorphic card design with backdrop blur effects
- Dynamic background gradient that changes per hack
- Interactive voting system with heart button
- Save functionality with bookmark button
- Share button for social integration
- Smooth animations between cards (800ms transitions)
- Creator information display
- Category badges
- Vote counter with formatted numbers

**State Management:**
- `currentIndex`: Tracks which card is being viewed
- `hacks`: Array of hack data with like/save status
- `isAutoScrolling`: Prevents rapid scroll events

**Interactions:**
- Scroll wheel to navigate between hacks
- Click heart icon to like/unlike
- Click bookmark icon to save/unsave
- Share button ready for integration

---

### 2. **HackDetailPage** (`app/components/HackDetailPage.tsx`)
Detailed view for a single hack with expandable sections.

**Features:**
- Hero section with gradient background
- Expandable sections for Overview, Technical Details, and Getting Started
- Creator profile with follow button
- Comments section with add-comment functionality
- Like/Save/Share actions
- Vote and comment counts
- Comment threads with individual likes and replies
- Code snippets with copy-ready formatting

**Expandable Sections:**
- **Overview & Features**: Description with bullet points
- **Technical Details**: Stack, performance, dependencies info
- **Getting Started**: Installation instructions

**Interactions:**
- Click section headers to expand/collapse content
- Like, share, and save from action bar
- Add new comments with textarea
- Like individual comments
- Reply to comments (structure ready)

---

### 3. **HackExplorePage** (`app/components/HackExplorePage.tsx`)
Discovery interface with search, filtering, and grid layout.

**Features:**
- Sticky search bar with icon
- Category filter buttons (AI/ML, Web3, Libraries, etc.)
- Responsive grid layout (1 col mobile, 2 col tablet, 3 col desktop)
- Hover effects revealing card content
- Creator avatars and names
- Vote counts
- Like/Share/Save buttons on each card
- Empty state with clear filters button
- Results counter

**State Management:**
- `searchQuery`: Current search text
- `selectedCategory`: Active category filter
- `likedHacks`: Set of liked hack IDs
- `savedHacks`: Set of saved hack IDs

**Filtering:**
- Real-time search across title, description, and creator
- Category filtering with "All" option
- Combined search + category filtering

---

## Design System

### Colors & Styling
- **Dark Theme**: Black background with white text
- **Glassmorphic Effect**: `backdrop-filter: blur()` with semi-transparent backgrounds
- **Gradients**: Dynamic gradient backgrounds for visual interest
- **Spacing**: Consistent padding and margins using Tailwind

### Icon Library
All icons from `lucide-react`:
- Heart (like button)
- Bookmark (save button)
- Share2 (share button)
- ChevronDown/ChevronUp (expandable sections)
- MessageCircle (comments)
- Search (search bar)

### Animations
- **Transitions**: 0.7-0.8s ease-out for card movements
- **Bounce**: Animated chevron on scroll hint
- **Hover Effects**: Scale and color transitions on interactive elements

---

## Data Structure

### Hack Interface
```typescript
interface Hack {
  id: number;
  title: string;
  description: string;
  creator: string;
  avatar: string;          // Emoji
  votes: number;
  category: string;
  image: string;            // Gradient string
  liked?: boolean;
  saved?: boolean;
}
```

### Comment Interface (DetailPage)
```typescript
interface Comment {
  id: number;
  author: string;
  avatar: string;           // Emoji
  text: string;
  timestamp: string;
  likes: number;
}
```

---

## Next Steps

### 1. Install Dependencies
The `package.json` has been updated with `lucide-react`. Run:
```bash
cd frontend
npm install
```

### 2. API Integration
Create an API service layer in `app/services/api.ts`:
```typescript
import axios from 'axios';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export const hackApi = {
  getFeeds: () => axios.get(`${API_BASE}/hacks`),
  getDetail: (id: number) => axios.get(`${API_BASE}/hacks/${id}`),
  search: (query: string) => axios.get(`${API_BASE}/hacks/search`, { params: { q: query } }),
  like: (id: number) => axios.post(`${API_BASE}/hacks/${id}/like`),
  save: (id: number) => axios.post(`${API_BASE}/hacks/${id}/save`),
};
```

### 3. Environment Variables
Create `.env.local`:
```
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_KEY=your_supabase_key
```

### 4. Backend Integration
- Connect components to actual API endpoints
- Replace sample data with backend responses
- Implement authentication
- Add real vote/like/save persistence

### 5. Routing
Create route pages in `app/` to use components:
```
app/
  page.tsx                 (import HackFeedPage)
  detail/[id]/page.tsx    (import HackDetailPage)
  explore/page.tsx        (import HackExplorePage)
```

### 6. Additional Dependencies
When ready, install:
```bash
npm install axios          # For API calls
npm install zustand        # For global state (optional)
```

---

## Component Entry Points

- **Feed**: `/` (homepage)
- **Explore**: `/explore`
- **Detail**: `/detail/[id]`

Currently, the homepage (page.tsx) is set to display HackFeedPage. Update as needed for your routing structure.

---

## Styling Notes

All components use:
- **Tailwind CSS** for utility classes
- **Inline `style` objects** for dynamic values (gradients, colors)
- **Responsive Breakpoints**: `sm`, `md`, `lg` for mobile-first design
- **Dark Mode**: All components assume dark theme via Tailwind's `dark:` prefix support

No additional CSS files needed—everything is Tailwind + inline styles.

---

## TypeScript

All components are fully typed with TypeScript (`'use client'` directives for client-side rendering). Props and state are strictly typed for IDE autocomplete and runtime safety.

---

## Ready to Connect

The components are production-ready and waiting for:
1. Actual backend API endpoints
2. User authentication
3. Database persistence
4. Image uploads for hack galleries
5. Comment moderation system

All interactive patterns are in place—just wire them to your Supabase backend!
