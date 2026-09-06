import pg from 'pg'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const { Pool } = pg

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

// Parameterli sorgu yardımcısı
export const query = (text, params) => pool.query(text, params)

// Migration: schema.sql'i çalıştır
export async function runMigrations() {
  const __dir = dirname(fileURLToPath(import.meta.url))
  const sql = readFileSync(join(__dir, '../db/schema.sql'), 'utf8')
  await pool.query(sql)
  console.log('DB schema ready')
}
