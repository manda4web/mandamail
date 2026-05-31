#!/bin/bash
# =============================================================
# Setup script for AWS Lightsail (Amazon Linux 2 / ec2-user)
# Run this ONCE on the server to install Docker + Docker Compose
# =============================================================

set -e

echo "=== Updating system packages ==="
sudo yum update -y

echo "=== Installing Docker ==="
sudo yum install -y docker
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker ec2-user

echo "=== Installing Docker Compose v2 ==="
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

echo "=== Installing Git ==="
sudo yum install -y git

echo "=== Creating app directory ==="
sudo mkdir -p /opt/mandamail
sudo chown ec2-user:ec2-user /opt/mandamail

echo "=== Setup complete! ==="
echo ""
echo "IMPORTANT: Log out and log back in for docker group to take effect."
echo "Then run: deploy/deploy.sh"
