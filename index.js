// Cargar las variables de entorno desde el archivo .env
require('dotenv').config();

// Importar las librerías necesarias
const express = require('express');
const { Pool } = require('pg');
const mqtt = require('mqtt');
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const cookieParser = require('cookie-parser');
const saltRounds = 10;

// --- CONFIGURACIÓN DE EXPRESS ---
const app = express();

// MIDDLEWARE PRINCIPAL
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ✅ CORS explícito para evitar bloqueos en frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ===================================================================================
// LÓGICA DE CONEXIÓN A LA BASE DE DATOS Y BCRYPT
// ===================================================================================
console.log('🔧 Intentando conectar a la base de datos...');
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
console.log('📋 DATABASE_URL:', process.env.DATABASE_URL ? '✅ Definida' : '❌ NO DEFINIDA');
console.log(`📋 Entorno: ${isProduction ? 'Producción (Railway)' : 'Desarrollo'}`);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
});

const testDatabaseConnection = async () => {
  try {
    const client = await pool.connect();
    client.release();
    console.log('✅ Conexión a PostgreSQL exitosa.');
    return true;
  } catch (err) {
    console.error('❌ Error de conexión a PostgreSQL:', err.message);
    return false;
  }
};

// ===================================================================================
// LÓGICA DE CONEXIÓN Y MANEJO DE MQTT
// ===================================================================================
let mqttClient;

const connectMqtt = () => {
  const url = process.env.MQTT_BROKER_URL || 'mqtt://test.mosquitto.org';
  mqttClient = mqtt.connect(url);

  mqttClient.on('connect', () => {
    console.log('✅ Conexión a MQTT Broker exitosa.');
    const telemetryTopic = 'dispositivos/+/telemetria';
    mqttClient.subscribe(telemetryTopic, (err) => {
      if (!err) {
        console.log(`✅ Suscrito al topic de telemetría general: ${telemetryTopic}`);
      } else {
        console.error(`❌ Error al suscribirse a ${telemetryTopic}:`, err);
      }
    });
  });
  return mqttClient;
};

connectMqtt();

// ===================================================================================
// FUNCIONES DE AUTENTICACIÓN
// ===================================================================================

const isAuth = (req, res, next) => {
  const token = req.cookies.session_token;
  if (!token) {
    return res.status(401).send({ message: 'No autorizado. Inicie sesión.', redirect: '/login.html' });
  }

  pool.query('SELECT usuario_id FROM sesiones WHERE token = $1 AND expira_en > NOW()', [token])
    .then(result => {
      if (result.rows.length === 0) {
        res.clearCookie('session_token');
        return res.status(401).send({ message: 'Sesión expirada. Por favor, vuelva a iniciar sesión.', redirect: '/login.html' });
      }
      req.userId = result.rows[0].usuario_id;
      next();
    })
    .catch(err => {
      console.error('Error al verificar sesión:', err);
      res.status(500).send({ message: 'Error interno del servidor.' });
    });
};

// ===================================================================================
// RUTAS DE AUTENTICACIÓN
// ===================================================================================

// POST /auth/register
app.post('/auth/register', async (req, res) => {
  const { nombre, correo, clave } = req.body;
  if (!nombre || !correo || !clave) {
    return res.status(400).json({ message: 'Faltan datos.' });
  }

  try {
    const hashed = await bcrypt.hash(clave, saltRounds);
    const result = await pool.query(
      'INSERT INTO usuarios (nombre, correo, clave_hash) VALUES ($1, $2, $3) RETURNING usuario_id',
      [nombre, correo, hashed]
    );
    const userId = result.rows[0].usuario_id;

    res.status(201).json({ message: 'Usuario registrado exitosamente.' });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ message: 'El correo ya está registrado.' });
    }
    console.error('Error al registrar usuario:', error);
    res.status(500).json({ message: 'Error interno al registrar usuario.' });
  }
});

// POST /auth/login
app.post('/auth/login', async (req, res) => {
  const { correo, clave } = req.body;
  if (!correo || !clave) {
    return res.status(400).json({ message: 'Faltan datos.' });
  }

  try {
    const result = await pool.query('SELECT usuario_id, clave_hash FROM usuarios WHERE correo = $1', [correo]);
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Credenciales incorrectas.' });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(clave, user.clave_hash);
    if (!match) {
      return res.status(401).json({ message: 'Credenciales incorrectas.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'INSERT INTO sesiones (token, usuario_id, expira_en) VALUES ($1, $2, NOW() + INTERVAL \'7 days\')',
      [token, user.usuario_id]
    );

    res.cookie('session_token', token, { httpOnly: true, secure: isProduction, sameSite: 'Lax' });
    res.status(200).json({ message: 'Inicio de sesión exitoso.' });
  } catch (error) {
    console.error('Error al iniciar sesión:', error);
    res.status(500).json({ message: 'Error interno del servidor.' });
  }
});

// POST /auth/logout
app.post('/auth/logout', isAuth, async (req, res) => {
  const token = req.cookies.session_token;
  await pool.query('DELETE FROM sesiones WHERE token = $1', [token]);
  res.clearCookie('session_token');
  res.status(200).json({ message: 'Sesión cerrada.' });
});

// ===================================================================================
// RUTAS DE LA API (Requieren autenticación)
// ===================================================================================

// GET /api/dispositivos (Listar dispositivos del usuario)
app.get('/api/dispositivos', isAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM dispositivo WHERE usuario_id = $1', [req.userId]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener dispositivos:', err);
    res.status(500).json({ message: 'Error al obtener la lista de dispositivos.' });
  }
});

// POST /api/dispositivo/registro (Endpoint para el frontend de add_device_config.js)
app.post('/api/dispositivo/registro', isAuth, async (req, res) => {
  const { serie, modelo, tipo, marca, topic } = req.body;
  if (!serie || !modelo || !tipo || !topic) {
    return res.status(400).json({ message: 'Datos incompletos.' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const insertQuery = `
      INSERT INTO dispositivos (serie, modelo, tipo, marca, topic, usuario_id, estatus, ultima_conexion)
      VALUES ($1, $2, $3, $4, $5, $6, 'offline', NOW())
      RETURNING dispositivo_id;
    `;
    const result = await client.query(insertQuery, [serie, modelo, tipo, marca, topic, req.userId]);
    const dispositivoId = result.rows[0].dispositivo_id;

    if (mqttClient) {
      mqttClient.subscribe(topic, (err) => {
        if (err) {
          console.error(`❌ Error al suscribirse al topic del nuevo dispositivo (${topic}):`, err);
        } else {
          console.log(`✅ Dispositivo ${serie} registrado y suscrito al topic: ${topic}`);
        }
      });
    }

    await client.query('COMMIT');
    res.status(201).json({
      message: 'Dispositivo registrado exitosamente en la plataforma.',
      dispositivo_id: dispositivoId,
      topic: topic
    });

  } catch (error) {
    if (client) await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json({ message: `El dispositivo con serie ${serie} ya está registrado.` });
    }
    console.error('Error al registrar nuevo dispositivo:', error);
    res.status(500).json({ message: 'Error interno al registrar el dispositivo.' });
  } finally {
    if (client) client.release();
  }
});

// ===================================================================================
// PROCESAMIENTO DE MENSAJES MQTT
// ===================================================================================

const procesarMensajesMqtt = () => {
  if (!mqttClient) return;

  mqttClient.on('message', async (topic, message) => {
    const parts = topic.split('/');
    if (parts.length !== 3 || parts[2] !== 'telemetria') return;
    const serie = parts[1];

    let dbClient;
    try {
      const data = JSON.parse(message.toString());
      const { temp, ph, msg_id } = data;
      const timestamp = new Date();

      if (!serie || temp === undefined || ph === undefined || !msg_id) {
        console.warn(`⚠️ Mensaje inválido o incompleto del topic [${topic}].`);
        return;
      }

      dbClient = await pool.connect();
      await dbClient.query('BEGIN');

      const deviceResult = await dbClient.query('SELECT dispositivo_id FROM dispositivos WHERE serie = $1', [serie]);
      if (deviceResult.rows.length === 0) {
        await dbClient.query('ROLLBACK');
        return;
      }
      const dispositivo_id = deviceResult.rows[0].dispositivo_id;

      const telemetryInsert = `
        INSERT INTO telemetria (dispositivo_id, temperatura, ph, marca_tiempo, msg_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (dispositivo_id, msg_id) DO NOTHING;
      `;
      await dbClient.query(telemetryInsert, [dispositivo_id, temp, ph, timestamp, msg_id]);

      const updateDevice = `
        UPDATE dispositivos
        SET 
          ultima_conexion = $1, 
          estatus = 'online',
          ultimos_valores = jsonb_build_object('temperatura', $2, 'ph', $3)
        WHERE dispositivo_id = $4;
      `;
      await dbClient.query(updateDevice, [timestamp, temp, ph, dispositivo_id]);

      await dbClient.query('COMMIT');
    } catch (error) {
      if (dbClient) await dbClient.query('ROLLBACK');
      console.error(`❌ Error procesando mensaje del topic [${topic}]:`, error.message);
    } finally {
      if (dbClient) dbClient.release();
    }
  });

  mqttClient.on('error', (error) => {
    console.error('❌ Error en la conexión MQTT:', error);
  });
};

// ===================================================================================
// MARCAR DISPOSITIVOS OFFLINE
// ===================================================================================

const marcarOfflineSiNoReportan = async () => {
  try {
    await pool.query(`
      UPDATE dispositivo
      SET estatus = 'offline'
      WHERE estatus = 'online' AND ultima_conexion < NOW() - INTERVAL '5 minutes'
    `);
  } catch (err) {
    console.error('❌ Error al marcar dispositivos offline:', err);
  }
};

setInterval(marcarOfflineSiNoReportan, 60000); // Cada 60 segundos

// ===================================================================================
// RUTAS ADICIONALES Y SERVIDOR DE ARCHIVOS ESTÁTICOS (FRONTEND)
// ===================================================================================

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/', (req, res) => {
  if (req.cookies.session_token) {
    res.sendFile(path.join(__dirname, 'www', 'app.html'));
  } else {
    res.sendFile(path.join(__dirname, 'www', 'login.html'));
  }
});

app.use(express.static(path.join(__dirname, 'www')));

// ===================================================================================
// INICIAR EL SERVIDOR EXPRESS
// ===================================================================================
const PORT = process.env.PORT || 8080;

const initializeApplicationServices = async () => {
  const dbConnected = await testDatabaseConnection();
  if (!dbConnected) {
    console.error('❌ No se pudo conectar a la base de datos. Las funciones de autenticación y DB fallarán.');
  } else {
    try {
      procesarMensajesMqtt();
    } catch (error) {
      console.error('❌ Error iniciando MQTT:', error);
    }
  }
};

const startServer = () => {
  console.log('🚀 Iniciando servidor Express...');
  const host = isProduction ? '0.0.0.0' : 'localhost';

  app.listen(PORT, host, () => {
    console.log(`✅ Servidor Express ejecutándose en ${host}:${PORT}`);
  });
};

initializeApplicationServices();
startServer();