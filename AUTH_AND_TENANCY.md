# Authentication & Property Tenancy Guide

This document outlines how authentication, authorisation, and property
scoping work across the Phoenix Hospitality platform after the recent
security upgrades.

---

## Key Concepts

### Property-centric tenancy
- Every business entity (reservations, room types, folios, reports, etc.)
  stores a `property` reference (`ObjectId` → `Property`).
- Queries **must** filter by the authenticated user's `property._id`.
- `Backend/db/plugins/propertyScoped.js` is a reusable Mongoose plugin that
  injects the required `property` field and helper utilities.
- Unique indexes that used to be global now include `property` to allow the
  same code/name in different hotels.
- A **tenant database** exists per property. Each tenant database contains its
  own `Property`, `User`, reservations, folios, etc. collections. The main
  application dynamically connects to the correct tenant database based on the
  `propertyCode` carried in the JWT.

### Users & module permissions
- `Backend/db/auth/user.js` defines roles, the default module access matrix,
  and helper methods (`ROLE_MODULES`, `isModuleAllowed`, `roleModules`).
- `modules` is persisted per user, enabling custom module combinations.
- The auth middleware enriches `req.user` with `{ id, role, modules, property }`.

### JWT Authentication middleware
- `Backend/middleware/auth.js`
  - `authenticate` validates the Bearer token, loads the user & property, and
    attaches them to `req.user`.
  - `requireRole('Admin', 'Manager')` restricts an endpoint to specific roles.
  - `requireModuleAccess('front-office')` ensures the signed-in user has module
    access before proceeding.
- Use the module helper on all protected routes to prevent cross-module access.

---

## Backend Endpoints

### Auth router (`/api/auth`)
| Endpoint | Method | Description |
| --- | --- | --- |
| `/properties` | `POST` | Left in place for backwards compatibility—provisioning now happens via the CLI. |
| `/register` | `POST` | Authenticated (Admin/Manager) route to add users scoped to the caller's property. |
| `/login` | `POST` | Requires email + password + `propertyCode` (or `propertyId`) to issue JWT. |
| `/verify` | `GET` | Verifies JWT and returns user, modules, and property metadata. |

**Environment variables**
- `JWT_SECRET` – override the default development secret in production.

### Property-aware routes
All feature routers now require authentication and call `requireModuleAccess`
for the relevant module(s). They also scope queries/mutations to
`req.user.property._id`. Examples:
- Front Office: `routes/frontOffice/reservations.js`
- Distribution: `routes/distribution/*.js`
- Guest Management: `routes/guestManagement/*.js`
- Billing/Finance: `routes/billingFinance/folios.js`
- Settings: `routes/settings/settings.js`
- Reports: `routes/reports/reports.js`
- Shared foundation lookups: `routes/foundation.js`

---

## Frontend Integration

### Auth provider
- `src/context/AuthContext.tsx` wraps the app, stores the JWT, and exposes
  `login`, `logout`, and `authFetch`.
- On load it verifies any stored token (`/auth/verify`).
- `authFetch` (and a window.fetch patch) automatically attach the Bearer
  header to API calls targeting `VITE_API_BASE_URL`.

### Login flow
- `src/components/Auth/LoginPage.tsx` collects `propertyCode`, `email`, and
  `password`.
- Successful login updates context and displays the main app.

### Module-aware UI
- `App.tsx` renders the login page until auth resolves, and limits the current
  module to the signed-in user's `modules`.
- `Sidebar.tsx` filters navigation items based on `allowedModules`.

### Configuration
- Frontend env var: `VITE_API_BASE_URL` (defaults to `http://localhost:3000/api`
  via `src/config.ts`).
- After changing backend port/origin, update `.env` for both backend
  (`PORT`, `JWT_SECRET`, database URL, etc.) and frontend (`VITE_API_BASE_URL`).

---

## Operational Checklist

1. **Provision property**  
   Use the CLI (`npm run admin:create-property`) to create the tenant database
   and seed its `Property` document. The REST endpoint remains for legacy tests
   but is no longer the recommended path.
2. **Create additional users**  
   Authenticated Admin/Manager → `POST /api/auth/register`.
3. **Assign module overrides** (optional)  
   Pass `modules` when creating/updating a user to customize access.
4. **Use JWT in API clients**  
   Include `Authorization: Bearer <token>` when calling secure endpoints.
5. **Verify module guards**  
   Ensure new endpoints call `requireModuleAccess('<module-id>')` and always
   include `property` filters in queries.

---

## Testing & Troubleshooting

- Backend: exercise critical flows with tools like Postman/Thunder Client:
  1. Create property + Admin.
  2. Login with property code.
  3. Hit each module endpoint and confirm cross-property data is not visible.
- Frontend: run `npm run dev` and walk through:
  1. Login as different roles.
  2. Ensure the sidebar only lists permitted modules.
  3. Interact with records and verify only property-specific data renders.
- If you see 401s, confirm your frontend points to the correct API base URL
  and that the JWT is stored (`localStorage.phoenix_auth_token`).
- 403 responses indicate missing module permissions—update the user's
  `modules` via register route or Mongo shell.

---

## Admin CLI helper

Provisioning now happens exclusively through the CLI utilities. Run them from
the `Backend` directory:

```bash
# Create a tenant database + property record
npm run admin:create-property -- --name "Demo Hotel" --code DEMO

# Add a user to that tenant database
npm run admin:create-user -- --property-code DEMO \
  --name "Front Desk Jane" \
  --email jane.frontdesk@example.com \
  --password StrongPass!234 \
  --role "Front Desk" \
  --modules '["front-office","guest-management"]'
```

Property options:

| Flag        | Description                                                                 |
|-------------|-----------------------------------------------------------------------------|
| `--name`    | (Required) Property display name.                                           |
| `--code`    | (Required) Unique property code (case-insensitive, stored uppercase).       |
| `--db-name` | (Optional) Override the tenant database name (defaults to sanitised name).  |
| `--metadata`| (Optional) JSON string merged into `Property.metadata`.                     |

The property script will:

1. Create (if needed) an empty tenant database with collections for every schema in `db/`.
2. Seed the tenant database with its own `Property` document and indexes (no master database copy).

User options:

| Flag             | Description                                                                          |
|------------------|--------------------------------------------------------------------------------------|
| `--property-code`| (Required) Property code to attach the user to.                                      |
| `--name`         | (Required) User display name.                                                         |
| `--email`        | (Required) Unique email within the property.                                         |
| `--password`     | (Required) Plaintext password (hashed automatically).                                |
| `--role`         | (Optional) Role name; defaults to `Front Desk`.                                      |
| `--modules`      | (Optional) JSON array or comma-separated list of modules; defaults to role modules.  |
| `--status`       | (Optional) `Active` or `Inactive`; defaults to `Active`.                             |

The user script will:

1. Connect to the tenant database derived from `--property-code`.
2. Resolve the property within that tenant DB.
3. Create the user (password hashing + module defaults) directly in the tenant database.

Be sure `MONGO_URI` is configured in `Backend/.env` before executing.

---

By following the patterns above, all new features will inherit the secure,
property-scoped behaviour and consistent authentication introduced in this
release._REQUIREMENTS.md

