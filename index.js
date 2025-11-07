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
const jwt = require('jsonwebtoken'); // ¡NUEVO!
const saltRounds = 10;

// CRÍTICO: Obtener las variables de seguridad
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'clave_secreta_por_defecto'; 
const JWT_SECRET = process.env.JWT_SECRET || 'clave_secreta_jwt_defecto'; 

// --- CONFIGURACIÓN DE EXPRESS ---
const app = express();

// MIDDLEWARE PRINCIPAL
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// 💡 CORRECCIÓN: Usar la clave secreta para firmar cookies
app.use(cookieParser(COOKIE_SECRET)); 

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

async function testDatabaseConnection() {
    // ... (Tu función existente) ...
    try {
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        console.log('✅ Conexión a la base de datos exitosa.');
        return true;
    } catch (error) {
        console.error('❌ Error de conexión a la base de datos:', error.message);
        return false;
    }
}

// ===================================================================================
// MIDDLEWARE DE AUTENTICACIÓN (CRÍTICO)
// ===================================================================================

/**
 * Middleware para verificar la sesión del usuario a través del token JWT en la cookie.
 */
const checkAuth = (req, res, next) => {
    // 💡 Usa la cookie firmada. Si no existe, intenta con la normal.
    const token = req.cookies.user_session || req.signedCookies.user_session; 
    
    if (!token) {
        // Para peticiones AJAX (como cargar dispositivos), devolver 401. Para navegacion, redirigir.
        if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
            return res.status(401).json({ message: 'No autorizado. Por favor, inicie sesión.' });
        }
        // CRÍTICO: Si no hay sesión y está en /app.html o /add_device.html, redirigir al login
        if (req.path === '/app.html' || req.path === '/add_device.html') {
             return res.redirect('/login.html');
        }
        // Permitir otras rutas estáticas
        return next();
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; // Ahora req.user.usr_id contiene el ID del usuario, que se usa en las APIs
        next();
    } catch (error) {
        res.clearCookie('user_session'); // Limpiar cookies inválidas
        if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
            return res.status(401).json({ message: 'Sesión expirada o inválida. Inicie sesión de nuevo.' });
        }
        return res.redirect('/login.html');
    }
};

app.use(checkAuth); // Aplicar checkAuth a todas las rutas por defecto, y manejar las excepciones.

// ===================================================================================
// RUTAS DE AUTENTICACIÓN (login, register, forgot, logout)
// ===================================================================================

app.post('/auth/register', async (req, res) => {
    // ... (Tu lógica de registro existente) ...
    const { nombre, correo, clave } = req.body;
    if (!nombre || !correo || !clave) {
        return res.status(400).json({ message: 'Faltan campos obligatorios.' });
    }
    
    let client;
    try {
        client = await pool.connect();
        const existingUser = await client.query('SELECT 1 FROM usuarios WHERE correo = $1', [correo]);
        if (existingUser.rowCount > 0) {
            return res.status(409).json({ message: 'El correo ya está registrado.' });
        }
        
        const claveHash = await bcrypt.hash(clave, saltRounds);
        await client.query('INSERT INTO usuarios (nombre, correo, clave_hash) VALUES ($1, $2, $3)', [nombre, correo, claveHash]);
        
        res.status(201).json({ message: '✅ Registro exitoso. Ahora puedes iniciar sesión.' });
        
    } catch (error) {
        console.error('Error al registrar usuario:', error);
        res.status(500).json({ message: 'Error interno del servidor al registrar.' });
    } finally {
        if (client) client.release();
    }
});

app.post('/auth/login', async (req, res) => {
    const { correo, clave } = req.body;
    let client;
    try {
        client = await pool.connect();
        const result = await client.query('SELECT usr_id, clave_hash FROM usuarios WHERE correo = $1', [correo]);

        if (result.rowCount === 0) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }

        const user = result.rows[0];
        const match = await bcrypt.compare(clave, user.clave_hash);

        if (!match) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }

        // 💡 CRÍTICO: Generar Token de Sesión JWT
        const token = jwt.sign({ usr_id: user.usr_id, correo: correo }, JWT_SECRET, { expiresIn: '1d' });

        // 💡 CRÍTICO: Establecer la cookie de sesión (httpOnly para seguridad)
        res.cookie('user_session', token, { 
            httpOnly: true, 
            secure: isProduction, // Usar secure:true en producción con HTTPS
            sameSite: 'Lax',
            signed: true, // Usar la clave COOKIE_SECRET
            maxAge: 24 * 60 * 60 * 1000 // 1 día
        });

        res.json({ message: 'Inicio de sesión exitoso.', redirect: '/app.html' });

    } catch (error) {
        console.error('Error al iniciar sesión:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    } finally {
        if (client) client.release();
    }
});

app.post('/auth/logout', (req, res) => {
    // 💡 CRÍTICO: Borrar la cookie de sesión
    res.clearCookie('user_session', { signed: true }); 
    res.json({ message: 'Cierre de sesión exitoso.', redirect: '/' });
});

app.post('/auth/forgot', async (req, res) => {
    // ... (Tu lógica de forgot password existente) ...
    // Nota: Esta lógica requiere crear la tabla `password_resets` y la función de email.
    res.status(501).json({ message: 'Recuperación de contraseña no implementada en este demo.' });
});

// ===================================================================================
// RUTAS DE LA API (Requieren Autenticación)
// ===================================================================================

/**
 * RUTA CRÍTICA: Implementación para registrar el dispositivo.
 */
app.post('/api/dispositivo/registro', async (req, res) => {
    const { serie, modelo, tipo, marca, topic } = req.body;
    // req.user viene del middleware checkAuth, que decodificó el JWT
    const usr_id = req.user.usr_id; 
    
    if (!serie || !modelo || !tipo || !marca || !topic) {
        return res.status(400).json({ message: 'Faltan campos obligatorios en el registro del dispositivo.' });
    }

    let client;
    try {
        client = await pool.connect();
        
        // 1. Verificar si la serie ya existe
        const existingDevice = await client.query('SELECT 1 FROM dispositivos WHERE serie = $1', [serie]);
        if (existingDevice.rowCount > 0) {
            return res.status(409).json({ message: 'El número de serie ya está registrado en la plataforma.' });
        }
        
        // 2. Insertar el nuevo dispositivo
        const insertQuery = 'INSERT INTO dispositivos (usr_id, serie, modelo, tipo, marca, topic) VALUES ($1, $2, $3, $4, $5, $6) RETURNING dsp_id;';
        const result = await client.query(insertQuery, [usr_id, serie, modelo, tipo, marca, topic]);
        const dsp_id = result.rows[0].dsp_id;

        res.status(201).json({ message: 'Dispositivo registrado con éxito.', dsp_id: dsp_id, serie: serie });

    } catch (error) {
        console.error('Error al registrar dispositivo:', error);
        res.status(500).json({ message: 'Error interno del servidor al registrar el dispositivo.' });
    } finally {
        if (client) client.release();
    }
});


/**
 * RUTA: Obtener lista de dispositivos del usuario
 */
app.get('/api/dispositivos', async (req, res) => {
    // req.user viene del middleware checkAuth
    const usr_id = req.user.usr_id; 
    
    let client;
    try {
        client = await pool.connect();
        // 💡 CORRECCIÓN: Consultar la DB para obtener los dispositivos del usuario:
        const devicesResult = await client.query('SELECT dsp_id, serie, modelo, tipo, marca, topic FROM dispositivos WHERE usr_id = $1', [usr_id]);
        
        // Simular estatus (el estatus real vendría de una caché/servidor MQTT)
        const devicesWithStatus = devicesResult.rows.map(d => ({
            ...d,
            estatus: Math.random() < 0.8 ? 'online' : 'offline', 
        }));

        res.json(devicesWithStatus);

    } catch (error) {
        console.error('Error al obtener dispositivos:', error);
        // Si no se encuentra el usuario (aunque checkAuth debería evitar esto), se devuelve 404
        res.status(500).json({ message: 'Error interno al cargar la lista de dispositivos.' });
    } finally {
        if (client) client.release();
    }
});

// ... (Tu función procesarMensajesMqtt y testDatabaseConnection) ...

// ===================================================================================
// SERVIDOR DE ARCHIVOS ESTÁTICOS (FRONTEND)
// ===================================================================================
// 💡 CRÍTICO: Esta debe ser la ÚLTIMA ruta, excepto el redirect del index
app.use(express.static(path.join(__dirname, 'www')));

// Redirigir la raíz al login
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'www', 'login.html'));
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
      // procesarMensajesMqtt(); // Dejar comentado si da problemas, para centrarse en Auth/API
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