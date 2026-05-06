# API Specification - Hack Aggregator Backend

**Created**: Wednesday, April 29, 2026  
**Status**: Ready for review  
**Base URL**: `http://localhost:3001`  
**API Version**: 1.0.0  

---

## Authentication Overview

All endpoints marked `🔐` require JWT token in `Authorization: Bearer <token>` header.

JWT generated at login/register contains:
- `userId` (Prisma ID)
- `email` (for audit logging)
- Expires in 7 days

---

## Error Response Format

All errors return JSON with this structure:

```json
{
  "error": "Error message",
  "code": "ERROR_CODE",
  "details": {} // optional, for validation errors
}
```

Common HTTP status codes:
- `200` OK
- `201` Created
- `400` Bad Request (validation failure)
- `401` Unauthorized (missing/invalid token)
- `403` Forbidden (insufficient permissions)
- `404` Not Found
- `409` Conflict (e.g., duplicate hack)
- `500` Server Error

---

## 1. Authentication Routes

### `POST /api/auth/register`

Create new user account.

**Request**:
```json
{
  "email": "user@example.com",
  "username": "johndoe",
  "password": "secure_password_min_8_chars"
}
```

**Validation**:
- Email: valid format, must not exist
- Username: 3-20 chars, alphanumeric + underscore, must not exist
- Password: minimum 8 chars (backend enforces; frontend warns)

**Response** (201):
```json
{
  "id": "user_123abc",
  "email": "user@example.com",
  "username": "johndoe",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": "7d"
}
```

**Errors**:
- `400` - Email already exists
- `400` - Username already exists
- `400` - Password too weak
- `400` - Invalid email format

---

### `POST /api/auth/login`

Authenticate user and get JWT token.

**Request**:
```json
{
  "email": "user@example.com",
  "password": "secure_password_min_8_chars"
}
```

**Response** (200):
```json
{
  "id": "user_123abc",
  "email": "user@example.com",
  "username": "johndoe",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": "7d"
}
```

**Errors**:
- `401` - Invalid email or password
- `400` - Missing required fields

---

### `GET /api/auth/me` 🔐

Get current authenticated user profile.

**Response** (200):
```json
{
  "id": "user_123abc",
  "email": "user@example.com",
  "username": "johndoe",
  "createdAt": "2026-04-15T10:30:00Z"
}
```

**Errors**:
- `401` - Token missing or invalid

---

## 2. Hacks Routes

### `GET /api/hacks`

List all published hacks with filtering and pagination.

**Query Parameters**:
- `page` (default 1) - pagination page
- `limit` (default 20, max 100) - items per page
- `category` (optional) - filter by category slug
- `sort` (default "trending") - `trending`, `newest`, `popular`, `alphabetical`
- `search` (optional) - full-text search on title + description
- `status` (default "published") - admin only: `published`, `pending`, `rejected`

**Response** (200):
```json
{
  "data": [
    {
      "id": "hack_xyz123",
      "title": "Boil water faster with salt",
      "description": "Add salt to water increases boiling point...",
      "imageUrl": "https://cdn.example.com/hack_xyz123.jpg",
      "category": {
        "id": "cat_001",
        "name": "Cooking & Kitchen",
        "slug": "cooking-kitchen"
      },
      "createdBy": {
        "id": "user_123abc",
        "username": "johndoe"
      },
      "voteCount": 42,
      "viewCount": 156,
      "status": "published",
      "createdAt": "2026-04-15T10:30:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 347,
    "totalPages": 18
  }
}
```

**Query Examples**:
- `GET /api/hacks?sort=popular` - Most popular hacks
- `GET /api/hacks?category=cooking-kitchen` - All cooking hacks
- `GET /api/hacks?search=salt` - Search for "salt"
- `GET /api/hacks?category=cooking-kitchen&sort=newest&page=2` - Combined filters

---

### `GET /api/hacks/:id`

Get single hack with full details.

**Response** (200):
```json
{
  "id": "hack_xyz123",
  "title": "Boil water faster with salt",
  "description": "Add salt to water increases boiling point...",
  "steps": [
    {
      "number": 1,
      "text": "Add 1 tsp salt per liter of water"
    },
    {
      "number": 2,
      "text": "Bring to boil"
    }
  ],
  "whyItWorks": "Salt increases water boiling point by ~1°C per gram",
  "imageUrl": "https://cdn.example.com/hack_xyz123.jpg",
  "sourceUrl": "https://example.com/boiling-tips",
  "sourceType": "blog",
  "attributionText": "From Example.com Blog",
  "licenseType": "cc-by-4.0",
  "category": {
    "id": "cat_001",
    "name": "Cooking & Kitchen",
    "slug": "cooking-kitchen"
  },
  "createdBy": {
    "id": "user_123abc",
    "username": "johndoe"
  },
  "voteCount": 42,
  "viewCount": 156,
  "status": "published",
  "userVote": "upvote", // null if not authenticated
  "createdAt": "2026-04-15T10:30:00Z"
}
```

**Errors**:
- `404` - Hack not found
- `403` - Hack exists but is not published (unless user is editor/admin)

---

### `POST /api/hacks` 🔐

Create new hack (saved as draft).

**Request**:
```json
{
  "title": "Boil water faster with salt",
  "description": "Add salt to water increases boiling point...",
  "steps": [
    { "number": 1, "text": "Add 1 tsp salt per liter of water" },
    { "number": 2, "text": "Bring to boil" }
  ],
  "whyItWorks": "Salt increases water boiling point by ~1°C per gram",
  "categoryId": "cat_001",
  "sourceUrl": "https://example.com/boiling-tips",
  "sourceType": "blog", // "blog", "video", "book", "other"
  "attributionText": "From Example.com Blog",
  "licenseType": "cc-by-4.0" // "original", "cc-by-4.0", "public-domain", "other"
}
```

**Validation**:
- Title: 5-200 chars, required
- Description: 20-5000 chars, required
- Steps: minimum 2, maximum 20
- categoryId: must exist
- sourceUrl: valid URL if provided
- licenseType: must be one of valid values

**Response** (201):
```json
{
  "id": "hack_xyz123",
  "title": "Boil water faster with salt",
  "description": "Add salt to water increases boiling point...",
  "steps": [...],
  "categoryId": "cat_001",
  "status": "draft",
  "createdBy": {
    "id": "user_123abc",
    "username": "johndoe"
  },
  "createdAt": "2026-04-29T14:22:00Z"
}
```

**Errors**:
- `400` - Validation failed (see details)
- `401` - User not authenticated
- `409` - Potential duplicate detected (hackFingerprint match)

---

### `PUT /api/hacks/:id` 🔐

Update a hack (draft only; published hacks create submission).

**Request**: Same as POST

**Response** (200): Updated hack object

**Errors**:
- `400` - Validation failed
- `403` - User is not the hack creator
- `404` - Hack not found
- `409` - Cannot update published hack (use submissions instead)

---

### `DELETE /api/hacks/:id` 🔐

Delete a hack (draft only).

**Response** (204): No content

**Errors**:
- `403` - User is not the hack creator
- `404` - Hack not found
- `409` - Cannot delete published hack

---

## 3. Voting Routes

### `POST /api/hacks/:id/vote` 🔐

Vote on a hack (upvote, downvote, or remove vote).

**Request**:
```json
{
  "voteType": "upvote" // "upvote", "downvote", or null to remove
}
```

**Response** (200):
```json
{
  "voteType": "upvote",
  "totalVotes": 43,
  "userVotes": {
    "upvotes": 43,
    "downvotes": 0
  }
}
```

**Behavior**:
- First vote creates Vote record
- Voting same direction again is idempotent (no change)
- Changing direction updates the Vote
- Sending `voteType: null` removes the vote
- Auto-updates hack's `voteCount` denormalized field

**Errors**:
- `401` - User not authenticated
- `404` - Hack not found
- `400` - Invalid voteType

---

### `GET /api/hacks/:id/votes`

Get vote summary for a hack.

**Response** (200):
```json
{
  "hackId": "hack_xyz123",
  "totalVotes": 43,
  "upvotes": 43,
  "downvotes": 0,
  "userVote": "upvote" // null if not authenticated or haven't voted
}
```

---

## 4. Categories Routes

### `GET /api/categories`

List all categories with hack counts.

**Response** (200):
```json
{
  "data": [
    {
      "id": "cat_001",
      "name": "Cooking & Kitchen",
      "slug": "cooking-kitchen",
      "description": "Kitchen hacks and cooking tips",
      "hackCount": 42
    },
    {
      "id": "cat_002",
      "name": "Home & Garden",
      "slug": "home-garden",
      "description": "DIY and garden improvements",
      "hackCount": 38
    }
  ]
}
```

---

### `GET /api/categories/:slug`

Get single category with hacks.

**Query Parameters**:
- `page` (default 1)
- `limit` (default 20)
- `sort` (default "trending")

**Response** (200):
```json
{
  "id": "cat_001",
  "name": "Cooking & Kitchen",
  "slug": "cooking-kitchen",
  "description": "Kitchen hacks and cooking tips",
  "hacks": [
    { // hack object (list format) },
    { // hack object (list format) }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 42,
    "totalPages": 3
  }
}
```

---

## 5. Submissions Routes (User-Submitted Hacks)

### `POST /api/submissions` 🔐

Create a submission (propose changes to published hack OR new hack from non-creators).

**Request**:
```json
{
  "hackId": "hack_xyz123", // optional - if updating existing
  "title": "Boil water faster with salt",
  "description": "...",
  "steps": [...],
  "whyItWorks": "...",
  "categoryId": "cat_001",
  "sourceUrl": "...",
  "sourceType": "blog",
  "attributionText": "...",
  "licenseType": "cc-by-4.0",
  "submissionReason": "improvement" // "new_hack", "improvement", "correction"
}
```

**Response** (201):
```json
{
  "id": "sub_abc123",
  "hackId": "hack_xyz123", // null if new hack
  "status": "pending",
  "submissionReason": "improvement",
  "submittedBy": {
    "id": "user_456def",
    "username": "jane_doe"
  },
  "createdAt": "2026-04-29T14:22:00Z"
}
```

---

### `GET /api/submissions` 🔐

List submissions (admin/moderator only).

**Query Parameters**:
- `status` (default "pending") - "pending", "approved", "rejected"
- `page` (default 1)
- `limit` (default 20)

**Response** (200):
```json
{
  "data": [
    {
      "id": "sub_abc123",
      "hackId": "hack_xyz123",
      "status": "pending",
      "submissionReason": "improvement",
      "submittedBy": { "id": "user_456def", "username": "jane_doe" },
      "hack": { // full hack object with proposed changes },
      "createdAt": "2026-04-29T14:22:00Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 5, "totalPages": 1 }
}
```

**Errors**:
- `403` - User is not moderator/admin

---

### `POST /api/submissions/:id/approve` 🔐

Approve a submission (moderator only).

**Request**:
```json
{
  "notes": "Looks good!" // optional
}
```

**Response** (200):
```json
{
  "id": "sub_abc123",
  "status": "approved",
  "hackId": "hack_xyz123",
  "approvedAt": "2026-04-29T14:25:00Z",
  "approvedBy": { "id": "admin_123", "username": "admin" }
}
```

**Side Effects**:
- If `hackId` is null (new hack submission), creates new published hack
- If `hackId` exists, updates hack with submitted changes
- Hack moved to `published` status if was `pending`

---

### `POST /api/submissions/:id/reject` 🔐

Reject a submission (moderator only).

**Request**:
```json
{
  "reason": "Factually incorrect information about boiling point"
}
```

**Response** (200):
```json
{
  "id": "sub_abc123",
  "status": "rejected",
  "rejectionReason": "Factually incorrect information about boiling point",
  "rejectedAt": "2026-04-29T14:25:00Z",
  "rejectedBy": { "id": "admin_123", "username": "admin" }
}
```

---

## 6. Flag Reports Routes

### `POST /api/hacks/:id/flag` 🔐

Flag a hack as spam or inappropriate.

**Request**:
```json
{
  "reason": "spam", // "spam", "inappropriate", "duplicate", "misinformation", "copyright"
  "description": "This is a duplicate of..." // optional
}
```

**Response** (201):
```json
{
  "id": "flag_xyz123",
  "hackId": "hack_xyz123",
  "reason": "spam",
  "count": 2, // total flags for this hack+reason combo
  "flaggedAt": "2026-04-29T14:22:00Z"
}
```

**Behavior**:
- Each user can flag once per hack per reason
- Subsequent flags increment `count`
- If `count` reaches threshold (TBD), hack auto-hidden pending review
- Admin can see all flags in moderation dashboard

---

### `GET /api/hacks/:id/flags` 🔐

Get flag reports for a hack (admin only).

**Response** (200):
```json
{
  "hackId": "hack_xyz123",
  "flags": [
    {
      "reason": "spam",
      "count": 3,
      "lastFlaggedAt": "2026-04-29T14:22:00Z"
    },
    {
      "reason": "misinformation",
      "count": 1,
      "lastFlaggedAt": "2026-04-29T13:15:00Z"
    }
  ]
}
```

---

## 7. Search Routes

### `GET /api/search`

Global full-text search across hacks.

**Query Parameters**:
- `q` (required) - search query
- `page` (default 1)
- `limit` (default 20)
- `type` (default "hacks") - "hacks", "categories"

**Response** (200):
```json
{
  "query": "salt water",
  "results": [
    {
      "id": "hack_xyz123",
      "title": "Boil water faster with salt",
      "description": "...",
      "category": { "name": "Cooking & Kitchen" },
      "voteCount": 42,
      "relevanceScore": 0.95
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 3, "totalPages": 1 }
}
```

---

## 8. Health & Info Routes

### `GET /api/health`

Health check endpoint (no auth required).

**Response** (200):
```json
{
  "status": "ok",
  "timestamp": "2026-04-29T14:22:00Z",
  "version": "1.0.0"
}
```

---

### `GET /api/info`

Public app info (no auth required).

**Response** (200):
```json
{
  "name": "Hack Aggregator",
  "version": "1.0.0",
  "totalHacks": 347,
  "totalCategories": 12,
  "totalUsers": 156
}
```

---

## Request/Response Patterns

### Pagination

All list endpoints return:
```json
{
  "data": [ /* items */ ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 347,
    "totalPages": 18
  }
}
```

### Timestamps

All timestamps are ISO 8601 format with Z suffix:
- `"2026-04-29T14:22:00Z"`

### Sorting

Valid sort options vary by endpoint:
- **Hacks**: `trending` (votes + recency), `newest`, `popular` (all-time votes), `alphabetical`
- **Categories**: N/A (returned in alphabetical order)

---

## Rate Limiting (Future)

Not implemented in MVP, but endpoints are designed to support:
- 100 requests per minute per IP
- 1000 requests per day per authenticated user
- Stricter limits on write operations

---

## CORS Policy

Browser requests allowed from:
- `http://localhost:5173` (dev frontend)
- `https://hack-aggregator.vercel.app` (production)

Credentials mode: `include` (cookies sent with requests)

---

## Database Transaction Notes

The following operations are transactional:
- Creating hack + category (ensure category exists)
- Approving submission + updating hack + deleting submission
- Voting + updating hack voteCount

This ensures consistency if database connection fails mid-operation.

---

## Future Endpoints (Month 2+)

Not in MVP, but designed with these in mind:
- `GET /api/trending` - Trending hacks feed
- `GET /api/users/:username` - Public user profile
- `POST /api/hacks/:id/comments` - Comments (threaded)
- `GET /api/admin/stats` - Analytics dashboard
- `POST /api/admin/users/:id/ban` - User moderation
- `GET /api/export/csv` - Bulk export for analysis

---

**Status**: ✅ Complete and ready for frontend integration  
**Next Step**: Review with wireframes Thursday to ensure routes align with UI flows  
**Last Updated**: April 29, 2026  
