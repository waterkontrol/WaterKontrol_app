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

// MIDDLEWARE PRINCIPAL (Debe ir primero para parsear body/cookies)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ===================================================================================
// LÓGICA DE CONEXIÓN A LA BASE DE DATOS Y BCRYPT
// ===================================================================================
console.log('🔧 Intentando conectar a la base de datos...');
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
console.log('📋 DATABASE_URL:', process.env.DATABASE_URL ? '✅ Definida' : '❌ NO DEFINIDA');
console.log(`📋 Entorno: ${isProduction ? 'Producción (SSL ON)' : 'Local (SSL OFF)'}`);

const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10
};

const pool = new Pool(poolConfig);

const testDatabaseConnection = async () => {
  let client;
  try {
    client = await pool.connect();
    console.log('✅ Conexión a la base de datos establecida correctamente');
    const result = await client.query('SELECT 1 as db_connection_ok');
    if (result.rows[0].db_connection_ok === 1) {
      console.log('✅ db connection ok');
    }
    await initializeDatabase(client);
    return true;
  } catch (error) {
    console.error('❌ Error crítico al conectar/verificar la DB:', error.message);
    return false;
  } finally {
    if (client) {
      client.release();
    }
  }
};

const initializeDatabase = async (client) => {
  const checkUserTable = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name='usuario' AND column_name IN ('correo', 'clave', 'token_verificacion', 'estatus')
  `);
  const requiredColumns = ['correo', 'clave', 'token_verificacion', 'estatus'];
  const foundColumns = checkUserTable.rows.map(row => row.column_name);
  if (requiredColumns.every(col => foundColumns.includes(col))) {
    console.log(`✅ Tabla "usuario" verificada. Usando campos: ${foundColumns.join(', ')}.`);
  } else {
    console.warn('⚠️ La tabla "usuario" puede necesitar ser creada o revisada.');
  }
};

// ===================================================================================
// LÓGICA DE AUTENTICACIÓN
// ===================================================================================

const verifyToken = async (token) => {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      'SELECT correo FROM usuario WHERE token_verificacion = $1 AND estatus = $2',
      [token, 'PENDIENTE']
    );
    if (result.rows.length === 1) {
      await client.query(
        'UPDATE usuario SET estatus = $1, token_verificacion = NULL WHERE correo = $2',
        ['ACTIVO', result.rows[0].correo]
      );
      return { success: true };
    }
    return { success: false, message: 'Token de verificación inválido o ya usado.' };
  } catch (error) {
    console.error('Error en verifyToken:', error);
    return { success: false, message: 'Error interno del servidor.' };
  } finally {
    if (client) client.release();
  }
};

const authenticateToken = (req, res, next) => {
  const token = req.cookies.session_token;

  if (req.path.startsWith('/auth') || req.path === '/' || req.path.endsWith('.css') || req.path.endsWith('.js') || req.path === '/register.html' || req.path === '/forgot.html') {
    return next();
  }

  if (req.path.includes('/app.html') || req.path === '/dispositivos' || req.path === '/dispositivo' || req.path === '/auth/logout') {
    if (!token) {
      if (req.path !== '/app.html') {
        return res.status(401).json({ message: 'No autorizado' });
      }
      return res.redirect('/');
    }
  }

  return next();
};

// ===================================================================================
// LÓGICA DE CORREO ELECTRÓNICO
// ===================================================================================

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const sendVerificationEmail = async (correo, token) => {
  const verificationUrl = `${process.env.APP_BASE_URL}/auth/verify?token=${token}`;
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: correo,
    subject: 'Verificación de Cuenta WaterKontrol',
    html: `
      <h1>Verificación de Correo</h1>
      <p>Gracias por registrarte en WaterKontrol. Por favor, haz clic en el siguiente enlace para verificar tu cuenta:</p>
      <a href="${verificationUrl}">${verificationUrl}</a>
      <p>Si no solicitaste este registro, por favor ignora este correo.</p>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ Correo de verificación enviado a: ${correo}`);
    return true;
  } catch (error) {
    console.error('❌ Error al enviar correo de verificación:', error);
    return false;
  }
};

// ===================================================================================
// LÓGICA MQTT
// ===================================================================================
let mqttClient = null;

const procesarMensajesMqtt = () => {
  const brokerUrl = process.env.MQTT_BROKER_URL;
  if (!brokerUrl) {
    console.error('❌ MQTT_BROKER_URL no está definido. Saltando la conexión MQTT.');
    return;
  }

  const client = mqtt.connect(brokerUrl);
  mqttClient = client;

  client.on('connect', () => {
    console.log('✅ Conectado al broker MQTT.');
    const topic = 'dispositivos/+/telemetria';
    client.subscribe(topic, (err) => {
      if (!err) {
        console.log(`✅ Suscrito exitosamente al topic: ${topic}`);
      } else {
        console.error(`❌ Error al suscribirse al topic ${topic}:`, err);
      }
    });
  });

  client.on('message', async (topic, message) => {
    let dbClient;
    try {
      const data = JSON.parse(message.toString());
      console.log(`[${new Date().toISOString()}] Mensaje de MQTT en [${topic}]:`, data);

      dbClient = await pool.connect();
      await dbClient.query('BEGIN');

      const insertQuery = `
        INSERT INTO telemetria (topic, nivel, fecha)
        VALUES ($1, $2, NOW())
        RETURNING id;
      `;
      const result = await dbClient.query(insertQuery, [topic, data.nivel]);
      const msg_id = result.rows[0].id;

      await dbClient.query('COMMIT');
      console.log(`✅ Mensaje del topic [${topic}] procesado y guardado con éxito (MSG_ID: ${msg_id}).`);
    } catch (error) {
      if (dbClient) {
        await dbClient.query('ROLLBACK');
      }
      console.error(`❌ Error procesando mensaje del topic [${topic}]:`, error.message);
    } finally {
      if (dbClient) {
        dbClient.release();
      }
    }
  });

  client.on('error', (error) => {
    console.error('❌ Error en la conexión MQTT:', error);
  });
};

// ===================================================================================
// RUTAS DE LA API (ENDPOINT) - ¡DEBEN IR ANTES DE APP.STATIC!
// ===================================================================================

// -----------------------------------------------------------------------------------
// RUTAS DE API PÚBLICAS (No requieren token)
// -----------------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.status(200).send({ status: 'OK', service: 'waterkontrol-backend' });
});

app.post('/auth/register', async (req, res) => {
  const { nombre, correo, clave } = req.body;
  let client;

  if (!nombre || !correo || !clave) {
    return res.status(400).json({ message: 'Faltan campos obligatorios.' });
  }

  try {
    client = await pool.connect();

    const existingUser = await client.query('SELECT * FROM usuario WHERE correo = $1', [correo]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ message: 'El correo ya está registrado.' });
    }

    const hashedClave = await bcrypt.hash(clave, saltRounds);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    await client.query(
      'INSERT INTO usuario (nombre, correo, clave, token_verificacion, estatus) VALUES ($1, $2, $3, $4, $5)',
      [nombre, correo, hashedClave, verificationToken, 'PENDIENTE']
    );
    sendVerificationEmail(correo, verificationToken);

    res.status(201).json({
      message: 'Registro exitoso. Revisa tu correo para verificar la cuenta.',
      verification_sent: true
    });
  } catch (error) {
    console.error('Error al registrar usuario:', error);
    res.status(500).json({ message: 'Error interno del servidor al registrar.' });
  } finally {
    if (client) client.release();
  }
});

app.get('/auth/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).send('Token de verificación no proporcionado.');
  }

  const { success, message } = await verifyToken(token);

  if (success) {
    res.redirect('/?message=✅ Cuenta verificada. Puedes iniciar sesión.');
  } else {
    res.status(400).send(`❌ Error de Verificación: ${message}`);
  }
});

// ✅ AHORA SÍ ESTÁ ANTES DE STATIC
app.post('/auth/login', async (req, res) => {
  const { correo, clave } = req.body;
  let client;

  try {
    client = await pool.connect();
    const userResult = await client.query('SELECT * FROM usuario WHERE correo = $1', [correo]);

    if (userResult.rows.length === 0) {
      return res.status(401).json({ message: 'Credenciales inválidas.' });
    }

    const user = userResult.rows[0];

    if (user.estatus !== 'ACTIVO') {
      return res.status(403).json({
        message: 'Cuenta pendiente de verificación. Revisa tu correo.',
        error_code: 'ACCOUNT_PENDING'
      });
    }

    const isMatch = await bcrypt.compare(clave, user.clave);
    if (!isMatch) {
      return res.status(401).json({ message: 'Credenciales inválidas.' });
    }

    const sessionToken = crypto.randomBytes(64).toString('hex');
    res.cookie('session_token', sessionToken, {
      httpOnly: true,
      secure: isProduction,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'Lax'
    });

    res.status(200).json({
      message: 'Inicio de sesión exitoso.',
      redirect: '/app.html'
    });
  } catch (error) {
    console.error('Error en el login:', error);
    res.status(500).json({ message: 'Error interno del servidor.' });
  } finally {
    if (client) client.release();
  }
});

// ===================================================================================
// MIDDLEWARE DE AUTENTICACIÓN
// (Se aplica a todo lo que esté definido DESPUÉS de él)
// ===================================================================================
app.use(authenticateToken);

// ===================================================================================
// RUTAS DE API PROTEGIDAS (Requieren token)
// ===================================================================================

app.post('/auth/logout', (req, res) => {
  res.clearCookie('session_token');
  res.status(200).json({ message: 'Sesión cerrada.' });
});

app.post('/dispositivo', async (req, res) => {
  const { usr_id, dsp_id, topic, tipo, marca } = req.body;
  console.log(`📌 Dispositivo ${dsp_id} intentando registrarse con topic ${topic}.`);
  res.status(200).json({ message: 'Registro de dispositivo recibido (Lógica pendiente de implementar).', dsp_id });
});

app.get('/dispositivos', (req, res) => {
  const mockDevices = [
    { id: 1, nombre: 'Tanque Principal', tipo: 'Nivel', marca: 'WaterKontrol', topic: 'dispositivos/tk-001/telemetria', estatus: 'ACTIVO' },
    { id: 2, nombre: 'Pozo de Bombeo', tipo: 'Bomba', marca: 'WK-Pro', topic: 'dispositivos/pozo-002/telemetria', estatus: 'INACTIVO' }
  ];
  res.json(mockDevices);
});

// ===================================================================================
// SERVIDOR DE ARCHIVOS ESTÁTICOS (FRONTEND)
// (Debe ir DESPUÉS de las rutas de API)
// ===================================================================================

// CRÍTICO: Servir el frontend desde la carpeta 'www'
app.use(express.static(path.join(__dirname, 'www')));

// ===================================================================================
// LÓGICA DE INICIO DEL SERVIDOR (CRÍTICO PARA RAILWAY )
// ===================================================================================

const PORT = process.env.PORT || 8080;

const initializeApplicationServices = async () => {
  console.log('🔍 Iniciando verificación de base de datos y MQTT (en segundo plano)...');
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
    console.log(`✅ Healthcheck disponible en /health`);
    initializeApplicationServices();
  });
};

startServer();