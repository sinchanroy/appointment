# OCI Appointment Monitor - Setup Guide

**Monitors OCI appointment availability and sends Telegram notifications. Runs unattended — pick GitHub Actions (free, no server) or Kubernetes (if you already run a cluster).**

---

## Step 1: Get Telegram Bot Token & Chat ID (required for both options)

1. Open Telegram, message **@BotFather**, send `/newbot` and follow the prompts
2. Copy the bot token it gives you (looks like `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`)
3. Start a chat with your new bot (send it any message, e.g. `/start`)
4. Get your chat ID — message **@userinfobot** for your personal ID, or call:
   `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates` after messaging your bot, and read `message.chat.id` from the response
5. (Optional) Add the bot to a group instead of DMing it directly — group chat IDs are negative numbers

---

## Option A: GitHub Actions (Recommended)

Free (unlimited minutes on a public repo), no server to run or pay for — GitHub's own runners execute the check on a schedule, even while your laptop is off. State is persisted by committing `state/appointment-state.json` back to the repo between runs.

### A1. Push this project to GitHub
Create a repo (public is fine — the script has no secrets hardcoded in it) and push this project to it. The workflow file is already included at `.github/workflows/check-appointments.yml`.

### A2. Add repository secrets
In the repo, go to **Settings → Secrets and variables → Actions → New repository secret** and add:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `APPLICATION_REFERENCE_NO`
- `JURISDICTION` — e.g. `North Rhine-Westphalia` (must match the jurisdiction dropdown on the site exactly)
- `SERVICE_TYPE` — e.g. `Fresh OCI` (must match the "Select Service" dropdown exactly)

These are stored as **secrets**, not repository variables, even though they're not credentials — on a public repo, secrets are the only way to keep a value out of the public Actions run logs. Jurisdiction and service type reveal personal circumstances (roughly where you live and your immigration status), so they're treated the same as the Telegram credentials.

### A3. Allow the workflow to push state commits
Go to **Settings → Actions → General → Workflow permissions** and select **"Read and write permissions"** (needed so the workflow can commit the updated state file back to the repo).

### A4. That's it
The workflow runs every 15 minutes automatically (`.github/workflows/check-appointments.yml`). To test it immediately instead of waiting: go to the **Actions** tab → **Check OCI Appointments** → **Run workflow**.

To change the schedule, edit the `cron:` line at the top of `.github/workflows/check-appointments.yml`. To change service category, or tune how many months/results are scanned, add the optional vars from `.env.example` (e.g. `SERVICE_CATEGORY`, `MAX_MONTHS_TO_CHECK`) to the same `env:` block — these aren't personal, so they're fine as plain values directly in the workflow file rather than secrets.

**Notification mode** is already wired up as a repo *variable* (not a secret, since it's not personal) — no code or workflow edits needed. By default it only notifies when the earliest slot found is new/earlier than the last one notified. To get notified on every single run that finds any slot (noisier, but sometimes useful), go to **Settings → Secrets and variables → Actions → Variables tab → New repository variable** and add `NOTIFICATION_MODE` = `always`. Set it back to `when_changed` (or delete the variable) to return to the quiet default.

### Troubleshooting GitHub Actions
- **Workflow doesn't appear / never runs on schedule**: scheduled workflows only run on the repo's default branch, and GitHub disables them automatically after 60 days of repo inactivity — push a commit or trigger manually to reactivate.
- **"Permission denied" on the git push step**: repeat step A3 — org-level settings can also restrict this separately under the organization's Actions settings.
- **Puppeteer/Chrome fails to launch**: rare on `ubuntu-latest`, but if it happens add a step `run: npx puppeteer browsers install chrome` before the "Run appointment check" step.

---

## Option B: Kubernetes

Use this instead if you already run a Kubernetes cluster you control.

### B1. Build Docker Image

```bash
# Navigate to your project directory with the files:
# - app.js
# - package.json
# - Dockerfile

# Build the image
docker build -t appointment-monitor:latest .

# If using a registry (Docker Hub, ECR, etc.):
# docker tag appointment-monitor:latest your-registry/appointment-monitor:latest
# docker push your-registry/appointment-monitor:latest
```

### B2: Update Kubernetes Manifest

Edit `k8s-cronjob.yaml` and fill in both Secrets — `telegram-credentials`:

```yaml
stringData:
  bot-token: "YOUR_TELEGRAM_BOT_TOKEN"  # ← PASTE YOUR BOT TOKEN HERE
  chat-id: "YOUR_TELEGRAM_CHAT_ID"      # ← PASTE YOUR CHAT ID HERE
```

and `appointment-config` (kept as a Secret, not a ConfigMap, since jurisdiction/service type reveal personal circumstances):

```yaml
stringData:
  reference-no: "YOUR_APPLICATION_REFERENCE_NO"
  jurisdiction: "YOUR_JURISDICTION"     # e.g. North Rhine-Westphalia
  service-type: "YOUR_SERVICE_TYPE"     # e.g. Fresh OCI
```

### B3: Deploy to Kubernetes

```bash
# Create the namespace and deploy
kubectl apply -f k8s-cronjob.yaml

# Verify deployment
kubectl get cronjobs -n appointment-monitor
kubectl get pvc -n appointment-monitor
kubectl get secrets -n appointment-monitor

# View logs from the last run
kubectl logs -n appointment-monitor -l app=oci-appointment-monitor --tail=50
```

---

## ✅ Verify It Works

```bash
# List all cron jobs
kubectl get cronjobs -n appointment-monitor

# Check job history
kubectl get jobs -n appointment-monitor

# View latest logs
kubectl logs -n appointment-monitor -l app=oci-appointment-monitor --tail=100

# Test manually (run once)
kubectl create job --from=cronjob/oci-appointment-monitor test-run -n appointment-monitor
kubectl wait --for=condition=complete job/test-run -n appointment-monitor --timeout=300s
kubectl logs -n appointment-monitor job/test-run
```

---

## 📊 Schedule Options

### Every 15 minutes (all day)
```yaml
schedule: "*/15 * * * *"
```

### Hourly (all day)
```yaml
schedule: "0 * * * *"
```

### Smart: Hourly + Every 15 mins during 7-10am Berlin time
```yaml
# Use the "oci-appointment-monitor-smart" CronJob in the manifest
schedule: "0 * * * *"  # Runs every hour
# Plus add another CronJob for morning peak
```

---

## 🔧 Configuration

Edit these in `k8s-cronjob.yaml` as needed:

| Setting | Location | Default | Notes |
|---------|----------|---------|-------|
| **Check frequency** | `spec.schedule` | Every 15 mins | Use cron syntax: `*/15 * * * *` |
| **Telegram credentials** | `telegram-credentials` Secret | - | REQUIRED: Paste your bot token & chat ID |
| **Reference no. / jurisdiction / service** | `appointment-config` Secret | - | REQUIRED: `reference-no`, `jurisdiction`, `service-type` |
| **Notification mode** | `NOTIFICATION_MODE` env var on the container | `when_changed` | Set to `always` to notify on every run that finds a slot, not just new/earlier ones |
| **Storage size** | `spec.resources.requests.storage` | 1Gi | Increase if needed |
| **Memory limit** | `limits.memory` | 512Mi | Increase for slower machines |
| **CPU limit** | `limits.cpu` | 500m | Increase for faster checks |
| **Keep logs** | `successfulJobsHistoryLimit` | 3 | Number of job records to keep |

---

## 📍 State Persistence

- Appointment state is stored in `/data/appointment-state.json`
- Mounted to a PersistentVolumeClaim
- Tracks the earliest available date found
- Only sends a Telegram notification when a new/earlier date is discovered

---

## 🐛 Troubleshooting

### Jobs not running
```bash
kubectl describe cronjob oci-appointment-monitor -n appointment-monitor
kubectl get jobs -n appointment-monitor
```

### Check pod logs
```bash
kubectl logs -n appointment-monitor -l app=oci-appointment-monitor --all-containers=true
```

### Telegram notifications not working
```bash
# Test bot manually
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/sendMessage" \
  -H 'Content-type: application/json' \
  -d '{"chat_id": "<YOUR_CHAT_ID>", "text": "Test message"}'
```

### Reset state (start fresh)
```bash
# Delete the PVC to reset state
kubectl delete pvc appointment-state-pvc -n appointment-monitor
kubectl apply -f k8s-cronjob.yaml
```

---

## 📈 Monitoring

### View all resources
```bash
kubectl get all -n appointment-monitor
```

### Watch jobs in real-time
```bash
kubectl get jobs -n appointment-monitor -w
```

### Stream latest logs
```bash
kubectl logs -n appointment-monitor -l app=oci-appointment-monitor -f --tail=50
```

---

## 🎯 Features

✅ **100% reliable** - Runs in your Kubernetes cluster  
✅ **No external dependencies** - Except a Telegram bot  
✅ **Persistent state** - Tracks earliest date found  
✅ **Smart notifications** - Only alerts on new/earlier dates  
✅ **Browser automation** - Uses Puppeteer to see actual calendar  
✅ **Error handling** - Sends error notifications to Telegram  
✅ **Resource efficient** - Low CPU/memory footprint  
✅ **Secure** - Non-root container, read-only filesystem  

---

## 📝 Notes

- Script runs every 15 minutes by default
- State is persisted across pod restarts
- Chromium runs in headless mode (no GPU needed)
- Failed jobs automatically retry once (configurable)
- Old job records cleaned up automatically

---

## 🆘 Need Help?

Check logs:
```bash
kubectl logs -n appointment-monitor -l app=oci-appointment-monitor --tail=200
```

Check required env vars are set:
```bash
echo $TELEGRAM_BOT_TOKEN $TELEGRAM_CHAT_ID $APPLICATION_REFERENCE_NO $JURISDICTION $SERVICE_TYPE
```

Test the script locally (if you have Node.js) — easiest via a local `.env` file (see `.env.example`), then:
```bash
npm start
```

---

**Done!** Your OCI appointment monitor is now running in Kubernetes with 100% reliability. 🎉
