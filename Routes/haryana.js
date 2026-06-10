// Routes/haryana.js
// Debug/manual trigger route for the Haryana RERA cron job.
// In production this service has no API routes — it is a pure background worker.
// These routes exist only for manual testing and verification.

const express = require("express");
const router = express.Router();
const { caseSyncCronJob, fetchDetailPage, parseCaseDetailPage } = require("../adapters/haryana");

/**
 * GET /api/rera/hr/cron/trigger
 * Manually trigger the full cron sync job (for testing without waiting for midnight).
 */
router.get("/trigger", async (req, res) => {
  console.log("[HR-CJ] Manual trigger called at", new Date().toISOString());
  // Fire and forget — do not await, so the HTTP response is immediate
  caseSyncCronJob().catch((err) =>
    console.error("[HR-CJ] Manual trigger error:", err)
  );
  res.json({
    success: true,
    message: "Haryana RERA cron job triggered manually. Check server logs for progress.",
    triggeredAt: new Date().toISOString(),
  });
});

/**
 * GET /api/rera/hr/cron/scrape/:internalId
 * Scrape a single case detail page by its Haryana RERA internalId.
 * Useful for verifying section key names after running test_scrape.js.
 * Example: GET /api/rera/hr/cron/scrape/55971
 */
router.get("/scrape/:internalId", async (req, res) => {
  const { internalId } = req.params;
  try {
    const html = await fetchDetailPage(internalId);
    const parsed = parseCaseDetailPage(html);
    res.json({
      success: true,
      internalId,
      complaintNo: parsed.complaintNo,
      sectionKeys: Object.keys(parsed.sections),
      sections: parsed.sections,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/rera/hr/cron/orders/:caseId
 * Get all synced orders for a specific case from the pending or disposed collection.
 */
router.get("/orders/:caseId", async (req, res) => {
  const { caseId } = req.params;
  const db = require("../config/firebase");
  try {
    // Check pending first
    let snap = await db.collection("pending").doc(caseId).collection("orders").get();
    
    // If empty, check disposed
    if (snap.empty) {
      snap = await db.collection("disposed").doc(caseId).collection("orders").get();
    }

    const orders = snap.docs.map((doc) => doc.data());
    res.json({
      success: true,
      caseId,
      count: orders.length,
      orders,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
