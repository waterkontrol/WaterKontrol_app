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
console.log(`📋 Entorno: ${isProduction ? 'Producción (Railway)' : 'Desarrollo (Local)'}`);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false // CRÍTICO para Railway
});

// Función para verificar la conexión a la base de datos
async function testDatabaseConnection() {
    let client;
    try {
        client = await pool.connect();
        console.log('✅ Conexión a PostgreSQL exitosa.');
        return true;
    } catch (err) {
        console.error('❌ Error al conectar a PostgreSQL:', err.message);
        return false;
    } finally {
        if (client) {
            client.release();
        }
    }
}

// Middleware para verificar la sesión del usuario (cookie 'auth_token')
const verifySession = async (req, res, next) => {
    const authToken = req.cookies.auth_token;
    if (!authToken) {
        // Redirigir si no hay token (no logeado)
        if (req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/auth/logout')) {
            return res.status(401).json({ message: 'No autorizado. Inicie sesión.' });
        }
        // Para rutas de frontend, redirigir a login
        if (req.originalUrl !== '/login.html' && req.originalUrl !== '/register.html' && req.originalUrl !== '/forgot.html') {
             return res.redirect('/login.html');
        }
        return next();
    }

    let client;
    try {
        client = await pool.connect();
        const result = await client.query('SELECT user_id, expiry FROM sessions WHERE token = $1 AND expiry > NOW()', [authToken]);

        if (result.rows.length > 0) {
            req.userId = result.rows[0].user_id;
            // Extender la validez de la sesión por 1 hora más
            await client.query('UPDATE sessions SET expiry = NOW() + INTERVAL \'1 hour\' WHERE token = $1', [authToken]);
            next();
        } else {
            // Sesión expirada o no encontrada
            res.clearCookie('auth_token');
            if (req.originalUrl.startsWith('/api/')) {
                return res.status(401).json({ message: 'Sesión expirada.' });
            }
            res.redirect('/login.html');
        }
    } catch (error) {
        console.error('Error verificando sesión:', error);
        res.status(500).send('Error interno del servidor.');
    } finally {
        if (client) client.release();
    }
};

// Aplicar el middleware de sesión a todas las rutas que no son de autenticación o estáticas públicas
app.use((req, res, next) => {
    const publicPaths = ['/login.html', '/register.html', '/forgot.html', '/style.css', '/', '/auth/login', '/auth/register', '/auth/verify', '/auth/forgot', '/auth/reset'];
    const isPublic = publicPaths.some(p => req.path === p || req.path === '/');

    if (isPublic) {
        next();
    } else {
        verifySession(req, res, next);
    }
});


// ===================================================================================
// LÓGICA DE ENVÍO DE CORREO (NODEMAILER)
// ===================================================================================

const transporter = nodemailer.createTransport({
    service: 'gmail', // Usamos Gmail para facilidad, se puede cambiar
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

async function sendVerificationEmail(recipientEmail, token, type = 'verify') {
    const subject = type === 'verify' ? 'Verificación de Cuenta WaterKontrol' : 'Restablecer Contraseña WaterKontrol';
    const linkPath = type === 'verify' ? `/auth/verify?token=${token}` : `/auth/reset?token=${token}`;
    const link = `${process.env.APP_BASE_URL}${linkPath}`;

    const htmlContent = `
        <p>Hola,</p>
        <p>Has solicitado ${type === 'verify' ? 'verificar tu cuenta' : 'restablecer tu contraseña'} en WaterKontrol.</p>
        <p>Haz clic en el siguiente enlace:</p>
        <p><a href="${link}">${link}</a></p>
        <p>Si no solicitaste esto, ignora este correo.</p>
    `;

    try {
        await transporter.sendMail({
            from: `"WaterKontrol Info" <${process.env.EMAIL_USER}>`,
            to: recipientEmail,
            subject: subject,
            html: htmlContent
        });
        console.log(`📧 Correo de ${type} enviado a ${recipientEmail}`);
    } catch (error) {
        console.error(`❌ Error enviando correo de ${type} a ${recipientEmail}:`, error);
        throw new Error('Error al enviar el correo. Verifica las credenciales en el .env');
    }
}


// ===================================================================================
// RUTAS DE AUTENTICACIÓN (/auth)
// ===================================================================================

// RUTA: /auth/register - Crear un nuevo usuario
app.post('/auth/register', async (req, res) => {
    const { nombre, correo, clave } = req.body;
    if (!nombre || !correo || !clave) {
        return res.status(400).json({ message: 'Faltan campos obligatorios.' });
    }

    let client;
    try {
        client = await pool.connect();
        const existingUser = await client.query('SELECT user_id FROM users WHERE correo = $1', [correo]);

        if (existingUser.rows.length > 0) {
            return res.status(409).json({ message: 'El correo ya está registrado.' });
        }

        const hashedPassword = await bcrypt.hash(clave, saltRounds);
        const verificationToken = crypto.randomBytes(32).toString('hex'); // Token para verificación

        const result = await client.query(
            'INSERT INTO users (nombre, correo, clave_hash, verification_token, verified) VALUES ($1, $2, $3, $4, FALSE) RETURNING user_id',
            [nombre, correo, hashedPassword, verificationToken]
        );

        // Envío de correo de verificación (en paralelo)
        await sendVerificationEmail(correo, verificationToken, 'verify');

        res.status(201).json({ message: '✅ Registro exitoso. Revisa tu correo para verificar tu cuenta.' });

    } catch (error) {
        console.error('Error en /auth/register:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    } finally {
        if (client) client.release();
    }
});

// RUTA: /auth/verify - Verificar cuenta por token de correo
app.get('/auth/verify', async (req, res) => {
    const { token } = req.query;
    if (!token) {
        return res.status(400).send('Token de verificación faltante.');
    }

    let client;
    try {
        client = await pool.connect();
        const result = await client.query(
            'UPDATE users SET verified = TRUE, verification_token = NULL WHERE verification_token = $1 AND verified = FALSE RETURNING user_id',
            [token]
        );

        if (result.rowCount === 1) {
            // Redirigir al login con un mensaje de éxito
            return res.redirect('/login.html?message=✅ Cuenta verificada con éxito. Puedes iniciar sesión.');
        } else {
            return res.status(404).send('Token inválido o cuenta ya verificada.');
        }
    } catch (error) {
        console.error('Error en /auth/verify:', error);
        res.status(500).send('Error interno del servidor.');
    } finally {
        if (client) client.release();
    }
});

// RUTA: /auth/login - Iniciar sesión
app.post('/auth/login', async (req, res) => {
    const { correo, clave } = req.body;
    if (!correo || !clave) {
        return res.status(400).json({ message: 'Faltan campos de correo o clave.' });
    }

    let client;
    try {
        client = await pool.connect();
        const userResult = await client.query('SELECT user_id, clave_hash, verified FROM users WHERE correo = $1', [correo]);

        if (userResult.rows.length === 0) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }

        const user = userResult.rows[0];

        if (!user.verified) {
            return res.status(403).json({ message: '🚫 Cuenta no verificada. Revisa tu correo.' });
        }

        const passwordMatch = await bcrypt.compare(clave, user.clave_hash);

        if (passwordMatch) {
            // Generar token de sesión
            const sessionToken = crypto.randomBytes(32).toString('hex');
            const expiryTime = new Date(Date.now() + 60 * 60 * 1000); // 1 hora de validez

            // Guardar sesión en DB
            await client.query(
                'INSERT INTO sessions (user_id, token, expiry) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET token = $2, expiry = $3',
                [user.user_id, sessionToken, expiryTime]
            );

            // Establecer cookie con el token
            res.cookie('auth_token', sessionToken, {
                httpOnly: true, // No accesible por JavaScript del lado del cliente
                secure: isProduction, // Usar solo en HTTPS en producción
                sameSite: 'Lax', // Previene ataques CSRF
                maxAge: 60 * 60 * 1000 // 1 hora
            });

            return res.json({ message: 'Inicio de sesión exitoso.', redirect: '/app.html' });

        } else {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }
    } catch (error) {
        console.error('Error en /auth/login:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    } finally {
        if (client) client.release();
    }
});

// RUTA: /auth/logout - Cerrar sesión
app.post('/auth/logout', async (req, res) => {
    const authToken = req.cookies.auth_token;

    // 1. Borrar la cookie del cliente
    res.clearCookie('auth_token');

    // 2. Borrar la sesión de la base de datos
    if (authToken) {
        let client;
        try {
            client = await pool.connect();
            await client.query('DELETE FROM sessions WHERE token = $1', [authToken]);
            console.log(`Sesión de usuario [${req.userId}] eliminada de la DB.`);
        } catch (error) {
            console.error('Error al eliminar sesión de DB durante logout:', error);
        } finally {
            if (client) client.release();
        }
    }

    // Respuesta al cliente y redirigir
    res.json({ message: 'Sesión cerrada exitosamente.' });
});

// RUTA: /auth/forgot - Solicitar restablecimiento de contraseña
app.post('/auth/forgot', async (req, res) => {
    const { correo } = req.body;
    if (!correo) {
        return res.status(400).send('Correo faltante.');
    }

    let client;
    try {
        client = await pool.connect();
        const userResult = await client.query('SELECT user_id FROM users WHERE correo = $1', [correo]);

        if (userResult.rows.length === 0) {
            // Por seguridad, siempre se envía un mensaje de éxito aunque el correo no exista
            return res.status(200).send('✅ Si el correo está registrado, recibirás un enlace para restablecer tu contraseña.');
        }

        const user_id = userResult.rows[0].user_id;
        const resetToken = crypto.randomBytes(32).toString('hex');

        // Guardar el token en la DB con una expiración (ej: 1 hora)
        await client.query(
            'UPDATE users SET reset_token = $1, reset_expiry = NOW() + INTERVAL \'1 hour\' WHERE user_id = $2',
            [resetToken, user_id]
        );

        // Envío de correo de restablecimiento (en paralelo)
        await sendVerificationEmail(correo, resetToken, 'reset');

        res.status(200).send('✅ Si el correo está registrado, recibirás un enlace para restablecer tu contraseña.');

    } catch (error) {
        console.error('Error en /auth/forgot:', error);
        res.status(500).send('Error interno del servidor.');
    } finally {
        if (client) client.release();
    }
});

// RUTA: /auth/reset - Restablecer contraseña con el token (PENDIENTE)
// NOTA: Esta ruta solo mostraría un formulario con los campos 'nueva_clave' y 'token' oculto.
app.get('/auth/reset', (req, res) => {
    const { token } = req.query;
    if (!token) {
        return res.status(400).send('Token de restablecimiento faltante.');
    }

    // Aquí deberías servir un archivo HTML (reset.html) con un formulario
    // que incluya el token como campo oculto.
    res.status(501).send(`
        <html>
            <body>
                <h1>Restablecer Contraseña</h1>
                <p>Implementación de la página de formulario de restablecimiento pendiente.</p>
                <p>Tu token es: <strong>${token}</strong>. Úsalo para actualizar la contraseña en una ruta POST /auth/reset_password</p>
                <a href="/login.html">Volver al Login</a>
            </body>
        </html>
    `);
});

// ===================================================================================
// LÓGICA DE MQTT Y GUARDADO EN DB
// ===================================================================================

const procesarMensajesMqtt = () => {
    console.log(`🔌 Conectando a MQTT: ${process.env.MQTT_BROKER_URL}`);
    const client = mqtt.connect(process.env.MQTT_BROKER_URL);

    client.on('connect', async () => {
        console.log('✅ Conexión a MQTT exitosa.');

        // 1. Suscribirse a un topic general para recibir mensajes de todos los dispositivos
        const topic = 'dispositivos/+/telemetria';
        client.subscribe(topic, (err) => {
            if (!err) {
                console.log(`✅ Suscrito al topic de telemetría: ${topic}`);
            } else {
                console.error('❌ Error al suscribirse a MQTT:', err);
            }
        });

        // 2. Opcional: Suscribirse al topic de notificaciones o control
        // client.subscribe('dispositivos/+/control');
    });

    client.on('message', async (topic, message) => {
        let dbClient;
        try {
            const payload = JSON.parse(message.toString());
            const msg_id = payload.msg_id || 'N/A'; // Identificador del mensaje

            // CRÍTICO: Extraer la SERIE del dispositivo del topic
            // El topic es 'dispositivos/{SERIE}/telemetria'
            const serie = topic.split('/')[1];

            // Datos que esperamos del ESP32:
            const { temperatura, ph } = payload;

            if (!serie || typeof temperatura === 'undefined' || typeof ph === 'undefined') {
                console.warn(`⚠️ Mensaje inválido o incompleto del topic [${topic}] (ID: ${msg_id}).`);
                return;
            }

            dbClient = await pool.connect();
            await dbClient.query('BEGIN'); // Iniciar transacción

            // A) Insertar el nuevo valor de telemetría
            await dbClient.query(
                'INSERT INTO telemetria (serie_dispositivo, temperatura, ph, fecha) VALUES ($1, $2, $3, NOW())',
                [serie, temperatura, ph]
            );

            // B) Actualizar el estatus del dispositivo a 'online'
            // NOTA: Se asume que la SERIE ya fue registrada por la ruta /api/dispositivo/registro
            const updateResult = await dbClient.query(
                'UPDATE dispositivos SET estatus = $1, ultima_conexion = NOW() WHERE serie = $2 RETURNING user_id',
                ['online', serie]
            );

            if (updateResult.rowCount === 0) {
                 console.warn(`⚠️ Dispositivo con serie [${serie}] no encontrado en la DB. Telemetría guardada, estatus no actualizado.`);
            }

            await dbClient.query('COMMIT'); // Confirmar transacción
            console.log(`✅ Telemetría guardada para [${serie}] (MSG_ID: ${msg_id}).`);

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
// RUTAS DE LA API (/api)
// ===================================================================================

// Middleware para verificar si el usuario tiene permiso para el dispositivo (CRÍTICO)
const verifyDeviceOwnership = async (req, res, next) => {
    const { serie } = req.params; // Se asume que la serie viene en los parámetros de la ruta
    const user_id = req.userId;

    if (!serie) {
        return res.status(400).json({ message: 'Serie de dispositivo faltante.' });
    }

    let client;
    try {
        client = await pool.connect();
        const result = await client.query(
            'SELECT 1 FROM dispositivos WHERE serie = $1 AND user_id = $2',
            [serie, user_id]
        );

        if (result.rows.length === 0) {
            return res.status(403).json({ message: 'No tienes permiso para acceder a este dispositivo.' });
        }

        // Si es el dueño, pasar al siguiente middleware/ruta
        next();
    } catch (error) {
        console.error('Error verificando propiedad del dispositivo:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    } finally {
        if (client) client.release();
    }
};


// RUTA: /api/dispositivo/registro - Registrar un nuevo dispositivo
app.post('/api/dispositivo/registro', async (req, res) => {
    const { serie, modelo, tipo, marca, topic } = req.body;
    const user_id = req.userId;

    if (!serie || !modelo || !tipo || !topic || !user_id) {
        return res.status(400).json({ message: 'Faltan campos obligatorios para el registro.' });
    }

    let client;
    try {
        client = await pool.connect();
        const existingDevice = await client.query('SELECT 1 FROM dispositivos WHERE serie = $1', [serie]);

        if (existingDevice.rows.length > 0) {
            return res.status(409).json({ message: `El dispositivo con serie ${serie} ya está registrado.` });
        }

        await client.query(
            'INSERT INTO dispositivos (serie, modelo, tipo, marca, user_id, topic, estatus, ultima_conexion) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())',
            [serie, modelo, tipo, marca || 'N/A', user_id, topic, 'offline'] // Inicialmente offline hasta recibir MQTT
        );

        res.status(201).json({ message: 'Dispositivo registrado exitosamente.' });
    } catch (error) {
        console.error('Error en /api/dispositivo/registro:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    } finally {
        if (client) client.release();
    }
});


// RUTA: /api/dispositivos - Obtener la lista de dispositivos del usuario logeado
app.get('/api/dispositivos', async (req, res) => {
    const user_id = req.userId; // Obtenido del middleware verifySession

    let client;
    try {
        client = await pool.connect();
        const result = await client.query(
            'SELECT serie, modelo, tipo, marca, topic, estatus, ultima_conexion FROM dispositivos WHERE user_id = $1 ORDER BY serie',
            [user_id]
        );

        res.json(result.rows);
    } catch (error) {
        console.error('Error en /api/dispositivos:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    } finally {
        if (client) client.release();
    }
});

// RUTA: /api/dispositivos/:serie/telemetria - Obtener los últimos N valores de telemetría de un dispositivo
// Se usa el middleware verifyDeviceOwnership para asegurar que el usuario es el dueño
app.get('/api/dispositivos/:serie/telemetria', verifyDeviceOwnership, async (req, res) => {
    const { serie } = req.params;
    const limit = parseInt(req.query.limit) || 10; // Limitar a los últimos 10 por defecto

    let client;
    try {
        client = await pool.connect();
        const result = await client.query(
            'SELECT temperatura, ph, fecha FROM telemetria WHERE serie_dispositivo = $1 ORDER BY fecha DESC LIMIT $2',
            [serie, limit]
        );

        res.json(result.rows);
    } catch (error) {
        console.error(`Error en /api/dispositivos/${serie}/telemetria:`, error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    } finally {
        if (client) client.release();
    }
});

// RUTA MOCK: /api/mock/dispositivos - MOCK para el frontend (si la DB no está lista)
app.get('/api/mock/dispositivos', (req, res) => {
  const mockDevices = [
    {
      serie: 'WKM-0001',
      modelo: 'Medidor pH/Temp',
      tipo: 'Medidor',
      marca: 'WaterKontrol',
      topic: 'dispositivos/WKM-0001/telemetria',
      estatus: 'offline',
      ultimos_valores: { temperatura: 25, ph: 7.2 }
    },
    {
      serie: 'WKM-0002',
      modelo: 'Controlador Bomba',
      tipo: 'Actuador',
      marca: 'WaterKontrol',
      topic: 'dispositivos/WKM-0002/telemetria',
      estatus: 'online',
      ultimos_valores: { temperatura: 25, ph: 7.2 }
    }
  ];
  res.json(mockDevices);
});

// ===================================================================================
// SERVIDOR DE ARCHIVOS ESTÁTICOS (FRONTEND)
// ===================================================================================

// Ruta raíz (redirige a login.html)
app.get('/', (req, res) => {
    // **CAMBIO TEMPORAL: REDIRIGIR A LA PÁGINA PRINCIPAL EN LUGAR DEL LOGIN**
    // Esto se usa para pruebas rápidas sin pasar por el login.
    // En producción, se debería descomentar el verifySession, y si falla, se redirige a login.html
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
        initializeApplicationServices();
    });
};

startServer();