#!/bin/bash
# Veritabanını Export Et — Windows'tan çalıştır

set -e

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DUMP_FILE="decco_backup_${TIMESTAMP}.sql.bz2"

echo "💾 Decco OS Veritabanı Yedekleniyor..."
echo "📁 Dosya: $DUMP_FILE"

docker exec decco_db pg_dump -U decco decco | bzip2 > "$DUMP_FILE"

echo "✅ Backup tamamlandı"
echo ""
echo "📤 Mac'te import için:"
echo "   scp $DUMP_FILE mac_user@mac_host:~/"
echo "   bzcat $DUMP_FILE | docker exec -i decco_db psql -U decco -d decco"
