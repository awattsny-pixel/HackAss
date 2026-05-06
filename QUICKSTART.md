# Hack Aggregator - Quick Start Guide

## Get Running in 3 Steps

### 1️⃣ Install Dependencies
```bash
cd frontend
npm install
```

### 2️⃣ Start Development Server
```bash
npm run dev
```

### 3️⃣ Open in Browser
```
http://localhost:3000
```

**That's it!** You should see the HackAgg feed with sample data.

---

## What You'll See

### Homepage (HackFeedPage)
- Dark-themed feed showing hack cards
- Scroll with mouse wheel to navigate
- Click ❤️ to like, 🔖 to save, 📤 to share
- See live vote counts update

### Current Features
✅ Full-screen card stack  
✅ Smooth scroll navigation  
✅ Like/Save/Share interactions  
✅ Creator profiles  
✅ Category badges  
✅ Glassmorphic design  

### Components Ready to Explore
Once running, you can manually navigate to see other components:

**HackDetailPage** - Shows detailed hack view
- Expandable sections (Overview, Technical, Getting Started)
- Comments section
- Creator profile with follow button
- Like, save, share actions

**HackExplorePage** - Shows discovery grid
- Search bar for finding hacks
- Category filters (9 categories)
- Responsive grid (3 columns on desktop)
- Individual hack cards with actions

---

## File Structure

```
frontend/
├── app/
│   ├── components/
│   │   ├── HackFeedPage.tsx       ← Main homepage component
│   │   ├── HackDetailPage.tsx     ← Detail view
│   │   └── HackExplorePage.tsx    ← Discovery grid
│   ├── page.tsx                   ← Routes to HackFeedPage
│   └── globals.css                ← Tailwind config
├── package.json                   ← Dependencies
├── COMPONENTS.md                  ← Component documentation
└── SETUP_SUMMARY.md              ← Full setup details
```

---

## Sample Data

All components include pre-populated sample data:
- **5 hacks** in the feed (FeedPage)
- **1 hack detail** with comments (DetailPage)
- **8 hacks** in the grid (ExplorePage)

No backend connection yet—all data is hardcoded.

---

## Next Steps

### When Ready to Connect Backend:

1. **Set up environment variables** (`.env.local`)
   ```
   NEXT_PUBLIC_API_URL=http://localhost:3001
   ```

2. **Create API service** (`app/services/api.ts`)
   ```typescript
   export const hackApi = {
     getHacks: () => fetch(`${API_BASE}/hacks`),
     getDetail: (id) => fetch(`${API_BASE}/hacks/${id}`),
   };
   ```

3. **Update components** to use API instead of sample data
   ```typescript
   useEffect(() => {
     hackApi.getHacks().then(setHacks);
   }, []);
   ```

See **COMPONENTS.md** for detailed integration instructions.

---

## Troubleshooting

### Port 3000 in use?
```bash
npm run dev -- -p 3001
```

### lucide-react error?
```bash
npm install lucide-react --save
```

### Tailwind styles missing?
```bash
rm -rf .next
npm run dev
```

### Scroll not working?
- Use mouse wheel (not trackpad scroll)
- Check browser console for errors

---

## Development Commands

```bash
# Start dev server (with hot reload)
npm run dev

# Build for production
npm build

# Start production server
npm start

# Run linting
npm run lint
```

---

## Technology Stack

| Tech | Version | Purpose |
|------|---------|---------|
| Next.js | 16.2.4 | React framework |
| React | 19.2.4 | UI library |
| TypeScript | 5 | Type safety |
| Tailwind CSS | 4 | Styling |
| lucide-react | 0.408.0 | Icons |

---

## What's Working

✅ Full-screen card navigation (HackFeedPage)  
✅ Expandable sections (HackDetailPage)  
✅ Search and filtering (HackExplorePage)  
✅ Like/Save/Share buttons (all components)  
✅ Responsive design (mobile → desktop)  
✅ Glassmorphic styling  
✅ Dark theme  
✅ TypeScript type safety  

## What Needs Backend

❌ Real data persistence  
❌ User authentication  
❌ Comments saving  
❌ Like/save persistence  
❌ Creator profiles  
❌ Image uploads  

---

## Questions?

- See **COMPONENTS.md** for component API details
- See **SETUP_SUMMARY.md** for full documentation
- Check GitHub repos:
  - Backend: https://github.com/awattsny-pixel/hack-aggregator-backend
  - Frontend: https://github.com/awattsny-pixel/HackAss

---

**Ready?** Run `npm install && npm run dev` and start hacking! 🚀
