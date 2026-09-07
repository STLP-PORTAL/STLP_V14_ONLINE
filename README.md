# STLP — Safety Training & Learning Portal

**Talwandi Sabo Thermal Plant**

A company-wide training, assessment, and compliance portal. Built as a single-page vanilla JavaScript app on top of **Supabase** (Postgres + Auth + Storage + Edge Functions), installable as a **PWA** with push notification support.

---

## 1. Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Plain HTML/CSS/JavaScript (no framework/build step) |
| Backend | Supabase (Postgres, Auth, Storage, Row Level Security, Edge Functions) |
| Charts | Chart.js |
| Excel import/export | SheetJS (`xlsx`) |
| PWA | Web App Manifest + Service Worker + Web Push (VAPID) |
| Edge Functions | Deno (`supabase/functions/*`) |

No `npm install` or build step is required for the frontend — it's plain static files loaded directly via `<script>` tags and CDN links.

---

## 2. Project Structure

```
STLP_V14_ONLINE-main/
├── index.html                  # App shell — loads Supabase SDK, Chart.js, SheetJS, then app scripts
├── config.js                   # Supabase URL, anon key, VAPID public key
├── app.js                      # Entire application (routing, all pages/features) — ~6,000 lines
├── certificates.js / .css      # Certificate generation, rendering, print/PDF
├── style.css                   # Global styles
├── manifest.json               # PWA manifest (icons, theme, standalone display)
├── service-worker.js           # PWA offline shell + push notification handling
├── icons/                      # App icons (192px, 512px)
├── index.ts                    # `send-push-notification` Edge Function (Web Push via VAPID)
├── storage_setup.sql           # Storage bucket + RLS policies for training materials
├── assessment_setup.sql        # Assessment module schema (questions, attempts, RLS)
├── certificate_templates_policies.sql  # V15: RLS so employees can read templates for their own certificate PDFs
└── supabase/
    └── functions/
        ├── _shared/mailHelpers.ts     # Shared helpers for mail Edge Functions
        ├── mail-oauth-start/          # Begin Google OAuth flow for mail sending
        ├── mail-oauth-callback/       # Handle OAuth redirect, store tokens
        ├── mail-config/               # Save/read mail integration config
        ├── mail-status/               # Check current mail connection status
        ├── mail-toggle/               # Enable/disable email notifications
        ├── mail-test/                 # Send a test email
        └── mail-send/                 # Send actual notification emails
```

> **Note:** Some SQL files referenced in the version history below (`department_assignment.sql`, `sop_enhancements.sql`, `pretest_module.sql`, `trainers_and_security.sql`, `push_notifications_setup.sql`) were part of earlier incremental updates and may not all be present in this exact zip — check your Supabase project's migration history if you're unsure what's already applied. **Do not rerun SQL files that have already been executed once.** The `certificate_templates` table and storage bucket similarly already exist in your live project from an earlier update (not included as a SQL file here) — only run the new `certificate_templates_policies.sql` (V15) to add employee read-access.

---

## 3. Initial Setup

1. **Supabase project** — already provisioned; connection details live in `config.js`:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `VAPID_PUBLIC_KEY` (public Web Push key — safe to expose; the private key stays only in Edge Function secrets)
2. **Database** — the core schema (`profiles`, `trainings`, notifications, progress, etc.) is assumed to already exist from earlier setup. Run any *new, additive-only* SQL files listed in the version history **once each**, in any order, directly in the Supabase SQL Editor.
3. **Storage** — run `storage_setup.sql` once to create the `training-materials` bucket and its admin-only write / authenticated-read policies. Also run `certificate_templates_policies.sql` once (V15) — it only *adds* an authenticated-read policy on top of the existing admin-only `certificate_templates` table/bucket, needed for the employee-facing "My Certificates" download.
4. **Edge Functions** — deploy each function under `supabase/functions/` with the Supabase CLI, e.g.:
   ```bash
   supabase functions deploy mail-send
   supabase functions deploy mail-oauth-start
   supabase functions deploy mail-oauth-callback
   supabase functions deploy mail-config
   supabase functions deploy mail-status
   supabase functions deploy mail-toggle
   supabase functions deploy mail-test
   supabase functions deploy send-push-notification --no-verify-jwt
   supabase functions deploy admin-create-user
   supabase functions deploy admin-impersonate-user
   ```
   `--no-verify-jwt` is required for `send-push-notification` because database triggers call it without a user JWT.
5. **Secrets** — most functions reuse the default `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY` already available to Edge Functions. Push notifications additionally need `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` set under Project Settings → Edge Functions → Secrets.
6. **Serve the frontend** — this is a static site. Host `index.html` and its assets on any static host (Netlify, Vercel, GitHub Pages, S3, etc.) or open locally for testing.

---

## 4. Roles

- **Admin** — full access: manage users, trainings, assessments, library, trainers, reports, logs, integrations.
- **User (Employee)** — sees only their assigned/targeted trainings, takes pre-tests/assessments, views certificates, browses the library, gets notifications.

---

## 5. Feature Guide (A–Z by module)

### Authentication
- Employee ID / password login (`loginPage`, `login`)
- Change own password (`changeMyPasswordModal`)
- Admin can reset any user's password (`adminResetPassword`)
- Every login success/failure and logout is written to **Security Logs**

### Dashboard
- KPI cards, compliance matrix, monthly heatmap, calendar view of scheduled trainings, Chart.js visualizations (`dash`, `_buildComplianceMatrix`, `_renderHeatmap`, `_calRenderGrid`)

### Users Management (Admin)
- Add/edit/delete users, paginated + sortable table
- Bulk **Excel import/export** of users (`importExcelModal`, `exportUsersToExcel`)
- **Login as User** — admin can switch into a user's real session via a one-time server-minted token (no password needed) to complete tasks on their behalf; a banner lets admin return instantly. Fully logged in Security Logs (`impersonateUser`, `returnToAdmin`)

### Training Management
- Create/edit/publish/archive trainings
- Upload material: PPT/PPTX, PDF, images, video — shown with a real (non-simulated) upload progress ring
- Viewing: PDF/images/video open inside the portal, PPT/PPTX via Office web viewer, YouTube via embedded player
- **Department targeting** — assign a training to "All Departments" or specific departments; users only see what's targeted to them
- Optional **Google Meet** link generation for live sessions (`generateGoogleMeetLink`)

### Pre-Test + Post Assessment
- **Pre-Test** (optional, per training): a short set of questions a user must answer once before training material unlocks — not graded, just recorded (`startPretest`, `submitPretest`)
- **Post Assessment** (MCQ, 4 options per question): admin sets Passing Marks (default 90%) and Allowed Attempts; auto-scored on submit; pass/fail recorded; training marked complete on pass (`startAssessment`, `submitAssessment`)
- **Retry control** — admin can allow a retry for a failed attempt from Assessment Results
- Bulk question import/export via Excel (`importQuestionsExcelModal`, `downloadQuestionExcelFormat`)

### Certificates
- Auto-generated certificate on passing an assessment, and a separate declaration-style certificate flow
- Print / save as PDF (`showCertificate`, `showDeclarationCertificate`, `printCertificate`), plus a one-click **Download PDF** that renders onto the training's certificate template (`downloadCertificatePDF`, `downloadDeclarationCertificatePDF`)
- **Template Manager (Admin)** — card gallery of uploaded templates (PDF/JPG/PNG) with Preview, Duplicate, Edit, and Delete (`certificateTemplatesTab`, `duplicateCertificateTemplate`, `openUploadCertificateTemplateModal`)
- **Field Position Designer (Admin)** — per-template, number/dropdown-based placement (X%, Y%, font size, alignment, bold, color) for Employee Name, Employee ID, Training Title, Score, Certificate No., and Date; stored in the existing `field_positions` JSON column (`openFieldPositionsModal`, `saveFieldPositions`). Supported on JPG/PNG templates; PDF-type templates fall back to the plain print flow
- **My Certificates (Employee)** — real list of earned certificates (assessment-passed + declaration-completed trainings), each with View and Download PDF (`myCertificatesPage`)
- **Certificate Dashboard (Admin)** — KPIs (total issued, this month, via assessment/declaration, trainings covered, templates uploaded), filters by training/date, and CSV export (`certificateDashboardTab`, `exportCertificatesCSV`)

### Feedback
- Star-rating feedback per training after completion
- Admin feedback table with filters and **CSV export** of exactly what's on screen (`feedbackPage`, `exportFeedbackCSV`)

### Library (formerly "SOP")
- Admin can upload documents, create folders on demand, move items between folders, hide/unhide without deleting, and permanently delete (file + record)
- User upload flow: pick a title, description, and file — folder assignment is admin-only
- Every card (admin + user view) shows uploader name and full upload date/time
- Pending-approval badge and approve/reject flow (`sopPage`, `approveSop`, `rejectSop`)

### Trainers
- Certified-trainer directory (Admin only)
- Every trainer must be an existing user account; admin fills Experience, Contact Number, and uploads certificate file(s)
- "Remove Trainer" only deletes the trainer record, never the underlying login

### Notifications
- In-app notification feed with publish date & time on every card
- **Web Push** support (opt-in) via the `send-push-notification` Edge Function + VAPID keys
- Auto-notify targeted departments when a new training is published (`notifyNewTrainingAvailable`)

### Reports & Progress
- Detailed per-user / per-training progress matrix with filters
- Multiple report tabs, exportable (`reports`, `exportSelectedReport`, `exportProgressReport`)

### History (Audit Logs + Security Logs)
- **Audit Logs** — assessments, training changes, user account changes
- **Security Logs** — Login Success, Login Failed (captures the name/employee ID typed, not IP — this is a client-only app with no server to capture IP), Logout, and Admin Login-as-User events
- Both have filters and CSV download

### Meeting Attendance
- Tracks join/leave events for Google Meet–linked training sessions and computes session duration (`meetingAttendancePage`, `exportMeetingAttendanceCSV`)

### Mail Integration (Admin — Settings)
- Connect a Google account via OAuth to send real notification emails
- Test email, enable/disable notifications, disconnect
- Backed by the `mail-*` Edge Functions and `_shared/mailHelpers.ts`

### Meet Integration (Admin — Settings)
- Connect/configure Google Meet for generating live-session links from the Training form

---

## 6. Version History

| Version | Highlights |
|---|---|
| V7 | Base training portal + new Assessment module (MCQ, pass/fail, retry, admin results page) |
| V8 | Admin Training page gets an Assessment button; in-portal viewers for PDF/image/video/PPT/YouTube; assessment retry query fix; training completion no longer writes a non-existent column |
| V9 | Assessment Result + Certificate: score/pass-fail, certificate view, print/save as PDF, admin retry from Results |
| V10 | Real upload-progress overlay, department-wise training targeting, notification timestamps, Feedback CSV export, Library folders |
| V11 | Pre-Test + Post Assessment split, Admin "Login as User", Trainers directory, History → Audit Logs + Security Logs, SOP renamed to Library |
| V14 | Latest working build carried over from earlier docs — changes since V11 were not all individually documented |
| V15 (current) | Certificate module upgrade: template card gallery + Duplicate/Edit, field-position designer (`field_positions` column), real "My Certificates" page for employees, Admin Certificate Dashboard (KPIs/filters/CSV), and one-click template-backed PDF download (adds `html2canvas` + `jsPDF` via CDN) |

---

## 7. Known Placeholders / Roadmap

Per earlier project notes, the following areas may still need deeper build-out beyond their current state — verify directly in `app.js` before assuming full functionality:
- Advanced Reports customization
- Extended Notification targeting rules
- Further Progress-tracking drill-downs

---

## 8. Security Notes

- All tables are protected with Postgres **Row Level Security** (see `assessment_setup.sql` and `storage_setup.sql` for examples of the admin-vs-user policy pattern used throughout).
- The Supabase anon key in `config.js` is the public, restricted client key — safe to ship in frontend code. Service-role keys and VAPID private keys are **never** placed in frontend code; they live only in Edge Function secrets.
- Admin "Login as User" never exposes or requires the target user's password — it uses a one-time server-minted token issued by the `admin-impersonate-user` Edge Function.
