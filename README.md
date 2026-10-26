# POPSNAP Galeri

Halaman unduh untuk QR di booth. Tamu scan QR → halaman POPSNAP berisi **hasil template (atas)** dan **foto mentah + klip (bawah)**, tombol unduh per file dan "Unduh semua (ZIP)".

* File **tidak disimpan di VPS**. Booth mengunggah langsung ke cloud S3-kompatibel (Cloudflare R2, Backblaze B2, AWS S3, Wasabi, dll.) memakai URL bertanda tangan dari layanan ini. VPS hanya menyimpan daftar file (database kecil) dan menampilkan halaman.
* Bisa memakai **banyak bucket / banyak akun**. Sesi baru masuk ke bucket berprioritas terkecil yang masih muat; kalau penuh atau gagal pindah otomatis.
* File **dihapus otomatis** setelah N hari (default 7, atur di halaman admin).
* Token studio sama dengan token yang dipakai booth untuk sinkron ke app kasir (diperiksa ke kasir).

## Pasang di VPS (Docker, berdampingan dengan aplikasi lain)

```bash
# 1. salin folder ini ke VPS, mis. /opt/popsnap-gallery
cd /opt/popsnap-gallery
cp .env.example .env && nano .env      # isi PUBLIC_URL, ADMIN_PASSWORD, KASIR_URL
docker compose up -d --build
curl http://127.0.0.1:8088/healthz      # -> {"ok":true}
```

Container hanya membuka `127.0.0.1:8088` (tidak memakai port 80/443). Arahkan domain ke sini lewat reverse proxy yang sudah Anda pakai:

**Nginx / Nginx Proxy Manager** — proxy host `foto.domainanda.com` → `http://127.0.0.1:8088` (atau `host.docker.internal` / IP docker bila proxy-nya di dalam container), aktifkan SSL.
Tambahkan untuk unduhan ZIP besar: `proxy_buffering off; proxy_read_timeout 300s;`

**Caddy** — `foto.domainanda.com { reverse_proxy 127.0.0.1:8088 }`

**Cloudflare Tunnel** — public hostname `foto.domainanda.com` → `http://localhost:8088`.

Di DNS Cloudflare: record `foto` → IP VPS (atau CNAME ke host duckdns Anda), proxied boleh. Matikan "Cache Everything" untuk domain ini (halaman bersifat sementara).

## Siapkan bucket Cloudflare R2 (gratis 10 GB per akun)

1. Cloudflare → R2 → *Create bucket* (mis. `popsnap-1`). **Biarkan private** (tidak perlu public access).
2. R2 → *Manage API tokens* → *Create API token* → izin **Object Read & Write** → pilih bucket itu. Catat **Access Key ID**, **Secret Access Key**, dan alamat S3 (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).
3. Buka `https://foto.domainanda.com/admin` → *Tambah bucket*: Endpoint = alamat S3 tadi, Region = `auto`, isi nama bucket & key, prioritas, batas GB (mis. 9) → Simpan → **Tes**.
4. Punya akun R2 lain? Tambahkan bucket lagi. Kapasitas digabung otomatis.

Opsional (disarankan): R2 → bucket → *Settings → Object lifecycle* → hapus objek lebih dari 30 hari, sebagai jaring pengaman bila layanan ini mati.

## Hubungkan booth

Di aplikasi booth: **Admin → Pembayaran → kartu "Galeri cloud"**: isi alamat galeri (`https://foto.domainanda.com`), centang aktif. Token studio diambil dari pengaturan sinkron kasir (kartu di atasnya) — tidak perlu token baru. Klik **Tes koneksi**.

## Siapkan bucket Backblaze B2 (gratis 10 GB)

1. Daftar di backblaze.com → *Buckets* → *Create a Bucket* (mis. `popsnap-b2`), **Private**, enkripsi bawaan boleh. Catat *S3 Endpoint* (mis. `s3.us-west-004.backblazeb2.com`) — region ikut dari alamat ini.
2. *Application Keys* → *Add a New Application Key*: batasi ke bucket itu, izin **Read and Write**. Catat **keyID** dan **applicationKey** (applicationKey hanya tampil sekali).
3. Di `/admin` galeri → *Tambah bucket* → Jenis **Backblaze B2**: Endpoint = `https://s3.us-west-004.backblazeb2.com`, Region dikosongkan, Access key = keyID, Secret = applicationKey. Simpan → **Tes**.
4. Unduhan pelanggan gratis sampai 3x dari jumlah yang tersimpan; foto yang dihapus otomatis setelah 7–15 hari membuat ini aman. Opsional: *Lifecycle Settings* bucket → hapus file lebih dari 30 hari sebagai jaring pengaman.

**Menggabungkan beberapa akun:** tambahkan semua bucket (R2 akun 1, R2 akun 2, B2, …). Beri **prioritas** sama supaya dibagi rata, atau prioritas berbeda (mis. R2 = 1, B2 = 2 sebagai cadangan). Isi **batas GB** sedikit di bawah kuota gratis (R2: 9, B2: 9) supaya tidak melewati batas.

## Unggah manual dari PC CS (kalau internet booth bermasalah)

Booth menyimpan hasil di folder output (mis. `D:\HASIL` / `POPSNAP-Photos`) dan folder itu dibagikan di jaringan studio. Di tiap folder sesi booth menulis `popsnap-share.json` (berisi token link yang sama dengan QR).

1. Di PC CS buka `https://foto.domainanda.com/admin` (login admin galeri).
2. Bagian **Unggah manual dari PC CS** → **Pilih folder…** → pilih folder tanggal (banyak sesi sekaligus) atau satu folder sesi dari drive jaringan booth.
3. File diteruskan lewat website ke cloud. Link pelanggan **langsung hidup** (sama dengan QR yang sudah mereka scan). Sesi tanpa `popsnap-share.json` mendapat link baru yang bisa dikirim ke pelanggan.
4. Saat internet booth pulih, booth menyusul otomatis: sesi diambil alih dan file yang sudah ada tidak diunggah ulang.

Nama studio diisi otomatis bila kode studio dikenal; kalau tidak, isi kolom "Nama studio".

## Ke depan
* Tambah `kasir` → tautan galeri per transaksi (opsional).
* Cadangan ke Google Drive: sudah tersedia lewat opsi Ekspor folder di booth.

## Uji
`npm install && npm test`
