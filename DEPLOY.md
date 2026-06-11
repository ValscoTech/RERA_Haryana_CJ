# Deploying RERA Haryana CJ to a GCP Compute Engine VM

This service is a **background cron worker**, not an API. The Express server in
`server.js` exists only to keep the Node process alive so the in-process
`node-cron` job in `adapters/haryana.js` (`"0 0 * * *"`, daily) can fire and sync
Haryana RERA cases into Firestore.

Because the work is a once-a-day batch, a small always-on VM is the simplest fit:
in-process `node-cron` works without any code changes (unlike stock Cloud Run,
which throttles CPU to zero between requests and would silently skip the cron).

- **GCP project:** `valsco-jurident` (Jurident)
- **Recommended region/zone:** `asia-south1-a` (Mumbai)
- **Recommended machine:** `e2-small` (2 GB RAM)

---

## Timezone note (important)

The cron schedule `"0 0 * * *"` has **no explicit timezone**, so it fires at the
VM's local time. GCE VMs default to **UTC**, where midnight = 05:30 IST. Set the
VM timezone to `Asia/Kolkata` so the job runs at IST midnight and logs are in IST.

---

## 1. Create the VM

```bash
gcloud compute instances create rera-hr-cj \
  --project=valsco-jurident \
  --zone=asia-south1-a \
  --machine-type=e2-small \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=20GB \
  --scopes=https://www.googleapis.com/auth/cloud-platform
```

## 2. SSH in and install Node + git

```bash
gcloud compute ssh rera-hr-cj --zone=asia-south1-a --project=valsco-jurident

# --- on the VM ---
sudo timedatectl set-timezone Asia/Kolkata        # IST midnight cron
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

## 3. Get the code onto the VM

The GitHub repo (`ValscoTech/RERA_Haryana_CJ`) is private. Either:

**a) Clone with a GitHub token / deploy key:**
```bash
git clone https://github.com/ValscoTech/RERA_Haryana_CJ.git
cd RERA_Haryana_CJ
npm ci --omit=dev
```

**b) Or copy the working tree straight from your laptop (no git auth needed):**
```bash
# from your local machine, excluding node_modules:
gcloud compute scp --recurse --zone=asia-south1-a --project=valsco-jurident \
  ./RERA_Haryana_CJ rera-hr-cj:~/   # then `npm ci --omit=dev` on the VM
```

## 4. Supply Firebase credentials

`config/firebase.js` looks for credentials in this order:
1. `FIREBASE_SERVICE_ACCOUNT` env var (full JSON string), **or**
2. `config/serviceAccountKey.json` file.

Leave `USE_EMULATOR` unset so it runs against **production** Firestore.

Upload the key file from a machine that has it:
```bash
gcloud compute scp ./config/serviceAccountKey.json \
  rera-hr-cj:~/RERA_Haryana_CJ/config/serviceAccountKey.json \
  --zone=asia-south1-a --project=valsco-jurident
```

> The key is gitignored and must never be committed. If it's lost, generate a new
> one in the Firebase console: Project Settings → Service accounts → Generate new
> private key.

## 5. Run under pm2 (auto-restart + survives reboot)

```bash
sudo npm install -g pm2
cd ~/RERA_Haryana_CJ
pm2 start server.js --name rera-hr-cj
pm2 startup systemd     # run the command it prints
pm2 save
```

Verify:
```bash
pm2 logs rera-hr-cj          # "service running on port 8081" + "Firestore mode: PRODUCTION"
curl http://localhost:8081/  # health check JSON
```

## 6. Test the sync without waiting for midnight

```bash
curl http://localhost:8081/api/rera/hr/cron/trigger
pm2 logs rera-hr-cj          # watch the sync run end-to-end
```

---

## Operations

| Task | Command |
|---|---|
| View logs | `pm2 logs rera-hr-cj` |
| Restart | `pm2 restart rera-hr-cj` |
| Status | `pm2 status` |
| Deploy update | `git pull && npm ci --omit=dev && pm2 restart rera-hr-cj` |
| Stop VM (save cost) | `gcloud compute instances stop rera-hr-cj --zone=asia-south1-a` |
| Delete VM | `gcloud compute instances delete rera-hr-cj --zone=asia-south1-a` |

## Notes

- **No firewall rule needed.** The worker only makes outbound calls (scraping +
  Firestore). Port 8081 does not need to be exposed publicly; the debug routes are
  reachable locally on the VM via `localhost`.
- The CORS allowlist in `server.js` (`jurident.com`) only matters if these routes
  are exposed externally, which they are not in this deployment.
