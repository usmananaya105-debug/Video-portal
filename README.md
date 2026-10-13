# Ahad School Management System

## Start the application

1. Install Node.js 20 or newer.
2. From this folder, install the dependencies listed in the included `package.json`:

   ```powershell
   npm install
   ```

3. Start the Express server (equivalent commands):

   ```powershell
   node server.js
   # or: npm start
   ```

4. Open <http://127.0.0.1:3000> in a browser. Do not open `index.html` as a `file://` URL; the browser app and API must be served by Express.

The server creates `school_system.db` and a default **Main Campus (MAIN)** branch on first start. Existing SQLite records are migrated into Main Campus; browser data is not imported.

Default initial access:

- Email and password: `msaadusman091@gmail.com` / `123456`
- Role PINs: Administrator `Saad1029`, Teacher `Saad2405`, Accountant `Saad1322`, Student `Saad1321`, Shopkeeper `Saad1321`

Self-service email sign-up creates a restricted Student account; it cannot grant Administrator access.

If recreating the project manifest manually, run `npm init -y`, then `npm install express better-sqlite3 cors googleapis` before starting the server.

The server listens on the loopback interface by default. Keep it there for local use; exposing it on a network requires an explicit CORS allowlist and HTTPS configuration. Set `ADMIN_INITIAL_PASSWORD` before first start to override the seeded administrator password. Role PINs can be changed in the application settings.

## Google Sheets integration

1. In Google Cloud, enable the Google Sheets API and create a service-account key. Store the JSON key outside this project directory; do not upload it through the browser or commit it.
2. Configure the server with either `GOOGLE_APPLICATION_CREDENTIALS` pointing to that private JSON file or `GOOGLE_SERVICE_ACCOUNT_JSON` containing the JSON. For example, in PowerShell:

   ```powershell
   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\SchoolSecrets\google-service-account.json"
   npm start
   ```

3. Share the destination spreadsheet with the service account's `client_email` and grant it Editor access.
4. In Settings → Google Sheets, enter the spreadsheet ID or full URL, choose per-module auto-sync toggles, and save. Use **Sync All Sections Now** for a full export. The service account and key stay on the server; the browser receives only credential status.

The spreadsheet contains separate tabs for Students & Admissions, Admissions, Attendance, Timetable, Fees & Financial Ledger, Exams/Gradebook/OBE, Paper Builder/Datesheets, Staff, Parents, Events & Notices, and Branches. A full sync refreshes the base tabs with all branches. A section-level export refreshes a separate branch-suffixed tab so it does not overwrite another branch's export. Export rows carry the branch ID and record type; nested record data is serialized as JSON. Authentication secrets and image data are excluded. Auto-sync is disabled by default and can be enabled separately for each module.

## Storage and API

The browser uses an in-memory state cache backed by authenticated Express requests; it does not use browser storage for school records or sessions. SQLite stores module state and projects students, gradebook marks, fees, and attendance into queryable tables. Passwords and role PINs are salted and hashed; the session cookie is HttpOnly and the API is authenticated.

Available endpoints include:

- `POST /api/auth/login` and `POST /api/auth/logout`
- `GET /api/branches`, `POST /api/branches`, `PUT /api/branches/:id`, `DELETE /api/branches/:id`
- `POST /api/branches/active` to change the centralized administrator's active branch
- `GET /api/branches/overview` for centralized branch performance and fee totals
- `GET /api/users`, `POST /api/users`, `PUT /api/users/:id` for assigning staff accounts to branches
- `GET /api/students`, `POST /api/students`, `DELETE /api/students/:id`
- `GET /api/gradebook`, `POST /api/gradebook`
- `GET /api/datesheets`, `POST /api/datesheets`
- `GET /api/fees`, `POST /api/fees`
- `GET /api/attendance`, `POST /api/attendance`
- `GET /api/state`, `PUT /api/state`, `DELETE /api/state`
- `GET /api/integrations/google-sheets/status`, `PUT /api/integrations/google-sheets/settings`
- `POST /api/integrations/google-sheets/sync-all`, `POST /api/integrations/google-sheets/sync-module`

Branch-aware data endpoints accept `branch_id` in the query string or request body. Centralized Administrators can select any branch or review overview totals; branch administrators, teachers, and other staff are restricted to their assigned branch. Existing records are backfilled to Main Campus during schema migration. The Settings → Branch Management screen supports creating/editing branches, reviewing branch totals, and assigning branch-scoped staff logins. The Datesheet & Roll Slips workspace saves schedules per active branch, class, section, and exam term; each schedule supports reporting and paper start times. Its printable templates use the active school's branding and branch address, include weekday and DD-MM-YYYY dates, and provide board-style datesheets and one-page-per-student roll slips with candidate details, OMR roll-number guide, instructions, and signature/stamp areas.
