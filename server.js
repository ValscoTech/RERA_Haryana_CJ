// server.js
// RERA Haryana CJ — Express Server
// This server's only purpose is to keep the Node.js process alive
// so that the node-cron scheduler (inside adapters/haryana.js) can run.
// All cron logic is self-contained in the adapter module.

require("dotenv").config();
const express = require("express");

const app = express();

/* ------------ BODY PARSING ------------ */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ------------ CORS ------------ */
const allowedOrigins = [
  "https://jurident.com",
  "https://www.jurident.com",
  "http://localhost:3000",
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ------------ REQUEST LOGGER ------------ */
app.use((req, res, next) => {
  console.log(`[HR-CJ] ${req.method} ${req.originalUrl}`);
  next();
});

/* ------------ ACTIVATE CRON (import triggers cron.schedule) ------------ */
require("./adapters/haryana");

/* ------------ ROUTES ------------ */
// Debug/manual trigger routes (not needed in production)
app.use("/api/rera/hr/cron", require("./Routes/haryana"));

/* ------------ HEALTH CHECK ------------ */
app.get("/", (req, res) => {
  res.json({
    service: "RERA Haryana CJ",
    status: "running",
    description: "Haryana RERA daily case sync cron job service",
    cronSchedule: "0 0 * * * (daily at midnight)",
  });
});

/* ------------ GLOBAL ERROR HANDLER ------------ */
app.use((err, req, res, next) => {
  console.error("[HR-CJ] GLOBAL ERROR:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

/* ------------ START SERVER ------------ */
const PORT = process.env.PORT || 8081;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[HR-CJ] RERA Haryana CJ service running on port ${PORT}`);
  console.log(`[HR-CJ] Firestore mode: ${process.env.USE_EMULATOR === "true" ? "EMULATOR" : "PRODUCTION"}`);
  console.log(`[HR-CJ] Cron scheduled: daily at midnight (0 0 * * *)`);
});
