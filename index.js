// Cargar las variables de entorno desde el archivo .env
require('dotenv').config();

// Importar las librerías necesarias
const express = require('express');
const { Pool } = require('pg');
const mqtt = require('mqtt');
const path = require('path'); // ¡CRÍTICO! Necesario para servir archivos estáticos y rutas
const bcrypt = require('bcrypt'); // Necesario para hashing de contraseñas
const crypto = require('crypto'); // Necesario para generar tokens
const nodemailer = require('nodemailer'); // Necesario para el envío de correos
const cookieParser = require('cookie-parser'); // ¡NUEVO! Necesario para la gestión de cookies de sesión
const saltRounds = 10;

// --- CONFIGURACIÓN DE EXPRESS ---
const app = express();

// MIDDLEWARE PRINCIPAL
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser()); // ¡NUEVO! Activar middleware de cookies

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
// CRÍTICO: Detectar el entorno para configurar SSL y Host
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
console.log('📋 DATABASE_URL:', process.env.DATABASE_URL ? '✅ Definida' : '❌ NO DEFINIDA');
console.log(`📋 Entorno: ${isProduction ? 'Producción (SSL ON)' : 'Local (SSL OFF)'}`);

const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  // CRÍTICO: Configuración SSL para Railway
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
    console.log('✅ Conexión a la base de datos exitosa.');
    return true;
  } catch (err) {
    console.error('❌ Error de conexión a la base de datos:', err.message);
    return false;
  } finally {
    if (client) {
      client.release();
    }
  }
};

const hashPassword = async (password) => {
  return bcrypt.hash(password, saltRounds);
};

const comparePassword = async (password, hash) => {
  return bcrypt.compare(password, hash);
};

// ===================================================================================
// LOGICA DE CONEXION MQTT
// ===================================================================================

let mqttClient;
const procesarMensajesMqtt = async () => {
  const brokerUrl = process.env.MQTT_BROKER_URL;
  if (!brokerUrl) {
    console.error('❌ MQTT_BROKER_URL no está definido. Omitiendo conexión MQTT.');
    return;
  }

  mqttClient = mqtt.connect(brokerUrl);

  mqttClient.on('connect', () => {
    console.log('✅ Conexión MQTT exitosa. Suscribiéndose a topics...');
    // Suscribirse a un topic genérico de telemetría de dispositivos
    mqttClient.subscribe('dispositivos/+/telemetria', (err) => {
      if (err) {
        console.error('❌ Error de suscripción MQTT:', err);
      } else {
        console.log('✅ Suscripción a [dispositivos/+/telemetria] exitosa.');
      }
    });
  });

  mqttClient.on('message', async (topic, message) => {
    let dbClient;
    try {
      dbClient = await pool.connect();
      await dbClient.query('BEGIN');

      const data = JSON.parse(message.toString());
      const { temp, ph, serie } = data; // Asumiendo que el dispositivo envía { temp, ph, serie }

      if (!serie || temp === undefined || ph === undefined) {
        console.warn(`⚠️ Mensaje MQTT inválido o incompleto en [${topic}]:`, data);
        await dbClient.query('ROLLBACK');
        return;
      }

      // 1. Obtener el ID del dispositivo usando la serie
      const deviceQuery = 'SELECT dsp_id FROM dispositivos WHERE serie = $1';
      const deviceResult = await dbClient.query(deviceQuery, [serie]);

      if (deviceResult.rows.length === 0) {
        console.warn(`⚠️ Dispositivo con serie [${serie}] no encontrado. Mensaje no procesado.`);
        await dbClient.query('ROLLBACK');
        return;
      }

      const dsp_id = deviceResult.rows[0].dsp_id;

      // 2. Insertar los datos de telemetría en la tabla de datos
      const insertDataQuery = `
        INSERT INTO datos (dsp_id, temperatura, ph, topic)
        VALUES ($1, $2, $3, $4)
        RETURNING msg_id
      `;
      const insertResult = await dbClient.query(insertDataQuery, [dsp_id, temp, ph, topic]);
      const msg_id = insertResult.rows[0].msg_id;

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
// RUTAS DE AUTENTICACIÓN (LOGIN, REGISTER, LOGOUT)
// ===================================================================================

// Middleware para verificar la sesión/cookie
const checkAuth = (req, res, next) => {
  // En un entorno real, verificarías un token JWT o una sesión de base de datos
  if (req.cookies.user_id) {
    req.userId = req.cookies.user_id; // Adjuntar el ID de usuario a la petición
    next();
  } else {
    // Si no hay cookie, redirigir al login
    res.redirect('/login.html');
  }
};

// Ruta de Registro de Usuario
app.post('/auth/register', async (req, res) => {
  const { nombre, correo, clave } = req.body;
  let client;
  try {
    if (!nombre || !correo || !clave) {
      return res.status(400).json({ message: 'Todos los campos son obligatorios.' });
    }

    client = await pool.connect();
    const hashedPassword = await hashPassword(clave);

    // Verificar si el correo ya existe
    const checkUser = await client.query('SELECT user_id FROM usuarios WHERE correo = $1', [correo]);
    if (checkUser.rows.length > 0) {
      return res.status(409).json({ message: 'Este correo ya está registrado.' });
    }

    // Insertar el nuevo usuario (estatus 'verificacion' para simular un proceso de email)
    const result = await client.query(
      'INSERT INTO usuarios (nombre, correo, clave_hash) VALUES ($1, $2, $3) RETURNING user_id',
      [nombre, correo, hashedPassword]
    );

    // Enviar respuesta al cliente (NOTA: NO debería establecer la sesión hasta verificar el correo)
    res.status(200).json({
      message: '✅ Registro exitoso. Ahora puedes iniciar sesión.'
    });

  } catch (error) {
    console.error('Error en /auth/register:', error.message);
    res.status(500).json({ message: 'Error interno del servidor.' });
  } finally {
    if (client) client.release();
  }
});


// Ruta de Login
app.post('/auth/login', async (req, res) => {
  const { correo, clave } = req.body;
  let client;
  try {
    if (!correo || !clave) {
      return res.status(400).json({ message: 'Correo y Contraseña son obligatorios.' });
    }

    client = await pool.connect();
    const result = await client.query('SELECT user_id, clave_hash FROM usuarios WHERE correo = $1', [correo]);

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Credenciales inválidas.' });
    }

    const user = result.rows[0];
    const match = await comparePassword(clave, user.clave_hash);

    if (match) {
      // Éxito: Establecer la cookie de sesión
      res.cookie('user_id', user.user_id, {
        httpOnly: true, // La cookie no es accesible por JavaScript en el navegador
        secure: isProduction, // CRÍTICO: Solo enviar con HTTPS en producción
        maxAge: 1000 * 60 * 60 * 24 * 7 // 7 días de validez
      });

      // Enviar respuesta JSON al cliente
      res.status(200).json({
        message: 'Inicio de sesión exitoso.',
        redirect: '/app.html' // Redirigir a la página principal de la app
      });
    } else {
      return res.status(401).json({ message: 'Credenciales inválidas.' });
    }

  } catch (error) {
    console.error('Error en /auth/login:', error.message);
    res.status(500).json({ message: 'Error interno del servidor.' });
  } finally {
    if (client) client.release();
  }
});

// Ruta de Logout
app.post('/auth/logout', (req, res) => {
  res.clearCookie('user_id'); // Eliminar la cookie de sesión
  res.status(200).json({ message: 'Sesión cerrada.' });
});

// ===================================================================================
// RUTAS DE API (DISPOSITIVOS)
// ===================================================================================

// 1. Obtener la lista de dispositivos del usuario
app.get('/api/dispositivos', checkAuth, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    // NOTA: Asumiendo que existe una tabla 'usuarios_dispositivos' o similar para relacionar.
    // Usaremos una consulta directa de dispositivos para este ejemplo (si hay una columna user_id en dispositivos)
    const query = 'SELECT serie, modelo, tipo, marca, topic, estatus FROM dispositivos WHERE user_id = $1 ORDER BY serie';
    const result = await client.query(query, [req.userId]);

    // MOCK para asegurar que el frontend siempre tenga algo que mostrar
    // NOTA: En producción, ESTA LÍNEA DEBERÍA ELIMINARSE.
    if (result.rows.length === 0) {
      return res.json([
        { serie: 'WKM-MOCK1', modelo: 'Medidor pH/Temp', tipo: 'Medidor', marca: 'WaterKontrol', topic: 'disp/mock/tele', estatus: 'online' },
      ]);
    }

    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener dispositivos:', error.message);
    res.status(500).json({ message: 'Error al cargar dispositivos.' });
  } finally {
    if (client) client.release();
  }
});

// 2. Ruta de registro de un nuevo dispositivo (desde add_device_config.js)
app.post('/api/dispositivo/registro', checkAuth, async (req, res) => {
  const { serie, modelo, tipo, marca, topic } = req.body;
  let client;
  try {
    if (!serie || !modelo || !topic) {
      return res.status(400).json({ message: 'Faltan campos obligatorios.' });
    }

    client = await pool.connect();
    // Verificar si el dispositivo ya existe por serie
    const checkDisp = await client.query('SELECT dsp_id FROM dispositivos WHERE serie = $1', [serie]);
    if (checkDisp.rows.length > 0) {
      return res.status(409).json({ message: `El dispositivo con serie ${serie} ya está registrado.` });
    }

    // Insertar nuevo dispositivo
    const insertQuery = `
      INSERT INTO dispositivos (user_id, serie, modelo, tipo, marca, topic)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING dsp_id
    `;
    await client.query(insertQuery, [req.userId, serie, modelo, tipo, marca || 'N/A', topic]);

    res.status(201).json({ message: 'Dispositivo registrado con éxito.' });

  } catch (error) {
    console.error('Error en /api/dispositivo/registro:', error.message);
    res.status(500).json({ message: 'Error interno al registrar dispositivo.' });
  } finally {
    if (client) client.release();
  }
});


// ===================================================================================
// RUTA DE SALUD PARA RAILWAY (HEALTHCHECK) <--- ¡SOLUCIÓN CRÍTICA!
// ===================================================================================
// Railway verifica esta ruta para saber si la aplicación está viva.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP', service: 'waterkontrol_app', db: pool.totalCount > 0 ? 'connected' : 'connecting' });
});


// ===================================================================================
// SERVIDOR DE ARCHIVOS ESTÁTICOS (FRONTEND) <--- ¡SOLUCIÓN CRÍTICA!
// ===================================================================================
// CRÍTICO: Se cambia a servir el directorio actual (__dirname) porque tus archivos HTML/CSS
// están en la raíz del proyecto, no en una carpeta 'www'.
app.use(express.static(path.join(__dirname)));

// Middleware de redirección para la raíz: redirige '/' a '/login.html'
app.get('/', (req, res) => {
  // Si tiene sesión, redirigir a la app, sino, a login
  if (req.cookies.user_id) {
    return res.redirect('/app.html');
  }
  res.redirect('/login.html');
});


// Manejador de errores para rutas no encontradas (404)
// ** CRÍTICO: DEBE IR DESPUÉS DE TODAS LAS OTRAS RUTAS **
app.use((req, res, next) => {
  // Para peticiones de API que no sean encontradas, devolvemos JSON
  if (req.path.startsWith('/auth/') || req.path.startsWith('/api/')) {
    return res.status(404).json({ message: `Ruta de API no encontrada: ${req.path}` });
  }
  // Para rutas de frontend que no sean encontradas, devolvemos 404
  res.status(404).sendFile(path.join(__dirname, '404.html')) || res.send('Error 404: Página no encontrada');
});


// ===================================================================================
// LÓGICA DE INICIO DEL SERVIDOR
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
    console.log(`🌐 URL de la aplicación: ${process.env.APP_BASE_URL || `http://${host}:${PORT}`}`);
    initializeApplicationServices();
  });
};

startServer();