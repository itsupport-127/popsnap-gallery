#!/bin/bash
# ============================================================
#  DEPLOY - Popsnap Gallery
#  Jalankan dari: ~/apps/
#  Usage: bash deploy-gallery.sh
# ============================================================

set -e

GALLERY_DIR=~/apps/popsnap-gallery
DOMAIN="gallery-popsnap.duckdns.org"
PORT_INTERNAL=8088   # port container (internal, hanya localhost)
PORT_HTTPS=8588      # port HTTPS publik yang diakses dari luar

echo "======================================"
echo "  DEPLOY - Popsnap Gallery"
echo "======================================"

# ----------------------------------------------------------
# 1. Upload & extract
# ----------------------------------------------------------
echo ""
echo "[1/6] Extract popsnap-gallery ke ~/apps/..."
mkdir -p ~/apps
# (file sudah di-upload ke VPS oleh user, extract di sini)
# Kalau zip ada di home dir:
if [ -f ~/popsnap-gallery.zip ]; then
  unzip -o ~/popsnap-gallery.zip -d ~/apps/
  echo "      Extract selesai."
else
  echo "      SKIP: folder sudah ada atau zip tidak ditemukan di ~/"
fi

cd $GALLERY_DIR

# ----------------------------------------------------------
# 2. Buat .env
# ----------------------------------------------------------
echo ""
echo "[2/6] Membuat .env..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "      .env dibuat dari .env.example"
  echo "      ⚠️  Edit .env sesuai kebutuhan setelah script selesai!"
else
  echo "      .env sudah ada, tidak ditimpa."
fi

# ----------------------------------------------------------
# 3. Buat SSL certificate (self-signed)
# ----------------------------------------------------------
echo ""
echo "[3/6] Membuat SSL certificate..."
mkdir -p docker/ssl
if [ ! -f docker/ssl/cert.pem ]; then
  openssl req -x509 -newkey rsa:4096 -keyout docker/ssl/key.pem \
    -out docker/ssl/cert.pem -days 3650 -nodes \
    -subj "/CN=$DOMAIN" \
    -addext "subjectAltName=DNS:$DOMAIN,IP:103.150.226.74"
  echo "      SSL cert dibuat."
else
  echo "      SSL cert sudah ada, skip."
fi

# ----------------------------------------------------------
# 4. Buat nginx.conf untuk reverse proxy
# ----------------------------------------------------------
echo ""
echo "[4/6] Membuat nginx config..."
mkdir -p docker

cat > docker/nginx.conf << 'NGINX'
server {
    listen 80;
    server_name _;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name _;

    ssl_certificate     /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    client_max_body_size 310m;

    location / {
        proxy_pass         http://popsnap-gallery:8088;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto https;
        proxy_buffering    off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
NGINX
echo "      nginx.conf dibuat."

# ----------------------------------------------------------
# 5. Update docker-compose.yml dengan nginx
# ----------------------------------------------------------
echo ""
echo "[5/6] Membuat docker-compose.yml dengan Nginx SSL..."

cat > docker-compose.yml << COMPOSE
services:
  popsnap-gallery:
    build: .
    container_name: popsnap-gallery
    restart: unless-stopped
    env_file: .env
    expose:
      - "8088"
    volumes:
      - ./data:/data
    mem_limit: 512m
    networks:
      - gallery-net

  gallery-nginx:
    image: nginx:alpine
    container_name: gallery-nginx
    restart: unless-stopped
    ports:
      - "8588:443"
      - "8589:80"
    volumes:
      - ./docker/nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - ./docker/ssl:/etc/nginx/ssl:ro
    depends_on:
      - popsnap-gallery
    networks:
      - gallery-net

networks:
  gallery-net:
    driver: bridge
COMPOSE
echo "      docker-compose.yml diperbarui."

# ----------------------------------------------------------
# 6. Build & run
# ----------------------------------------------------------
echo ""
echo "[6/6] Build & jalankan container..."
docker compose down 2>/dev/null || true
docker compose build --no-cache
docker compose up -d

echo ""
echo "⏳ Tunggu app ready..."
sleep 8

# Cek health
HTTP_STATUS=$(curl -sk -o /dev/null -w "%{http_code}" http://127.0.0.1:8088/healthz || echo "000")
echo "   Health check internal: HTTP $HTTP_STATUS"

echo ""
echo "======================================"
echo "  DEPLOY SELESAI!"
echo ""
echo "  App berjalan di:"
echo "  https://103.150.226.74:8588"
echo ""
echo "  ⚠️  LANGKAH SELANJUTNYA:"
echo "  1. Edit ~/apps/popsnap-gallery/.env"
echo "     PUBLIC_URL=https://gallery-popsnap.duckdns.org:8588"
echo "     ADMIN_USER=admin"
echo "     ADMIN_PASSWORD=password-kuat-disini"
echo "     KASIR_URL=https://antrian-papyrus-jogja.duckdns.org:8493"
echo "  2. Daftarkan DuckDNS: gallery-popsnap.duckdns.org → 103.150.226.74"
echo "  3. docker compose restart (setelah edit .env)"
echo "  4. Buka https://gallery-popsnap.duckdns.org:8588/admin"
echo "======================================"
