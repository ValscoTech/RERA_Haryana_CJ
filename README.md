# Haryana RERA Case Sync Cron Job

Automated daily cron job service that syncs case details from the Haryana Real Estate Regulatory Authority (RERA) portal into Firestore. The service programmatically fetches the public search landing page to acquire valid session cookies, scrapes case detail pages (no CAPTCHA required for detail pages), updates hearing dates in the `pending` collection, automatically transfers resolved cases to the `disposed` collection, and schedules hearing reminders in `eventReminders` using timezone-robust UTC offsets.

---

## What This Repo Does

The cron job runs automatically every night at **12:00 AM (Asia/Kolkata)** and follows this workflow:

1. Queries the Firestore `pending` collection for cases where `courtName === "RERA Haryana"`.
2. Resolves the case's unique `internalId` (from `internalId` or `rawReraData` sub-fields).
3. Fetches the Haryana RERA landing page to acquire a fresh session cookie.
4. Downloads the public detail page for each case using the session cookie.
5. Parses case details, hearing logs, judgements, and submitted documents using `cheerio`.
6. Checks if the case is **disposed**:
   - If **disposed**, copies the complete document to the `disposed` collection, sets `status` to `"disposed"`, and deletes the original document from the `pending` collection.
   - If **pending**, merges the parsed data back using `set(..., { merge: true })`.
7. Checks if the next hearing date has changed:
   - If changed, schedules two reminder documents in `eventReminders` (one at **8:00 AM IST** and one at **6:00 PM IST** on the hearing day).

---

## Repo Analysis

### Runtime
* Node.js + Express
* `axios` for all HTTP request communication.
* `cheerio` for parsing case detail tables from raw HTML.
* `firebase-admin` for database read/write transactions.
* `node-cron` for scheduling background triggers.

### Main Files
* `server.js`
  Initializes the Express server, configures CORS, and loads the daily schedule (`0 0 * * *`). Also routes test requests.
* `Routes/haryana.js`
  Declares developer endpoints:
  - `GET /api/rera/hr/cron/trigger`: Manually run the full sync cron loop.
  - `GET /api/rera/hr/cron/scrape/:internalId`: View the parsed output of a single case by its `internalId`.
* `adapters/haryana.js`
  Contains the core automation logic: fetching detail pages, dynamic table parsing, date normalization, Firestore transactions, and notification event scheduling.
* `config/firebase.js`
  Initializes the Firebase app. Supports the Firestore local emulator when `USE_EMULATOR=true`, and fallback searches for `serviceAccountKey.json` or `FIREBASE_SERVICE_ACCOUNT` environment variable.

### Important Design Notes
* **No CAPTCHA required**: While the general RERA search requires solving a CAPTCHA, direct details are public via `/assistancecontrol/searchcasedetailopen/:id`. The session cookie is obtained once from the landing page and reused across all cases in the batch run.
* **Timezone-Robust Reminders**: Firestore stores timestamps in UTC. To prevent reminders from triggering at incorrect times when the server is hosted in another region (such as UTC), reminder times are hardcoded to explicit UTC offsets:
  - **8:00 AM IST** is stored as **02:30 AM UTC**
  - **6:00 PM IST** is stored as **12:30 PM UTC**
* **Clean Transaction Flow**: Disposed cases are immediately migrated to `disposed` and purged from `pending` so they are never scraped again.

---

## Setup

```bash
npm install
npm start
```

Runs on:
```text
http://localhost:8081
```

Health check:
```bash
curl "http://localhost:8081/"
```

Sample response:
```json
{
  "service": "RERA Haryana CJ",
  "status": "running",
  "description": "Haryana RERA daily case sync cron job service",
  "cronSchedule": "0 0 * * * (daily at midnight)"
}
```

---

## Firebase Configuration

Generate a private key from the Firebase Console under **Project Settings → Service Accounts → Generate new private key**.

Save the downloaded file as:
```text
config/serviceAccountKey.json
```
*Note: This file is ignored by Git in `.gitignore`.*

In production, pass the key as a stringified JSON environment variable instead:
```text
FIREBASE_SERVICE_ACCOUNT='{"type":"service_account","project_id":"..."}'
```

To run against the local Firestore Emulator, add the following to your `.env` file:
```env
USE_EMULATOR=true
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
```

---

## Firestore Schema

### `pending` collection
Documents in this collection are matched for sync if they contain:

| Field | Type | Description |
|---|---|---|
| `courtName` | string | Must be `"RERA Haryana"` |
| `internalId` | string | The Haryana RERA internal case ID (e.g. `"55971"`) |
| `owner` | string | Firestore document ID of the owning lawyer or client |
| `nextHearingDate` | string | Stored date in `DD/MM/YYYY` format (or `"N/A"`) |

### Fields written back on each sync run
| Field | Source |
|---|---|
| `nextHearingDate` | Next Date of Hearing, normalized to `DD/MM/YYYY` |
| `lastHearingDate` | Most recent hearing date from listing history, normalized to `DD/MM/YYYY` |
| `updatedAt` | Current timestamp on every successful sync |
| `rawReraData.sections` | Object containing all parsed table sections |
| `rawReraData.complaintNo` | Formatted RERA complaint number (e.g., `RERA-GRG-3141-2024`) |

### `disposed` collection
When a case is resolved (status: `"disposed"`), it is moved to the `disposed` collection:
* A new document is written to `disposed` with the same ID.
* The field `rawReraData.status` is set to `"Disposed"`.
* The original document in the `pending` collection is deleted.

### `eventReminders` collection
Two reminder documents are created if a next hearing date changes:

| Field | Type | Description |
|---|---|---|
| `caseId` | string | Firestore document ID of the case |
| `caseNo` | string | Formatted case or complaint number |
| `eventTitle` | string | `"Petitioner VS Respondent"` (for 8:00 AM) or `"Update Next Hearing: Petitioner VS Respondent"` (for 6:00 PM) |
| `recipientId` | string | Owner's Firestore user ID |
| `reminderTime` | timestamp | Exact scheduled time in UTC (02:30 AM or 12:30 PM UTC on the hearing day) |
| `scheduledBy` | string | Owner's Firestore user ID |
| `status` | string | `"scheduled"` |
| `createdAt` | timestamp | Time of reminder creation |

---

## Developer Trigger Endpoints

During development, you can trigger actions manually without waiting for midnight:

* **Manual Sync Trigger**:
  ```bash
  curl "http://localhost:8081/api/rera/hr/cron/trigger"
  ```
  *Fires the sync job in the background.*

* **Scraper Inspection**:
  ```bash
  curl "http://localhost:8081/api/rera/hr/cron/scrape/55971"
  ```
  *Fetches and returns the parsed tables for the specified `internalId`.*

---

## Parser Output Shape

The `parseCaseDetailPage(html)` parser returns an object containing the structured data tables extracted from the HTML:

```json
{
  "complaintNo": "RERA-GRG-3141-2024",
  "sections": {
    "complaint_detail_rera_grg_3141_2024": [
      {
        "Party Dtls": "John Doe VS Jane Doe",
        "Self / Adv Name": "Self",
        "District": "Gurugram",
        "Current Status": "Disposed",
        "Next Date of Hearing": "—",
        "Complaint Dispatched": "14-Feb-2024",
        "View Notice": "View",
        "View Notice_action": {
          "text": "View",
          "url": "https://haryanarera.gov.in/assistancecontrol/viewnotice/..."
        }
      }
    ],
    "complaint_listing_details": [
      {
        "Date of Hearing": "12-Mar-2024",
        "Status": "Heard",
        "Proceedings of the day": "Arguments heard, final order passed.",
        "Bench": "Bench I",
        "Order": "View Order",
        "Order_action": {
          "text": "View Order",
          "url": "https://haryanarera.gov.in/assistancecontrol/vieworder/..."
        },
        "Order Uploaded On": "14-Mar-2024"
      }
    ],
    "complaint_final_judgement_details": [
      {
        "Date of Judgement": "12-Mar-2024",
        "Party Details": "John Doe VS Jane Doe",
        "Judgement Uploading Date": "15-Mar-2024",
        "View Judgement": "View",
        "View Judgement_action": {
          "text": "View",
          "url": "https://haryanarera.gov.in/assistancecontrol/viewjudgement/..."
        }
      }
    ],
    "documents_submitted": [
      {
        "Dak ID": "DK-10023",
        "Receiving Date": "10-Feb-2024",
        "Submitted By": "Complainant",
        "Remarks": "Rejoinder copy filed"
      }
    ]
  }
}
```

---

## CORS Configurations

Allowed origins include:
* `https://jurident.com`
* `https://www.jurident.com`
* `http://localhost:3000`

---

## Deployment (Docker / Google Cloud Run / Render)

You can containerize this application using the pre-configured `Dockerfile`.

### Build & Run Docker Locally:
```bash
docker build -t rera-haryana-cj .
docker run -p 8081:8081 --env-file .env rera-haryana-cj
```

### Google Cloud Run Deployment:
```bash
gcloud run deploy rera-haryana-cj \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 1
```

*Note: Since the service runs an internal `node-cron` scheduler, set `--min-instances 1` to prevent Google Cloud Run from scaling down to zero (which would pause the scheduler). Alternatively, scale to zero and trigger the job externally by scheduling calls to the `/api/rera/hr/cron/trigger` endpoint using Google Cloud Scheduler or cron-job.org.*

