require('dotenv').config();
const mysql = require('mysql2');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306, // 🔥 ESSA LINHA FALTAVA
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'moura_vp',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

pool.getConnection((err, connection) => {
  if (err) {
    console.error('❌ Erro ao conectar no MySQL:', err.message);
    return;
  }

  console.log(`✅ Conectado ao banco ${process.env.DB_NAME || 'moura_vp'} com sucesso!`);
  connection.release();
});

module.exports = pool;