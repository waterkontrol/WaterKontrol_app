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
  max: 20, // max number of clients in the pool
};

const pool = new Pool(poolConfig);

const testDatabaseConnection = async () => {
    try {
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        console.log('✅ Conexión a la base de datos establecida con éxito.');
        return true;
    } catch (error) {
        console.error('❌ Error al conectar a la base de datos:', error.message);
        return false;
    }
};

// ===================================================================================
// LÓGICA DE SESIÓN/AUTENTICACIÓN (MOCK: DESACTIVADA)
// ===================================================================================

// Función de Simulación de Sesión (Reemplaza a verifySession)
// CRÍTICO: Esta función simula que el usuario siempre está logueado como usr_id: 1.
const mockSession = (req, res, next) => {
    req.user = { id: 1 }; // Mockear un usuario con ID 1
    next();
};

// Middleware para verificar sesión (COMENTADA)
// const verifySession = async (req, res, next) => {
//     const token = req.cookies.session_token;
//     if (!token) {
//         return res.status(401).send(JSON.stringify({ message: 'No autorizado. Inicie sesión.' }));
//     }
//     // ... Lógica para verificar el token en la DB ...
//     try {
//         const result = await pool.query('SELECT usr_id FROM tokens WHERE token = $1 AND expiracion > NOW()', [token]);
//         if (result.rows.length > 0) {
//             req.user = { id: result.rows[0].usr_id };
//             next();
//         } else {
//             res.clearCookie('session_token');
//             res.status(401).send(JSON.stringify({ message: 'Sesión expirada. Inicie sesión.' }));
//         }
//     } catch (error) {
//         console.error('Error al verificar sesión:', error);
//         res.status(500).send(JSON.stringify({ message: 'Error interno del servidor.' }));
//     }
// };


// --- RUTAS DE AUTENTICACIÓN (COMENTADAS) ---

// // Ruta de Login (COMENTADA)
// app.post('/auth/login', async (req, res) => {
//     // ... Lógica completa de login aquí ...
// });

// // Ruta de Registro
app.post('/auth/register', async (req, res) => {
    const { nombre, correo, clave } = req.body;
    if (!nombre || !correo || !clave) {
        return res.status(400).json({ message: 'Todos los campos son obligatorios.' });
    }

    try {
        // 1. Verificar si el correo ya existe
        const checkUser = await pool.query('SELECT usr_id FROM usuarios WHERE correo = $1', [correo]);
        if (checkUser.rows.length > 0) {
            return res.status(409).json({ message: 'El correo ya está registrado.' });
        }

        // 2. Hashear la contraseña
        const hash = await bcrypt.hash(clave, saltRounds);

        // 3. Insertar nuevo usuario
        await pool.query('INSERT INTO usuarios (nombre, correo, clave_hash) VALUES ($1, $2, $3)', [nombre, correo, hash]);

        // Éxito
        res.status(201).json({ message: '✅ Registro exitoso. Ahora puedes iniciar sesión.' });
    } catch (error) {
        console.error('Error en el registro:', error);
        res.status(500).json({ message: 'Error interno del servidor durante el registro.' });
    }
});


// // Ruta para Cerrar Sesión (COMENTADA)
app.post('/auth/logout', (req, res) => {
    // res.clearCookie('session_token');
    // res.status(200).json({ message: 'Sesión cerrada.' });
    res.status(200).json({ message: 'Logout mockeado.' });
});

// // Ruta de Recuperación de Contraseña
// app.post('/auth/forgot', async (req, res) => {
//     // ... Lógica completa de recuperación aquí ...
// });

// ===================================================================================
// LÓGICA DE INTEGRACIÓN MQTT
// ===================================================================================
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://broker.emqx.io/';

const procesarMensajesMqtt = () => {
  const client = mqtt.connect(MQTT_BROKER_URL);
  
  client.on('connect', () => {
    console.log(`✅ Conexión MQTT establecida con el broker: ${MQTT_BROKER_URL}`);
    // Suscribirse a todos los tópicos de telemetría de dispositivos (ejemplo)
    client.subscribe('dispositivos/+/telemetria', (err) => {
      if (err) {
        console.error('❌ Error al suscribirse a tópicos MQTT:', err);
      } else {
        console.log('✅ Suscrito al tópico de telemetría general.');
      }
    });
  });

  client.on('message', async (topic, message) => {
    // console.log(`[MQTT] Mensaje recibido en topic [${topic}]`); 
    let dbClient;
    try {
      const payload = JSON.parse(message.toString());
      // console.log('Payload:', payload);

      // Lógica de validación del mensaje
      if (!payload.dsp_id || typeof payload.temperatura === 'undefined' || typeof payload.ph === 'undefined') {
        throw new Error('Payload MQTT incompleto o malformado.');
      }

      const { dsp_id, temperatura, ph } = payload;
      const msg_id = crypto.randomBytes(4).toString('hex'); // ID único para el log

      dbClient = await pool.connect();
      await dbClient.query('BEGIN'); // Iniciar transacción

      // 1. Guardar el registro de telemetría
      await dbClient.query(
        'INSERT INTO telemetria (dsp_id, temperatura, ph) VALUES ($1, $2, $3)',
        [dsp_id, temperatura, ph]
      );

      // 2. Actualizar el último estado del dispositivo
      await dbClient.query(
        'UPDATE dispositivos SET ultimos_valores = jsonb_set(ultimos_valores, \'{temperatura}\', $2::jsonb, true), ultimos_valores = jsonb_set(ultimos_valores, \'{ph}\', $3::jsonb, true), estatus = \'online\' WHERE dsp_id = $1',
        [dsp_id, JSON.stringify(temperatura), JSON.stringify(ph)]
      );

      await dbClient.query('COMMIT'); // Confirmar transacción
      // console.log(`✅ Mensaje del topic [${topic}] procesado y guardado con éxito (MSG_ID: ${msg_id}).`);

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
// RUTAS DE LA APLICACIÓN (REQUIEREN MOCK O SESIÓN)
// ===================================================================================

// CRÍTICO: Aplicar el mockSession a las rutas protegidas.
app.get('/api/dispositivos', mockSession, async (req, res) => {
  const usr_id = req.user.id; // Se obtiene del mockSession
  
  // MOCK DE DISPOSITIVOS PARA PRUEBA
  const mockDevices = [
    { 
      dsp_id: 'WKM-0001', 
      modelo: 'Medidor pH/Temp', 
      tipo: 'Medidor', 
      marca: 'WaterKontrol', 
      topic: 'dispositivos/WKM-0001/telemetria',
      estatus: 'online',
      ultimos_valores: { temperatura: 25, ph: 7.2 }
    },
    { 
      dsp_id: 'WKM-0002', 
      modelo: 'Controlador Bomba', 
      tipo: 'Actuador', 
      marca: 'WaterKontrol', 
      topic: 'dispositivos/WKM-0002/telemetria',
      estatus: 'offline',
      ultimos_valores: { temperatura: null, ph: null }
    }
  ];
  res.json(mockDevices);
});

// Ruta para el registro en la API después de la configuración local (mockSession para seguridad)
app.post('/api/dispositivo/registro', mockSession, async (req, res) => {
    const usr_id = req.user.id;
    const { serie, modelo, tipo, marca, topic } = req.body;

    if (!serie || !topic) {
        return res.status(400).json({ message: 'Serie y tópico MQTT son obligatorios.' });
    }

    try {
        // 1. Verificar si el dispositivo ya existe (para evitar duplicados)
        const check = await pool.query('SELECT dsp_id FROM dispositivos WHERE serie = $1', [serie]);
        if (check.rows.length > 0) {
            return res.status(409).json({ message: `El dispositivo con serie ${serie} ya está registrado.` });
        }

        // 2. Insertar el nuevo dispositivo
        const result = await pool.query(
            'INSERT INTO dispositivos (usr_id, serie, modelo, tipo, marca, topic, estatus, ultimos_valores) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING dsp_id',
            [usr_id, serie, modelo || 'N/A', tipo || 'N/A', marca || 'N/A', topic, 'offline', JSON.stringify({})]
        );
        
        // 3. Suscribir el dispositivo al tópico de telemetría (se hace en la función procesarMensajesMqtt al iniciar el servidor)
        
        res.status(201).json({ message: '✅ Dispositivo registrado en la plataforma.', dsp_id: result.rows[0].dsp_id });

    } catch (error) {
        console.error('Error al registrar dispositivo:', error);
        res.status(500).json({ message: 'Error interno al registrar el dispositivo.' });
    }
});


// ===================================================================================
// SERVIDOR DE ARCHIVOS ESTÁTICOS (FRONTEND)
// ===================================================================================
// Sirve los archivos de la carpeta 'www' (donde se copia 'public')
app.use(express.static(path.join(__dirname, 'www')));

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
  });
};

initializeApplicationServices();
startServer();