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
// HEALTH CHECK PARA RAILWAY (AÑADIDO)
// ===================================================================================
app.get('/health', (req, res) => {
    // Respuesta simple y rápida para el Health Check de Railway
    res.status(200).send('OK');
});

// ===================================================================================
// LÓGICA DE CONEXIÓN A LA BASE DE DATOS Y BCRYPT
// ===================================================================================
console.log('🔧 Intentando conectar a la base de datos...');
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
console.log('📋 DATABASE_URL:', process.env.DATABASE_URL ? '✅ Definida' : '❌ NO DEFINIDA');
console.log(`📋 Entorno: ${isProduction ? 'Producción (SSL ON)' : 'Local (SSL OFF)'}`);

const poolConfig = {
  connectionString: process.env.DATABASE_URL, 
  // CRÍTICO: Configuración SSL para Railway
  ssl: isProduction ? { rejectUnauthorized: false } : false, 
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
};

const pool = new Pool(poolConfig);

const testDatabaseConnection = async () => {
    try {
        const client = await pool.connect();
        console.log('✅ Conexión a la base de datos exitosa.');
        client.release();
        return true;
    } catch (error) {
        console.error('❌ Error al conectar a la base de datos:', error.message);
        return false;
    }
};

// ===================================================================================
// LÓGICA DE AUTENTICACIÓN (Rutas)
// ===================================================================================

// Middleware para verificar la sesión
const authenticateToken = (req, res, next) => {
    const token = req.cookies.auth_token;

    if (!token) {
        // Para peticiones AJAX, devolver 401. Para peticiones de navegación, redirigir.
        if (req.originalUrl.startsWith('/api/')) {
            return res.status(401).json({ message: 'No autorizado. Inicie sesión.' });
        }
        return res.redirect('/login.html');
    }

    try {
        const decoded = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        req.user = decoded; // Adjuntar datos de usuario al request
        next();
    } catch (err) {
        // Token no válido (posiblemente corrupto o modificado)
        res.clearCookie('auth_token');
        if (req.originalUrl.startsWith('/api/')) {
            return res.status(401).json({ message: 'Token no válido. Inicie sesión nuevamente.' });
        }
        return res.redirect('/login.html');
    }
};

// Rutas de autenticación
app.post('/auth/register', async (req, res) => {
    const { nombre, correo, clave } = req.body;
    
    if (!nombre || !correo || !clave) {
        return res.status(400).json({ message: 'Faltan campos requeridos.' });
    }

    let client;
    try {
        client = await pool.connect();
        
        // 1. Verificar si el usuario ya existe
        const checkUser = await client.query('SELECT user_id FROM usuarios WHERE correo = $1', [correo]);
        if (checkUser.rows.length > 0) {
            return res.status(409).json({ message: 'El correo ya está registrado.' });
        }

        // 2. Hashear la contraseña
        const hashedClave = await bcrypt.hash(clave, saltRounds);

        // 3. Insertar el nuevo usuario
        await client.query(
            'INSERT INTO usuarios (nombre, correo, clave_hash) VALUES ($1, $2, $3)',
            [nombre, correo, hashedClave]
        );

        res.status(201).json({ message: '✅ Registro exitoso. Ahora puede iniciar sesión.' });

    } catch (error) {
        console.error('Error al registrar usuario:', error);
        res.status(500).json({ message: 'Error interno del servidor al registrar.' });
    } finally {
        if (client) client.release();
    }
});

app.post('/auth/login', async (req, res) => {
    const { correo, clave } = req.body;

    if (!correo || !clave) {
        return res.status(400).json({ message: 'Faltan campos requeridos.' });
    }

    let client;
    try {
        client = await pool.connect();

        // 1. Buscar usuario
        const result = await client.query(
            'SELECT user_id, nombre, clave_hash FROM usuarios WHERE correo = $1',
            [correo]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }

        const user = result.rows[0];

        // 2. Comparar contraseña
        const match = await bcrypt.compare(clave, user.clave_hash);

        if (!match) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }
        
        // 3. Generar token simple (simulando JWT para la cookie)
        // CRÍTICO: Esto es un "token" base64 simple, no JWT real para evitar librerías pesadas.
        const payload = { user_id: user.user_id, nombre: user.nombre, correo: correo };
        const token = `header.${Buffer.from(JSON.stringify(payload)).toString('base64')}.signature`; 

        // 4. Establecer la cookie de sesión
        res.cookie('auth_token', token, { 
            httpOnly: true, // No accesible por JavaScript del lado del cliente
            secure: isProduction, // CRÍTICO: Solo enviar con HTTPS en producción (Railway)
            sameSite: 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 días
        });

        res.status(200).json({ message: '✅ Login exitoso.', redirect: '/app.html' });

    } catch (error) {
        console.error('Error al iniciar sesión:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    } finally {
        if (client) client.release();
    }
});

app.post('/auth/logout', (req, res) => {
    res.clearCookie('auth_token');
    res.status(200).json({ message: 'Sesión cerrada.' });
});

// Rutas de API para datos de la app
// Todas las rutas /api/* requieren autenticación
app.use('/api', authenticateToken);

app.get('/api/dispositivos', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        
        // Consulta real para obtener dispositivos del usuario
        const result = await client.query(
            'SELECT dsp_id, serie, modelo, tipo, marca, topic, estatus FROM dispositivos WHERE user_id = $1 ORDER BY dsp_id DESC',
            [req.user.user_id]
        );
        
        // Lógica de mock de estatus si no hay datos de MQTT.
        const devicesWithStatus = result.rows.map(d => ({
            ...d,
            estatus: 'offline' // Estatus por defecto (debería venir de una tabla de estatus en un proyecto real)
        }));

        res.json(devicesWithStatus);
    } catch (error) {
        console.error('Error al obtener dispositivos:', error);
        res.status(500).json({ message: 'Error al cargar dispositivos.' });
    } finally {
        if (client) client.release();
    }
});

app.post('/api/dispositivo/registro', authenticateToken, async (req, res) => {
    const { serie, modelo, tipo, marca, topic } = req.body;
    const user_id = req.user.user_id;

    if (!serie || !modelo || !tipo || !topic) {
        return res.status(400).json({ message: 'Faltan campos requeridos para el registro.' });
    }
    
    let client;
    try {
        client = await pool.connect();
        
        // Verificar si el dispositivo ya fue registrado por este o cualquier otro usuario
        const checkDevice = await client.query('SELECT dsp_id FROM dispositivos WHERE serie = $1', [serie]);
        if (checkDevice.rows.length > 0) {
            return res.status(409).json({ message: `El dispositivo con serie ${serie} ya está registrado.` });
        }

        // Insertar el nuevo dispositivo
        await client.query(
            `INSERT INTO dispositivos (user_id, serie, modelo, tipo, marca, topic, estatus) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [user_id, serie, modelo, tipo, marca, topic, 'offline']
        );

        res.status(201).json({ message: '✅ Dispositivo registrado exitosamente.' });

    } catch (error) {
        console.error('Error al registrar dispositivo:', error);
        res.status(500).json({ message: 'Error interno del servidor al registrar dispositivo.' });
    } finally {
        if (client) client.release();
    }
});


// ===================================================================================
// LÓGICA DE CONEXIÓN Y PROCESAMIENTO MQTT
// ===================================================================================

const procesarMensajesMqtt = () => {
  const brokerUrl = process.env.MQTT_BROKER_URL;
  if (!brokerUrl) {
      console.error('❌ MQTT_BROKER_URL no está definido. No se iniciará el cliente MQTT.');
      return;
  }
  
  // Conexión al broker MQTT
  const client = mqtt.connect(brokerUrl);
  
  client.on('connect', () => {
    console.log(`✅ Conectado al broker MQTT en: ${brokerUrl}`);
    // Suscribirse a un topic genérico o a todos los topics de dispositivos
    client.subscribe('dispositivos/#', (err) => {
        if (err) {
            console.error('❌ Error al suscribirse al topic:', err);
        } else {
            console.log('✅ Suscrito al topic: dispositivos/#');
        }
    });
  });

  client.on('message', async (topic, message) => {
    // Ejemplo de un topic: dispositivos/WKM-0001/telemetria
    const topicParts = topic.split('/'); 
    const serie = topicParts[1]; // WKM-0001

    if (topicParts[2] !== 'telemetria') {
        console.log(`⚠️ Mensaje recibido en topic no manejado: ${topic}`);
        return;
    }
    
    const msgPayload = message.toString();
    console.log(`📡 Mensaje recibido [${topic}]: ${msgPayload}`);
    
    let dbClient;
    try {
      dbClient = await pool.connect();
      await dbClient.query('BEGIN');

      const data = JSON.parse(msgPayload);
      const msg_id = crypto.randomBytes(16).toString('hex'); // ID único para el mensaje
      const received_at = new Date();

      // 1. Obtener dsp_id del dispositivo
      const deviceResult = await dbClient.query('SELECT dsp_id FROM dispositivos WHERE serie = $1', [serie]);

      if (deviceResult.rows.length === 0) {
        console.warn(`⚠️ Dispositivo con serie ${serie} no encontrado en la DB. Ignorando mensaje.`);
        await dbClient.query('ROLLBACK');
        return;
      }

      const dsp_id = deviceResult.rows[0].dsp_id;

      // 2. Insertar telemetría
      await dbClient.query(
        `INSERT INTO telemetria (dsp_id, msg_id, payload, received_at)
         VALUES ($1, $2, $3, $4)`,
        [dsp_id, msg_id, msgPayload, received_at]
      );
      
      // 3. Actualizar estatus del dispositivo a 'online'
      await dbClient.query(
        `UPDATE dispositivos SET estatus = 'online', ultima_conexion = $1 WHERE dsp_id = $2`,
        [received_at, dsp_id]
      );

      await dbClient.query('COMMIT');
      console.log(`✅ Telemetría guardada para ${serie} (MSG_ID: ${msg_id}).`);

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
// INICIAR EL SERVIDOR EXPRESS
// ===================================================================================
const PORT = process.env.PORT || 8080; 

const startServer = () => {
    console.log('🚀 Iniciando servidor Express...');
    
    // CRÍTICO: Asegurarse de escuchar en 0.0.0.0 si es Railway
    const host = isProduction ? '0.0.0.0' : 'localhost';

    app.listen(PORT, host, () => {
        console.log(`✅ Servidor Express ejecutándose en ${host}:${PORT}`);
        initializeApplicationServices(); // Iniciar servicios asíncronos después de que el servidor esté escuchando
    });
};

const initializeApplicationServices = async () => {
    console.log('🔍 Iniciando verificación de base de datos y MQTT (en segundo plano)...');
    const dbConnected = await testDatabaseConnection(); 
    
    if (!dbConnected) {
        console.error('❌ No se pudo conectar a la base de datos. Las funciones de autenticación y DB fallarán.');
        // No salimos con exit(1) para que el frontend pueda cargar.
    } else {
        try {
            procesarMensajesMqtt();
        } catch (error) {
            console.error('❌ Error iniciando MQTT:', error);
        }
    }
};


// ===================================================================================
// SERVIDOR DE ARCHIVOS ESTÁTICOS (FRONTEND)
// ===================================================================================
// CRÍTICO: Servir el contenido de la carpeta 'www'
app.use(express.static(path.join(__dirname, 'www')));


startServer(); // Iniciar la aplicación