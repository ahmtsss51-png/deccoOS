#!/bin/bash
# Decco OS — GitHub'a Gönder

set -e

echo "🚀 Decco OS GitHub'a Gönderiliyor..."

# GitHub bilgileri sor
read -p "GitHub Repo URL (https://github.com/...): " GITHUB_URL
read -p "GitHub Personal Access Token (PAT): " GITHUB_TOKEN

if [ -z "$GITHUB_URL" ] || [ -z "$GITHUB_TOKEN" ]; then
  echo "❌ URL ve token gerekli"
  exit 1
fi

# Token ve URL'yi kombine et
REMOTE_URL=$(echo "$GITHUB_URL" | sed 's|https://||')
AUTH_URL="https://oauth2:${GITHUB_TOKEN}@${REMOTE_URL}"

# Remote ekle veya değiştir
if git remote | grep -q "^origin$"; then
  echo "📝 Origin remote güncelleniyor..."
  git remote set-url origin "$AUTH_URL"
else
  echo "📝 Origin remote ekleniyor..."
  git remote add origin "$AUTH_URL"
fi

# Push et
echo "⬆️ GitHub'a pushlanıyor..."
git push -u origin master --force

echo "✅ Başarılı! Repo: $GITHUB_URL"
echo "📌 Mac'te: git clone $GITHUB_URL"
