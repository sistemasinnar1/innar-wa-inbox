'use strict';

const mysql = require('mysql2/promise');

let pool = null;

function poolConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'wa_inbox',
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
    dateStrings: true,
    // Guardar DATETIME en UTC; el front formatea a America/Bogota
    timezone: process.env.DB_TIMEZONE || '+00:00'
  };
}

async function initPool() {
  if (pool) return pool;
  pool = mysql.createPool(poolConfig());
  pool.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
  });
  return pool;
}

function getPool() {
  if (!pool) throw new Error('Pool MySQL no inicializado');
  return pool;
}

async function query(sql, params = []) {
  const p = await initPool();
  const [rows] = await p.execute(sql, params);
  return rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function execute(sql, params = []) {
  const p = await initPool();
  const [result] = await p.execute(sql, params);
  return result;
}

function insertId(result) {
  if (!result) return 0;
  const id = result.insertId;
  if (id == null || id === 0) return 0;
  return typeof id === 'bigint' ? Number(id) : Number(id);
}

async function ensureSchema() {
  await execute(`
    CREATE TABLE IF NOT EXISTS wa_conversations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      phone VARCHAR(32) NOT NULL,
      display_name VARCHAR(200) NULL,
      last_message_at DATETIME NULL,
      last_message_preview VARCHAR(255) NULL,
      unread_count INT NOT NULL DEFAULT 0,
      last_rsvp VARCHAR(40) NULL,
      last_rsvp_at DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_wa_conv_phone (phone),
      INDEX idx_wa_conv_last (last_message_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await execute(`
    CREATE TABLE IF NOT EXISTS wa_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      conversation_id INT NOT NULL,
      direction ENUM('in','out') NOT NULL,
      body TEXT NULL,
      button_payload VARCHAR(100) NULL,
      twilio_sid VARCHAR(64) NULL,
      status VARCHAR(40) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_wa_msg_conv (conversation_id, created_at),
      UNIQUE KEY uq_wa_msg_sid (twilio_sid),
      CONSTRAINT fk_wa_msg_conv FOREIGN KEY (conversation_id)
        REFERENCES wa_conversations(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await ensureColumn('wa_conversations', 'last_rsvp', 'VARCHAR(40) NULL');
  await ensureColumn('wa_conversations', 'last_rsvp_at', 'DATETIME NULL');
  await ensureColumn('wa_conversations', 'last_inbound_at', 'DATETIME NULL');
  await ensureColumn('wa_conversations', 'last_direction', 'VARCHAR(8) NULL');
  await ensureColumn('wa_conversations', 'oculto', 'TINYINT NOT NULL DEFAULT 0');
  await ensureColumn('wa_conversations', 'plantilla', 'VARCHAR(20) NULL');
}

async function ensureColumn(table, column, definition) {
  const rows = await query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  const count = rows[0] && (rows[0].c ?? rows[0].C);
  if (!Number(count)) {
    await execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  initPool,
  getPool,
  query,
  queryOne,
  execute,
  insertId,
  ensureSchema,
  closePool
};
