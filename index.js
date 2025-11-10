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
    // Suscribirse a un topic general para recibir telemetría de todos los dispositivos
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

// Inicializar la conexión MQTT (y reintentar si falla)
connectMqtt();


// ===================================================================================
// FUNCIONES DE AUTENTICACIÓN (Simuladas - Se asume que existen en el código real)
// ===================================================================================

const isAuth = (req, res, next) => {
    const token = req.cookies.session_token;
    if (!token) {
        return res.status(401).send({ message: 'No autorizado. Inicie sesión.', redirect: '/login.html' });
    }
    
    // Buscamos el token y el usuario en la DB para validar la sesión
    pool.query('SELECT usuario_id FROM sesiones WHERE token = $1 AND expira_en > NOW()', [token])
        .then(result => {
            if (result.rows.length === 0) {
                // Token inválido o expirado
                res.clearCookie('session_token');
                return res.status(401).send({ message: 'Sesión expirada. Por favor, vuelva a iniciar sesión.', redirect: '/login.html' });
            }
            // Anexar el ID del usuario al request para usarlo en otras rutas
            req.userId = result.rows[0].usuario_id; 
            next();
        })
        .catch(err => {
            console.error('Error al verificar sesión:', err);
            res.status(500).send({ message: 'Error interno del servidor.' });
        });
};

// ... [Aquí irían otras funciones de nodemailer, bcrypt, crypto, etc.]

// ===================================================================================
// RUTAS DE AUTENTICACIÓN (AUTH) (Simuladas - Se asume que existen en el código real)
// ===================================================================================

// POST /auth/register
app.post('/auth/register', async (req, res) => {
    // ... [Lógica de registro]
    res.status(501).json({ message: 'Ruta no implementada para el ejemplo.' });
});

// POST /auth/login
app.post('/auth/login', async (req, res) => {
    // ... [Lógica de login]
    res.status(501).json({ message: 'Ruta no implementada para el ejemplo.' });
});

// POST /auth/logout
app.post('/auth/logout', (req, res) => {
    // ... [Lógica de logout]
    res.clearCookie('session_token');
    res.status(200).json({ message: 'Sesión cerrada' });
});

// ... [Otras rutas /auth/verify, /auth/forgot, /auth/reset]


// ===================================================================================
// RUTAS DE LA API (Requieren autenticación)
// ===================================================================================

// GET /api/dispositivos (Listar dispositivos del usuario)
app.get('/api/dispositivos', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM dispositivos WHERE usuario_id = $1', [req.userId]);
        res.json(result.rows);
    } catch (err) {
        console.error('Error al obtener dispositivos:', err);
        res.status(500).json({ message: 'Error al obtener la lista de dispositivos.' });
    }
});

// POST /api/dispositivo/registro (Endpoint para el frontend de add_device_config.js)
app.post('/api/dispositivo/registro', isAuth, async (req, res) => {
    const { serie, modelo, tipo, marca, topic } = req.body;
    // VALIDACIÓN BÁSICA
    if (!serie || !modelo || !tipo || !topic) {
        return res.status(400).json({ message: 'Datos incompletos.' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN'); // Iniciar transacción

        // 1. Insertar en la tabla de dispositivos
        const insertQuery = `
            INSERT INTO dispositivos (serie, modelo, tipo, marca, topic, usuario_id, estatus, ultima_conexion)
            VALUES ($1, $2, $3, $4, $5, $6, 'offline', NOW())
            RETURNING dispositivo_id;
        `;
        const result = await client.query(insertQuery, [serie, modelo, tipo, marca, topic, req.userId]);
        const dispositivoId = result.rows[0].dispositivo_id;

        // 2. Suscribirse al topic de MQTT del nuevo dispositivo
        if (mqttClient) {
            mqttClient.subscribe(topic, (err) => {
                if (err) {
                    console.error(`❌ Error al suscribirse al topic del nuevo dispositivo (${topic}):`, err);
                } else {
                    console.log(`✅ Dispositivo ${serie} registrado y suscrito al topic: ${topic}`);
                }
            });
        }

        await client.query('COMMIT'); // Confirmar transacción
        res.status(201).json({ 
            message: 'Dispositivo registrado exitosamente en la plataforma.', 
            dispositivo_id: dispositivoId,
            topic: topic
        });

    } catch (error) {
        await client.query('ROLLBACK'); // Revertir en caso de error
        // Manejar duplicados (asumiendo que 'serie' tiene un UNIQUE constraint)
        if (error.code === '23505') { 
            return res.status(409).json({ message: `El dispositivo con serie ${serie} ya está registrado.` });
        }
        console.error('Error al registrar nuevo dispositivo:', error);
        res.status(500).json({ message: 'Error interno al registrar el dispositivo.' });
    } finally {
        if (client) {
            client.release();
        }
    }
});


// ===================================================================================
// PROCESAMIENTO DE MENSAJES MQTT
// ===================================================================================

const procesarMensajesMqtt = () => {
  // Asegurarse de que el cliente MQTT está conectado
  if (!mqttClient) {
    console.error('❌ Cliente MQTT no inicializado.');
    return;
  }

  // Lógica para cuando se recibe un mensaje
  mqttClient.on('message', async (topic, message) => {
    // El topic general es dispositivos/+/telemetria, extraemos la serie
    const parts = topic.split('/');
    if (parts.length !== 3 || parts[2] !== 'telemetria') return;
    const serie = parts[1]; // El número de serie del dispositivo

    let dbClient;
    try {
      const data = JSON.parse(message.toString());
      const { temp, ph, msg_id } = data; // Asumiendo que el dispositivo envía estos campos
      const timestamp = new Date();

      if (!serie || temp === undefined || ph === undefined || !msg_id) {
        console.warn(`⚠️ Mensaje inválido o incompleto del topic [${topic}].`);
        return;
      }

      dbClient = await pool.connect();
      await dbClient.query('BEGIN'); // Iniciar transacción

      // 1. Buscar el dispositivo por serie y obtener su ID
      const deviceResult = await dbClient.query('SELECT dispositivo_id FROM dispositivos WHERE serie = $1', [serie]);
      if (deviceResult.rows.length === 0) {
        console.warn(`⚠️ Dispositivo con serie ${serie} no encontrado en la DB.`);
        await dbClient.query('ROLLBACK');
        return;
      }
      const dispositivo_id = deviceResult.rows[0].dispositivo_id;

      // 2. Insertar la nueva telemetría
      const telemetryInsert = `
        INSERT INTO telemetria (dispositivo_id, temperatura, ph, marca_tiempo, msg_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (dispositivo_id, msg_id) DO NOTHING;
      `; // Usamos ON CONFLICT para evitar duplicados si el broker reenvía
      await dbClient.query(telemetryInsert, [dispositivo_id, temp, ph, timestamp, msg_id]);

      // 3. Actualizar el estado y los últimos valores del dispositivo
      const updateDevice = `
        UPDATE dispositivos
        SET 
          ultima_conexion = $1, 
          estatus = 'online',
          ultimos_valores = jsonb_build_object('temperatura', $2, 'ph', $3)
        WHERE dispositivo_id = $4;
      `;
      await dbClient.query(updateDevice, [timestamp, temp, ph, dispositivo_id]);

      await dbClient.query('COMMIT'); // Confirmar transacción
      // console.log(`✅ Telemetría de ${serie} procesada (MSG_ID: ${msg_id}).`);

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

  mqttClient.on('error', (error) => {
    console.error('❌ Error en la conexión MQTT:', error);
  });
};


// ===================================================================================
// RUTAS ADICIONALES Y SERVIDOR DE ARCHIVOS ESTÁTICOS (FRONTEND)
// ===================================================================================

// 🚨 SOLUCIÓN AL PROBLEMA DE HEALTHCHECK EN RAILWAY
// Responde con 200 OK a la ruta que Railway usa para verificar el estado.
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});


// Ruta raíz (redirige a login.html o app.html si hay sesión)
app.get('/', (req, res) => {
    // La app principal está en /app.html, pero si no hay sesión lo mandamos a login
    if (req.cookies.session_token) {
        res.sendFile(path.join(__dirname, 'www', 'app.html'));
    } else {
        res.sendFile(path.join(__dirname, 'www', 'login.html'));
    }
});

// Servir archivos estáticos
// CRÍTICO: Asegúrate que tu carpeta de frontend se llama 'www'
app.use(express.static(path.join(__dirname, 'www')));


// ===================================================================================
// INICIAR EL SERVIDOR EXPRESS
// ===================================================================================
const PORT = process.env.PORT || 8080;

const initializeApplicationServices = async () => {
  console.log('🔍 Iniciando verificación de base de datos y MQTT (en segundo plano)...');
  const dbConnected = await testDatabaseConnection();

  if (!dbConnected) {
    console.error('❌ No se pudo conectar a la base de datos. Las funciones de autenticación y DB fallarán.');
  } else {
    try {
      // Iniciar el procesamiento de mensajes MQTT SOLO si la DB está conectada para poder persistir datos
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

// Iniciar servicios en segundo plano y luego el servidor
initializeApplicationServices();
startServer();