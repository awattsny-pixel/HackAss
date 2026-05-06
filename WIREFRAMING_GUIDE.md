# Wireframing Guide - Hack Aggregator

**Goal**: Create 2-3 main page wireframes for desktop + mobile  
**Tool**: Figma (free version is fine)  
**Time**: 2-3 hours  
**Audience**: Thursday design review with backend team

---

## Quick Figma Setup

1. Go to **https://figma.com**
2. Sign up (free account)
3. Create a new project: **"Hack Aggregator"**
4. Create frames for each page (use iPhone 14 + 1440px desktop templates)

---

## Page 1: Homepage

### Purpose
Users discover hacks, browse by category, search

### Layout (Desktop)

**Header** (top, fixed):
- Logo on left: "Hack Aggregator"
- Search bar in center
- Login/Profile button on right
- Hamburger menu (mobile)

**Featured Section**:
- Title: "Trending This Week"
- Horizontal carousel of 5 hack cards
- Each card shows: thumbnail, title, category badge, vote count, creator name

**Browse Categories**:
- Title: "Explore by Category"
- Grid of 6 category cards
- Each shows: category name, hack count (e.g., "Cooking (42)")
- Clickable to filter

**Recent Hacks**:
- Title: "Recently Added"
- Vertical list of hacks
- Each card shows: title, description (truncated), category, votes, creator

**Footer**:
- Links, copyright, social

### Layout (Mobile)

- Stack everything vertically
- Full-width cards
- Featured carousel still horizontal (scroll)
- Search bar prominent at top
- Categories as horizontal scroll

### Key Interactions

- Search bar: click to focus, type, hit Enter to search
- Category cards: click to filter hacks by that category
- Hack cards: click to go to detail page
- Vote buttons: upvote/downvote icons (we'll add later)

---

## Page 2: Hack Detail

### Purpose
Show full hack with steps, why it works, voting, flagging

### Layout (Desktop)

**Header**: Same as homepage

**Main Content Area**:

**Hack Header**:
- Large title: "Boil water faster with salt"
- Category badge: "Cooking & Kitchen"
- Creator info: "By johndoe • 2 days ago"
- Vote count: "↑ 42 votes"

**Hack Image**:
- Large featured image (if available)
- Or placeholder if no image

**Description**:
- Short description paragraph

**Steps**:
- Numbered list (1, 2, 3...)
- Each step is a box/card
- Clear, readable text
- Example:
  ```
  1. Add 1 tsp salt per liter of water
  2. Bring to boil
  3. Let cool before using
  ```

**Why It Works**:
- Explanation paragraph
- Science/reasoning behind the hack

**Attribution**:
- "Source: Example.com Blog"
- License badge: "CC-BY 4.0"
- Source link (clickable)

**Engagement Section**:
- Vote buttons: Big upvote/downvote buttons (state shows if user voted)
- Flag button: "Report hack" (small, subtle)
- Share button: (optional for now)

**Submit Improvement**:
- Button: "Suggest improvement or correction"
- Links to submission form

**Similar Hacks** (optional):
- Show 3-4 related hacks from same category
- At bottom of page

### Layout (Mobile)

- All content stacks vertically
- Larger touch targets for voting buttons
- Category and creator info inline
- Steps still numbered list
- Attribution section below content

---

## Page 3: Browse / Category Page

### Purpose
Filter and search hacks by category, sort by popularity

### Layout (Desktop)

**Header**: Same as homepage

**Filter Section**:
- Left sidebar (or top bar on mobile)
- **Category dropdown**: "All Categories" / "Cooking & Kitchen" / etc.
- **Sort dropdown**: 
  - Trending (votes + recent)
  - Most Popular (all-time votes)
  - Newest
  - Alphabetical
- **Clear Filters** button

**Results Section**:
- Grid of hack cards (3 per row)
- Each card shows:
  - Thumbnail image
  - Title
  - Brief description (2 lines)
  - Category badge
  - Vote count with upvote icon
  - Creator name
  - Created date (e.g., "2 days ago")

**Pagination**:
- "Load More" button at bottom
- Or page numbers: 1 2 3... Next

**Empty State** (if no results):
- Message: "No hacks found. Try a different category or search."
- Link back to homepage

### Layout (Mobile)

- Filter section collapses into dropdown/modal
- Cards stack in single column
- Larger cards for mobile readability
- "Load More" button easier to tap

### Key Interactions

- Click category dropdown to filter
- Click sort dropdown to reorder
- Click hack card to go to detail page
- Scroll to bottom, click "Load More" to see next 20 hacks
- All filters work together (category + sort)

---

## Design Tokens (Colors, Fonts, Spacing)

### Color Palette

**Primary Colors**:
- Brand Blue: `#2563EB` (buttons, links, highlights)
- Success Green: `#10B981` (upvote, positive actions)
- Warning Red: `#EF4444` (downvote, flag, destructive)
- Neutral Gray: `#6B7280` (secondary text, borders)

**Backgrounds**:
- White: `#FFFFFF` (main background)
- Light Gray: `#F3F4F6` (card backgrounds, hover states)
- Dark Gray: `#1F2937` (text, dark mode later)

**Text**:
- Primary Text: `#1F2937` (dark gray)
- Secondary Text: `#6B7280` (medium gray)
- Light Text: `#9CA3AF` (disabled, hints)

### Typography

**Font Family**: Inter (or Roboto as fallback)

**Heading 1** (page titles):
- Size: 32px
- Weight: Bold (700)
- Line Height: 1.2
- Example: "Boil water faster with salt"

**Heading 2** (section titles):
- Size: 24px
- Weight: Bold (700)
- Line Height: 1.3
- Example: "Featured Hacks", "Steps"

**Heading 3** (card titles, smaller headings):
- Size: 18px
- Weight: 600
- Line Height: 1.4
- Example: Hack titles in cards

**Body Text**:
- Size: 16px
- Weight: Regular (400)
- Line Height: 1.6
- Example: Descriptions, paragraphs

**Small Text** (metadata, labels):
- Size: 14px
- Weight: 500
- Color: Gray
- Line Height: 1.5
- Example: "By johndoe • 2 days ago"

**Button Text**:
- Size: 16px
- Weight: 600
- Line Height: 1.5

### Spacing Scale (Base: 8px)

- `8px` - Small gaps (between inline elements)
- `16px` - Standard padding inside cards/buttons
- `24px` - Medium spacing (between sections)
- `32px` - Large spacing (between major sections)
- `48px` - Extra large (top/bottom of page)

**Example**:
- Card padding: 16px
- Section margin bottom: 32px
- Button padding: 12px 24px (vertical, horizontal)
- Input field padding: 12px 16px

### Component Styles

**Buttons**:
- Primary Button: Blue background, white text, 16px padding, rounded corners (8px)
- Secondary Button: Light gray background, dark text
- Ghost Button: No background, just text (links)
- Hover state: Slightly darker shade

**Cards**:
- Background: White
- Border: Light gray (1px)
- Border Radius: 8px
- Padding: 16px
- Shadow: Subtle shadow on hover
- Example: Hack cards, category cards

**Inputs**:
- Border: Light gray (1px)
- Padding: 12px 16px
- Border Radius: 8px
- Focus state: Blue border (2px), blue background light tint
- Placeholder text: Medium gray

**Badges**:
- Background: Light blue or light green
- Text: Darker shade of background
- Padding: 4px 12px
- Border Radius: 20px (pill shape)
- Example: "Cooking & Kitchen", "CC-BY 4.0"

---

## Wireframe Checklist

### Homepage
- [ ] Header with logo, search, login
- [ ] Featured hacks carousel (5 cards)
- [ ] Browse categories grid (6 categories)
- [ ] Recent hacks list
- [ ] Footer
- [ ] Mobile version (stack vertically)

### Hack Detail
- [ ] Header (same as homepage)
- [ ] Hack title, category, creator info
- [ ] Featured image placeholder
- [ ] Description paragraph
- [ ] Numbered steps (3-5 steps as example)
- [ ] "Why it works" explanation
- [ ] Attribution/source info
- [ ] Vote buttons (big, prominent)
- [ ] Flag button (small, subtle)
- [ ] "Suggest improvement" button
- [ ] Mobile version

### Browse/Category
- [ ] Header (same as homepage)
- [ ] Filter sidebar: category + sort dropdowns
- [ ] Hack cards grid (3 per row)
- [ ] Each card: image, title, description, category, votes, creator
- [ ] Pagination / Load More button
- [ ] Empty state mockup
- [ ] Mobile version (single column)

---

## Design Tips

1. **Keep it simple**: Wireframes are about layout, not beauty
2. **Use rectangles and boxes**: Don't worry about exact visuals yet
3. **Label everything**: Write what each section is
4. **Think about the user**: How do they browse? Vote? Search?
5. **Mobile first**: Design mobile layout first, then expand to desktop
6. **Consistency**: Same button styles, card sizes, spacing throughout

---

## Next Steps

1. **Today/Tomorrow**: Create wireframes in Figma
2. **Thursday**: Share Figma link for design review
3. **Friday**: Refine based on feedback
4. **Next Week**: Start building components in React

---

## Example Card Structure (for reference)

```
┌─────────────────────────────┐
│ [Image placeholder]         │
├─────────────────────────────┤
│ Hack Title                  │
│ By creator • 2 days ago     │
│ Brief description goes here │
│ ↑ 42  Cooking & Kitchen    │
└─────────────────────────────┘
```

---

**Ready to start? Open Figma and create your first frame!** 🚀
