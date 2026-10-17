# Deploying Dronacharya to Google Cloud Platform (Without Docker)

This guide explains how to deploy the entire Dronacharya multi-agent ecosystem (Registry, Sellers, Buyer Agent, and Gateway with built frontend) to Google Cloud Platform **natively without Docker**.

---

## Architecture Overview

On GCP, the system runs as a single unified process via the built-in Gateway:
- **Gateway (Port 8080)**: Serves the compiled React/Tailwind frontend at `/`, proxying `/api` and service prefixes (`/registry`, `/scraper`, `/fx`, `/summary`, `/chaos`, `/buyer`) to their respective local ports.
- **Internal Micro-services**: Run locally on loopback (ports `4000`, `4101`, `4102`, `4103`, `4199`, `4200`) managed via `concurrently`.

---

## Quick Deploy (One Command)

Run the included GCP deployment script:

```bash
./deploy/gcp/deploy.sh
```

The script checks your `gcloud` configuration and guides you through selecting **Cloud Run**, **App Engine**, or **Compute Engine**.

---

## Method 1: Google Cloud Run (Recommended)

Google Cloud Run can build and deploy directly from your source code using **Google Cloud Buildpacks** without requiring local Docker or a Dockerfile.

### 1. Prerequisites
Ensure the Google Cloud CLI (`gcloud`) is installed and authenticated:
```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

### 2. Deploy from Source
```bash
# 1. Pre-build the frontend assets
npm run build:frontend

# 2. Deploy directly to Cloud Run
gcloud run deploy dronacharya \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --memory 1Gi \
  --cpu 1 \
  --port 8080 \
  --min-instances 1 \
  --max-instances 3 \
  --set-env-vars "NODE_ENV=production,REGISTRY_ALLOW_LOOPBACK=true,BUYER_ALLOW_LOOPBACK=true"
```

Cloud Run will output your live HTTPS URL:
```
Service URL: https://dronacharya-xxxxxx-uc.a.run.app
```

### 3. Configure Service URLs
Configure all seller endpoints to use your new public Cloud Run HTTPS URL:
```bash
npm run deploy:configure -- https://dronacharya-xxxxxx-uc.a.run.app
```

Verify your endpoints:
```bash
npm run deploy:check
```

---

## Method 2: Google App Engine (Standard Node.js 22)

Google App Engine provides managed Node.js 22 hosting using `app.yaml` with automatic HTTPS and zero Docker overhead.

### 1. Deploy using `app.yaml`
```bash
# 1. Pre-build the frontend assets
npm run build:frontend

# 2. Deploy to App Engine
gcloud app deploy app.yaml
```

### 2. View Deployment
```bash
gcloud app browse
```

---

## Method 3: Google Compute Engine (Dedicated VM)

If you need persistent SQLite state, continuous 24/7 background execution without cold starts, deploy to a Compute Engine VM.

### 1. Create VM with Automated Startup Script
```bash
gcloud compute instances create dronacharya-vm \
  --zone us-central1-a \
  --machine-type e2-medium \
  --image-family debian-12 \
  --image-project debian-cloud \
  --tags http-server,https-server \
  --metadata-from-file startup-script=deploy/gcp/startup-script.sh

# Open firewall port 8080
gcloud compute firewall-rules create allow-dronacharya-8080 \
  --allow tcp:8080 \
  --target-tags http-server \
  --description "Allow inbound traffic on port 8080 for Dronacharya"
```

### 2. Sync Code to VM
```bash
gcloud compute scp --recurse . dronacharya-vm:/opt/dronacharya --zone us-central1-a
```

### 3. Start Systemd Service on VM
```bash
gcloud compute ssh dronacharya-vm --zone us-central1-a --command \
  "cd /opt/dronacharya && npm install && npm run build:frontend && systemctl restart dronacharya"
```

### 4. Verify Service Status
```bash
gcloud compute ssh dronacharya-vm --zone us-central1-a --command "systemctl status dronacharya"
```

---

## Managing Secrets in GCP

Never commit private keys to version control. On GCP, you can pass secrets directly using **Google Secret Manager**:

1. Store keys in Secret Manager:
   ```bash
   gcloud secrets create BUYER_PRIVATE_KEY --data-file=- <<< "0x..."
   gcloud secrets create GEMINI_API_KEY --data-file=- <<< "AIza..."
   ```

2. Bind secrets to Cloud Run:
   ```bash
   gcloud run services update dronacharya \
     --region us-central1 \
     --set-secrets BUYER_PRIVATE_KEY=BUYER_PRIVATE_KEY:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest
   ```

---

## Configuration Files Added

| File | Purpose |
|------|---------|
| [app.yaml](file:///home/atharvubale/Documents/Dronacharya/app.yaml) | App Engine Standard configuration for Node.js 22 |
| [.gcloudignore](file:///home/atharvubale/Documents/Dronacharya/.gcloudignore) | Prevents uploading `node_modules`, `.data`, and `.env` secrets |
| [Procfile](file:///home/atharvubale/Documents/Dronacharya/Procfile) | Defines web entrypoint for Cloud Buildpacks / Cloud Run |
| [cloudbuild.yaml](file:///home/atharvubale/Documents/Dronacharya/cloudbuild.yaml) | GCP Cloud Build manifest for serverless CI/CD |
| [deploy/gcp/startup-script.sh](file:///home/atharvubale/Documents/Dronacharya/deploy/gcp/startup-script.sh) | Automated setup script for Compute Engine VMs |
| [deploy/gcp/dronacharya.service](file:///home/atharvubale/Documents/Dronacharya/deploy/gcp/dronacharya.service) | Production systemd unit file for 24/7 background execution |
| [deploy/gcp/deploy.sh](file:///home/atharvubale/Documents/Dronacharya/deploy/gcp/deploy.sh) | Interactive CLI deployment tool |
