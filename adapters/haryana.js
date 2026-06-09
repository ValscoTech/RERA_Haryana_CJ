// adapters/haryana.js
// RERA Haryana Cron Job Adapter
// Headless detail-page scraper + Firestore sync + eventReminders
// No captcha needed — detail pages are publicly accessible via GET.

require("dotenv").config();
const axios = require("axios");
const cheerio = require("cheerio");
const cron = require("node-cron");
const db = require("../config/firebase");

/* ============================================================
   CONSTANTS
   ============================================================ */

const TARGET_BASE = "https://haryanarera.gov.in";
const LANDING_PAGE = `${TARGET_BASE}/assistancecontrol/search_case_open`;
const DETAIL_URL = (id) =>
  `${TARGET_BASE}/assistancecontrol/searchcasedetailopen/${id}`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  Origin: TARGET_BASE,
  Referer: LANDING_PAGE,
  "Upgrade-Insecure-Requests": "1",
};

/* ============================================================
   UTILITY: Cookie Merger
   ============================================================ */

function mergeCookies(oldCookie, setHeader) {
  if (!setHeader) return oldCookie;
  const newCookies = setHeader.map((c) => c.split(";")[0]);
  const cookieMap = new Map();
  if (oldCookie) {
    oldCookie.split("; ").forEach((c) => {
      const [k, v] = c.split("=");
      if (k) cookieMap.set(k, v);
    });
  }
  newCookies.forEach((c) => {
    const [k, v] = c.split("=");
    if (k) cookieMap.set(k, v);
  });
  return Array.from(cookieMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/* ============================================================
   UTILITY: Date Helpers
   ============================================================ */

/**
 * Normalize Haryana RERA hearing date.
 * Haryana uses "17-Mar-2026" format on the search list page.
 * Detail pages may differ — update pattern after running test_scrape.js.
 * Normalized output: "dd/mm/yyyy"
 */
function normalizeHaryanaHearingDate(dateStr) {
  if (!dateStr || !dateStr.trim()) return "N/A";
  const trimmed = dateStr.trim();

  // Pattern 1: "17-Mar-2026" (from search list)
  const MONTHS = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04",
    May: "05", Jun: "06", Jul: "07", Aug: "08",
    Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  const namedMonthMatch = trimmed.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  if (namedMonthMatch) {
    const [, dd, mon, yyyy] = namedMonthMatch;
    const mm = MONTHS[mon];
    if (mm) return `${dd}/${mm}/${yyyy}`;
  }

  // Pattern 2: Already "dd/mm/yyyy"
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed)) return trimmed;

  // Pattern 3: "dd-mm-yyyy"
  const dashedNumericMatch = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dashedNumericMatch) {
    const [, dd, mm, yyyy] = dashedNumericMatch;
    return `${dd}/${mm}/${yyyy}`;
  }

  return "N/A";
}

/**
 * Convert "dd/mm/yyyy" string to a Date object.
 */
function toDate(dateStr) {
  if (!dateStr || dateStr === "N/A") return null;
  const parts = dateStr.split("/");
  if (parts.length !== 3) return null;
  const [dd, mm, yyyy] = parts;
  return new Date(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd));
}

/* ============================================================
   SCRAPING: Fetch Detail Page HTML
   ============================================================ */

/**
 * Establishes a lightweight session by hitting the landing page
 * (to get a valid session cookie), then fetches the case detail page.
 * No captcha is required for detail pages.
 */
async function fetchDetailPage(internalId) {
  // Step 1: Get session cookie from landing page
  const pageResp = await axios.get(LANDING_PAGE, {
    headers: HEADERS,
    timeout: 10000,
  });
  const cookie = mergeCookies("", pageResp.headers["set-cookie"]);

  // Step 2: Fetch the case detail page using the session cookie
  const resp = await axios.get(DETAIL_URL(internalId), {
    headers: { ...HEADERS, Cookie: cookie },
    timeout: 15000,
    validateStatus: () => true,
  });

  if (resp.status !== 200) {
    throw new Error(
      `Detail page returned status ${resp.status} for internalId=${internalId}`
    );
  }

  return resp.data; // raw HTML
}

/* ============================================================
   PARSING: Section Table Parser
   Mirrors parseDynamicTable from RERA_Haryana/adapters/krishna_hr.js
   ============================================================ */

function parseDynamicTable($, tableElement) {
  const result = [];
  const table = $(tableElement);

  // Extract headers dynamically from <th> tags
  const headers = table
    .find("thead th")
    .map((i, th) => {
      return $(th).text().trim().replace(/\s+/g, " ") || `column_${i}`;
    })
    .get();

  // Map rows to headers
  table.find("tbody tr").each((_, tr) => {
    const rowData = {};
    const cols = $(tr).find("td, th");

    headers.forEach((header, i) => {
      const cell = $(cols[i]);
      let value = cell.text().trim().replace(/\s+/g, " ");

      // Preserve PDF/link actions
      const link = cell.find("a").attr("href");
      if (link) {
        const fullUrl = link.startsWith("http")
          ? link
          : `${TARGET_BASE}${link.startsWith("/") ? "" : "/"}${link}`;
        rowData[`${header}_action`] = {
          text: value || "View",
          url: fullUrl,
        };
      }

      rowData[header] = value || "—";
    });

    // Skip invisible spacer rows
    if (Object.values(rowData).some((val) => val !== "—")) {
      result.push(rowData);
    }
  });

  return result;
}

/* ============================================================
   PARSING: Full Detail Page Parser
   ============================================================ */

function parseCaseDetailPage(html) {
  const $ = cheerio.load(html);
  const sections = {};

  // Each section is identified by a .cus-top-heading-2 heading
  $(".cus-top-heading-2").each((i, heading) => {
    const sectionName = $(heading)
      .text()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "_");

    const nextTable = $(heading).nextAll("table").first();
    if (nextTable.length) {
      sections[sectionName] = parseDynamicTable($, nextTable);
    }
  });

  // Extract the RERA complaint number from page title area
  const complaintNo =
    $("#empprofile").first().text().match(/RERA-[A-Z0-9-]+/i)?.[0] ||
    "Unknown";

  return { complaintNo, sections };
}

/* ============================================================
   DATA EXTRACTORS
   Confirmed section slug names from live haryanarera.gov.in (verified 2026-06-08):

   Section 0: "complaint_detail_rera_xxx_xxx_xxxx"  (dynamic — contains complaintNo)
     Columns: Party Dtls, Self / Adv Name, District, Current Status,
              Next Date of Hearing, Complaint Dispatched, View Notice

   Section 1: "complaint_listing_details"
     Columns: Date of Hearing, Status, Proceedings of the day, Bench,
              Order, Order Uploaded On

   Section 2: "complaint_final_judgement_details"
     Columns: Date of Judgement, Party Details, Judgement Uploading Date, View Judgement

   Section 3: "documents_submitted"
     Columns: Dak ID, Receiving Date, Submitted By, Remarks
   ============================================================ */

/**
 * Get the section whose key starts with "complaint_detail_"
 * (the key is dynamic because it includes the complaint number).
 */
function getComplaintDetailSection(sections) {
  const key = Object.keys(sections).find((k) => k.startsWith("complaint_detail_"));
  return key ? sections[key] : null;
}

/**
 * Next Date of Hearing lives in the complaint detail row
 * under the column "Next Date of Hearing".
 */
function getNextHearingDate(sections) {
  const rows = getComplaintDetailSection(sections);
  if (!rows || !rows.length) return null;
  // The first (and usually only) data row contains the next hearing date
  for (const row of rows) {
    const val = row["Next Date of Hearing"];
    if (val && val !== "—") return val;
  }
  return null;
}

/**
 * Last hearing date = the most recent row in complaint_listing_details.
 */
function getLastHearingDate(sections) {
  const rows = sections["complaint_listing_details"];
  if (!rows || !rows.length) return null;
  // Rows are in chronological order — last row = most recent hearing
  for (let i = rows.length - 1; i >= 0; i--) {
    const val = rows[i]["Date of Hearing"];
    if (val && val !== "—") return val;
  }
  return null;
}

/**
 * Case status lives in the complaint detail row under "Current Status".
 */
function getCaseStatus(sections) {
  const rows = getComplaintDetailSection(sections);
  if (!rows || !rows.length) return null;
  for (const row of rows) {
    const val = row["Current Status"];
    if (val && val !== "—") return val.toLowerCase();
  }
  return null;
}

/**
 * Get order/judgement rows from complaint_listing_details
 * (rows that have an Order PDF link).
 */
function getOrderRows(sections) {
  const rows = sections["complaint_listing_details"] || [];
  return rows.filter((r) => r["Order_action"] || (r["Order"] && r["Order"] !== "—"));
}

/* ============================================================
   FIRESTORE: Query Haryana Cases
   ============================================================ */

/**
 * Fetch all pending Haryana RERA cases from Firestore.
 * ⚠️  Confirm the exact courtName value used when cases are saved
 *     from the Flutter app. Common values: "RERA Haryana", "Haryana RERA"
 */
async function getCasesForCron() {
  const snap = await db
    .collection("pending")
    .where("courtName", "==", "RERA Haryana")
    .get();
  return snap.docs;
}

/* ============================================================
   NOTIFICATIONS: Create eventReminders
   ============================================================ */

/**
 * Write two eventReminder documents for a case hearing:
 * - reminder1: hearing day at 08:00 AM IST (02:30 AM UTC)
 * - reminder2: hearing day at 06:00 PM IST (12:30 PM UTC)
 *
 * Explicit UTC hour offsets are used to ensure reminders trigger at the correct 
 * local times regardless of the server's timezone environment.
 *
 * Owner is looked up in `lawyers` first, then `client` (singular).
 * ⚠️  Verify collection name against your Firestore before deploying.
 */
async function createNotification(ownerId, caseId, nextHearingDate, caseData) {
  if (!ownerId) {
    console.log(`[HR-CJ] No ownerId for case ${caseId}, skipping notification`);
    return;
  }

  try {
    const lawyerDoc = await db.collection("lawyers").doc(ownerId).get();
    const clientDoc = await db.collection("client").doc(ownerId).get(); // singular — matches Delhi adapter

    if (!lawyerDoc.exists && !clientDoc.exists) {
      console.log(`[HR-CJ] Owner ${ownerId} not found for case ${caseId}`);
      return;
    }

    const parts = nextHearingDate.split("/");
    if (parts.length !== 3) {
      console.log(`[HR-CJ] Could not parse date: ${nextHearingDate}`);
      return;
    }
    const [day, month, year] = parts.map(Number);

    // 8:00 AM IST = 2:30 AM UTC
    const reminder1 = new Date(Date.UTC(year, month - 1, day, 2, 30, 0, 0));

    // 6:00 PM IST = 12:30 PM UTC
    const reminder2 = new Date(Date.UTC(year, month - 1, day, 12, 30, 0, 0));

    const baseEvent = {
      caseId,
      caseNo: `${caseData.caseNo || caseData.complaintNo || ""}`,
      createdAt: new Date(),
      recipientId: ownerId,
      scheduledBy: ownerId,
      status: "scheduled",
    };

    const event1 = await db.collection("eventReminders").add({
      ...baseEvent,
      eventTitle: `${caseData.petitionerName || ""} VS ${caseData.respondentName || ""}`,
      reminderTime: reminder1,
    });

    const event2 = await db.collection("eventReminders").add({
      ...baseEvent,
      eventTitle: `Update Next Hearing: ${caseData.petitionerName || ""} VS ${caseData.respondentName || ""}`,
      reminderTime: reminder2,
    });

    console.log(
      `[HR-CJ] eventReminders created: ${event1.id}, ${event2.id} for case ${caseId}`
    );
  } catch (err) {
    console.error(`[HR-CJ] createNotification failed for case ${caseId}:`, err.message);
  }
}

/* ============================================================
   CRON: Main Sync Job
   ============================================================ */

async function caseSyncCronJob() {
  console.log(`[HR-CJ] ===== Starting Haryana RERA sync at ${new Date().toISOString()} =====`);

  let docs;
  try {
    docs = await getCasesForCron();
    console.log(`[HR-CJ] Found ${docs.length} pending Haryana RERA case(s) in Firestore`);
  } catch (err) {
    console.error("[HR-CJ] Failed to query Firestore:", err.message);
    return;
  }

  for (const doc of docs) {
    const caseId = doc.id;
    const data = doc.data();

    // Resolve internalId — stored when the case was first fetched via RERA_Haryana API
    const internalId =
      data.rawReraData?.internalId ||
      data.internalId ||
      data.rawReraData?.action?.internalId;

    if (!internalId) {
      console.warn(`[HR-CJ] Case ${caseId} has no internalId, skipping`);
      continue;
    }

    try {
      // ── 1. Scrape fresh data ──────────────────────────────────
      console.log(`[HR-CJ] Scraping case ${caseId} (internalId=${internalId})`);
      const html = await fetchDetailPage(internalId);
      const parsed = parseCaseDetailPage(html);

      // ── 2. Extract hearing dates ──────────────────────────────
      const rawNextHearing = getNextHearingDate(parsed.sections);
      const rawLastHearing = getLastHearingDate(parsed.sections);
      const caseStatus = getCaseStatus(parsed.sections);

      const newNextHearing = normalizeHaryanaHearingDate(rawNextHearing);
      const newLastHearing = normalizeHaryanaHearingDate(rawLastHearing);

      console.log(`[HR-CJ] Case ${caseId}: nextHearing=${newNextHearing}, lastHearing=${newLastHearing}, status=${caseStatus}`);

      // ── 3. Compare with existing Firestore dates ──────────────
      const existingNext = data.nextHearingDate || "N/A";

      let shouldUpdateNext = true;
      if (existingNext !== "N/A" && newNextHearing !== "N/A") {
        shouldUpdateNext = toDate(newNextHearing) > toDate(existingNext);
      }
      if (newNextHearing === "N/A") shouldUpdateNext = false;

      // ── 4. Build update payload ───────────────────────────────
      const updatedFields = {
        updatedAt: new Date(),
        rawReraData: {
          ...data.rawReraData,
          sections: parsed.sections,
          complaintNo: parsed.complaintNo,
        },
      };

      if (shouldUpdateNext) {
        updatedFields.nextHearingDate = newNextHearing;
      }

      if (newLastHearing !== "N/A") {
        updatedFields.lastHearingDate = newLastHearing;
      }

      // ── 5. Write to Firestore ─────────────────────────────────
      await doc.ref.set(updatedFields, { merge: true });
      console.log(`[HR-CJ] Case ${caseId} updated in Firestore`);

      // ── 6. Create notification if next hearing changed ────────
      if (shouldUpdateNext) {
        createNotification(data.owner, caseId, newNextHearing, data).catch(
          (err) =>
            console.error(
              `[HR-CJ] Notification failed for case ${caseId}:`,
              err.message
            )
        );
      }

      // ── 7. Handle disposed cases ──────────────────────────────
      if (caseStatus === "disposed") {
        console.log(`[HR-CJ] Case ${caseId} is DISPOSED — moving to 'disposed' collection`);
        updatedFields["rawReraData.status"] = "Disposed";

        await db.collection("disposed").doc(caseId).set({ ...data, ...updatedFields });
        console.log(`[HR-CJ] Case ${caseId} copied to 'disposed'`);

        await doc.ref.delete();
        console.log(`[HR-CJ] Case ${caseId} removed from 'pending'`);
      }
    } catch (err) {
      console.error(`[HR-CJ] Failed to sync case ${caseId}:`, err.message);
      // Continue with next case — don't abort entire job
    }
  }

  console.log(`[HR-CJ] ===== Sync complete at ${new Date().toISOString()} =====`);
}

/* ============================================================
   CRON SCHEDULE: Daily at midnight
   '0 0 * * *' = 12:00 AM every day
   ============================================================ */

cron.schedule("0 0 * * *", () => {
  console.log("[HR-CJ] Daily cron triggered at", new Date().toISOString());
  caseSyncCronJob().catch((err) =>
    console.error("[HR-CJ] Cron job failed:", err)
  );
});

module.exports = { caseSyncCronJob, fetchDetailPage, parseCaseDetailPage };
