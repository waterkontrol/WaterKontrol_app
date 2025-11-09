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
const jwt = require('jsonwebtoken'); // Importar JWT (necesario para la lógica original)
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
console.log(`📋 Entorno: ${isProduction ? 'Producción (SSL ON)' : 'Local (SSL OFF)'}`);

const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 20, // Aumentar por si acaso
};
const pool = new Pool(poolConfig);

const testDatabaseConnection = async () => {
    try {
        await pool.query('SELECT 1');
        console.log('✅ Conexión a la base de datos exitosa.');
        return true;
    } catch (error) {
        console.error('❌ Error de conexión a la base de datos:', error.message);
        return false;
    }
};

// ===================================================================================
// LÓGICA DE AUTENTICACIÓN
// ===================================================================================

const hashPassword = async (password) => {
    return bcrypt.hash(password, saltRounds);
};

const comparePassword = async (password, hash) => {
    return bcrypt.compare(password, hash);
};

const generateJwtToken = (userId) => {
    // El token expira en 7 días
    return jwt.sign({ id: userId }, process.env.JWT_SECRET || 'SECRETO_POR_DEFECTO', { expiresIn: '7d' });
};

// ===================================================================================
// MIDDLEWARE DE AUTENTICACIÓN (TEMPORALMENTE DESACTIVADO PARA PRUEBAS)
// ===================================================================================

const checkAuth = async (req, res, next) => {
    // *****************************************************************************
    // ** CAMBIO TEMPORAL: Omitir el Login y Forzar un Usuario de Prueba (ID: 1) **
    // *****************************************************************************
    console.log('⚠️ DEBUG: Middleware de autenticación OMITIDO. Usando Usuario ID: 1.');
    
    // Asignar un ID de usuario fijo (debe existir en la base de datos para cargar dispositivos reales).
    req.user = { id: 1 }; 
    return next();

    // -----------------------------------------------------------------------------
    // LÓGICA ORIGINAL COMENTADA (para referencia):
    /*
    const token = req.cookies.jwt;
    if (!token) {
        if (req.path.startsWith('/api')) {
            return res.status(401).json({ message: 'No autorizado. Sesión requerida.' });
        }
        return res.redirect('/login.html');
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'SECRETO_POR_DEFECTO');
        req.user = { id: decoded.id };
        next();
    } catch (err) {
        res.clearCookie('jwt');
        if (req.path.startsWith('/api')) {
            return res.status(401).json({ message: 'No autorizado. Token inválido.' });
        }
        return res.redirect('/login.html');
    }
    */
};


// ===================================================================================
// LÓGICA DE MQTT
// ===================================================================================
const procesarMensajesMqtt = () => {
  // Configuración y lógica de MQTT
  const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL);
  
  mqttClient.on('connect', () => {
    console.log('✅ Conexión MQTT exitosa.');
    // Suscribirse a un topic genérico para escuchar mensajes
    mqttClient.subscribe('dispositivos/+/telemetria', (err) => {
      if (!err) {
        console.log("✅ Suscrito al topic 'dispositivos/+/telemetria'");
      }
    });
  });

  mqttClient.on('message', async (topic, message) => {
    let dbClient;
    try {
      const msg = JSON.parse(message.toString());
      const serie = topic.split('/')[1]; // dispositivos/SERIE/telemetria
      
      dbClient = await pool.connect();
      await dbClient.query('BEGIN');

      // Actualizar el estado del dispositivo
      await dbClient.query(
        `UPDATE dispositivo 
         SET last_ping = NOW(),
             ultimos_valores = $1
         WHERE dsp_id = $2`, 
        [msg, serie]
      );
      
      // Lógica de registro en historial (asumiendo que existe una tabla)
      // Ejemplo: INSERT INTO historial_telemetria (dsp_id, datos) VALUES ($1, $2)

      await dbClient.query('COMMIT');
      // console.log(`✅ Telemetría de ${serie} procesada.`);

    } catch (error) {
      if (dbClient) {
        await dbClient.query('ROLLBACK');
      }
      // El error de JSON.parse o DB es común, se registra para depuración
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
// RUTAS DE AUTENTICACIÓN (Se mantienen con su lógica original para no romperlas)
// ===================================================================================

// Ruta para registro de usuario
app.post('/auth/register', async (req, res) => {
  const { nombre, correo, clave } = req.body;
  
  // Lógica de registro de usuario
  try {
    const hashedPassword = await hashPassword(clave);
    const client = await pool.connect();
    // Insertar usuario (simplificado)
    const result = await client.query(
        'INSERT INTO usuario (usr_nombre, usr_correo, usr_clave_hash, usr_verificado, usr_rol) VALUES ($1, $2, $3, TRUE, $4) RETURNING usr_id',
        [nombre, correo.toLowerCase(), hashedPassword, 'usuario']
    );
    client.release();

    if (result.rows[0]) {
      // Devolver un mensaje de éxito para el frontend de registro
      return res.status(200).json({ 
        message: 'Registro exitoso. ¡Inicia sesión!',
        redirect: '/login.html'
      });
    }

    res.status(500).json({ message: 'Error al registrar el usuario.' });
  } catch (error) {
    console.error('Error en /auth/register:', error);
    if (error.code === '23505') { // Código de error de duplicado en PostgreSQL
        return res.status(409).json({ message: 'El correo ya está registrado.' });
    }
    res.status(500).json({ message: 'Error interno del servidor.' });
  }
});

// Ruta para login de usuario
app.post('/auth/login', async (req, res) => {
    const { correo, clave } = req.body;
    let client;
    try {
        client = await pool.connect();
        const result = await client.query('SELECT usr_id, usr_clave_hash, usr_verificado FROM usuario WHERE usr_correo = $1', [correo.toLowerCase()]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }

        const user = result.rows[0];
        const isPasswordValid = await comparePassword(clave, user.usr_clave_hash);

        if (!isPasswordValid) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }

        if (!user.usr_verificado) {
            return res.status(403).json({ message: 'Cuenta no verificada. Revisa tu correo.' });
        }

        // Generar token JWT y establecer cookie
        const token = generateJwtToken(user.usr_id);
        res.cookie('jwt', token, { 
            httpOnly: true, 
            secure: isProduction, 
            sameSite: isProduction ? 'strict' : 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 días
        });

        res.status(200).json({ 
            message: 'Inicio de sesión exitoso.',
            redirect: '/app.html'
        });

    } catch (error) {
        console.error('Error en /auth/login:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    } finally {
        if (client) client.release();
    }
});

// Ruta para cerrar sesión
app.post('/auth/logout', (req, res) => {
    res.clearCookie('jwt');
    res.status(200).json({ message: 'Sesión cerrada.' });
});

// Ruta de recuperación de contraseña (simulada)
app.post('/auth/forgot', async (req, res) => {
  // Lógica de forgot password (asumiendo que existe)
  res.status(200).json({ message: 'Si el correo está registrado, recibirás un enlace de recuperación.' });
});


// ===================================================================================
// RUTAS DE LA API (Requieren Autenticación)
// ===================================================================================

// La ruta de dispositivos ahora usa el middleware checkAuth modificado para omitir la verificación
app.get('/api/dispositivos', checkAuth, async (req, res) => {
    const userId = req.user.id; // Este ID es el hardcodeado temporalmente (ID=1)
    let client;
    try {
        client = await pool.connect();

        // Consulta de dispositivos
        const result = await client.query(
            `SELECT 
                d.dsp_id AS serie, 
                d.modelo, 
                d.tipo, 
                d.marca, 
                d.topic, 
                CASE WHEN d.last_ping > NOW() - INTERVAL '5 minutes' THEN 'online' ELSE 'offline' END AS estatus,
                d.ultimos_valores
             FROM dispositivo d
             WHERE d.usr_id = $1
             ORDER BY d.dsp_id`, 
             [userId]
        );
        
        // Mock si no hay resultados (para mostrar algo en el frontend)
        if (result.rows.length === 0) {
            const mockDevices = [
                {
                    serie: 'WKM-0001',
                    modelo: 'Medidor pH/Temp',
                    tipo: 'Medidor',
                    marca: 'WaterKontrol',
                    topic: 'dispositivos/WKM-0001/telemetria',
                    estatus: 'online',
                    ultimos_valores: { temperatura: 25.5, ph: 7.2 }
                }
            ];
            return res.json(mockDevices);
        }

        res.json(result.rows);
    } catch (error) {
        console.error('❌ Error al obtener dispositivos:', error);
        // Fallback a mock si la DB falla
        const mockDevices = [
            {
                serie: 'MOCK-001-DB-ERROR',
                modelo: 'Medidor pH (Mock)',
                tipo: 'Medidor',
                marca: 'WaterKontrol',
                topic: 'dispositivos/mock/telemetria',
                estatus: 'offline',
                ultimos_valores: { error: 'DB connection error' }
            }
        ];
        res.status(200).json(mockDevices); // Usar 200 para que el frontend no falle
    } finally {
        if (client) client.release();
    }
});

// ===================================================================================
// SERVIDOR DE ARCHIVOS ESTÁTICOS Y RUTAS PRINCIPALES
// ===================================================================================

// ** CAMBIO TEMPORAL: Redirigir a la aplicación principal para omitir el Login **
// Ruta raíz
app.get('/', (req, res) => {
    console.log('⚠️ DEBUG: Ruta raíz / redirigida a app.html para saltar login.');
    res.sendFile(path.join(__dirname, 'www', 'app.html'));
});

// Servir archivos estáticos
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
        console.log(`🌐 Accede a la aplicación en http://${host}:${PORT}/`);
    });
};

initializeApplicationServices().then(startServer);