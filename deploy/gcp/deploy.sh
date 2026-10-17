#!/usr/bin/env bash
# Deploy Dronacharya to Google Cloud Platform without Docker
set -euo pipefail

cd "$(dirname "$0")/../.."

echo "=========================================================="
echo "   Dronacharya GCP Deployment (Native / No Docker)"
echo "=========================================================="
echo ""

# 1. Verify gcloud CLI
if ! command -v gcloud >/dev/null 2>&1; then
  echo "Error: Google Cloud SDK (gcloud) is not installed."
  echo "Install it from: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
  echo "No active GCP project found in gcloud config."
  read -r -p "Enter your GCP Project ID: " PROJECT_ID
  gcloud config set project "$PROJECT_ID"
fi

REGION=$(gcloud config get-value compute/region 2>/dev/null || echo "us-central1")
if [ -z "$REGION" ] || [ "$REGION" = "(unset)" ]; then
  REGION="us-central1"
fi

echo "Active Project: $PROJECT_ID"
echo "Target Region:  $REGION"
echo ""

# 2. Select Deployment Target
echo "Choose GCP Deployment Target (All run WITHOUT local Docker):"
echo "  1) Cloud Run (Recommended — Serverless, automatic HTTPS, zero Docker)"
echo "  2) App Engine (Standard Node.js 22 environment)"
echo "  3) Compute Engine (Persistent VM running systemd daemon)"
read -r -p "Select option [1-3, default: 1]: " TARGET
TARGET=${TARGET:-1}

case "$TARGET" in
  1)
    echo ""
    echo "==> Deploying to Google Cloud Run via Source Buildpacks..."
    SERVICE_NAME="dronacharya"

    # Pre-build frontend locally to guarantee fresh assets are packaged
    echo "==> Pre-building frontend assets..."
    npm run build:frontend

    # Build env vars flag if .env exists
    ENV_VARS_FLAG=""
    if [ -f ".env" ]; then
      echo "Notice: .env file found. To inject runtime secrets securely,"
      echo "you can pass them via Secret Manager or --set-env-vars."
    fi

    gcloud run deploy "$SERVICE_NAME" \
      --source . \
      --region "$REGION" \
      --platform managed \
      --allow-unauthenticated \
      --memory 1Gi \
      --cpu 1 \
      --port 8080 \
      --min-instances 1 \
      --max-instances 3 \
      --set-env-vars "NODE_ENV=production,REGISTRY_ALLOW_LOOPBACK=true,BUYER_ALLOW_LOOPBACK=true"

    URL=$(gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format='value(status.url)' 2>/dev/null || true)
    echo ""
    echo "=========================================================="
    echo "  Successfully Deployed to Cloud Run!"
    echo "  Public URL: $URL"
    echo "=========================================================="
    echo ""
    echo "Next steps:"
    echo "1. Run: npm run deploy:configure -- $URL"
    echo "2. Check endpoints: npm run deploy:check"
    ;;

  2)
    echo ""
    echo "==> Deploying to Google App Engine..."
    echo "==> Pre-building frontend assets..."
    npm run build:frontend

    gcloud app deploy app.yaml --quiet

    echo ""
    echo "=========================================================="
    echo "  Successfully Deployed to App Engine!"
    echo "  Run 'gcloud app browse' to view the deployment."
    echo "=========================================================="
    ;;

  3)
    echo ""
    echo "==> Provisioning Compute Engine VM..."
    VM_NAME="dronacharya-vm"
    ZONE="${REGION}-a"

    gcloud compute instances create "$VM_NAME" \
      --zone "$ZONE" \
      --machine-type "e2-medium" \
      --image-family "debian-12" \
      --image-project "debian-cloud" \
      --tags "http-server,https-server" \
      --metadata-from-file startup-script="deploy/gcp/startup-script.sh"

    # Firewall rule for port 8080 if not already present
    gcloud compute firewall-rules create allow-dronacharya-8080 \
      --allow tcp:8080 \
      --target-tags http-server \
      --description "Allow inbound traffic on port 8080 for Dronacharya Gateway" 2>/dev/null || true

    VM_IP=$(gcloud compute instances describe "$VM_NAME" --zone "$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')

    echo ""
    echo "=========================================================="
    echo "  VM Created: $VM_NAME ($VM_IP)"
    echo "  Access Gateway at: http://$VM_IP:8080"
    echo "=========================================================="
    echo "To sync your code to the VM and start:"
    echo "  gcloud compute scp --recurse . $VM_NAME:/opt/dronacharya --zone $ZONE"
    echo "  gcloud compute ssh $VM_NAME --zone $ZONE --command 'cd /opt/dronacharya && npm run build:frontend && systemctl restart dronacharya'"
    ;;

  *)
    echo "Invalid option: $TARGET"
    exit 1
    ;;
esac
