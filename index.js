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
    ssl: isProduction ? { rejectUnauthorized: false } : false,
});

const testDatabaseConnection = async () => {
    try {
        await pool.query('SELECT NOW()');
        console.log('✅ Conexión a PostgreSQL exitosa.');
        return true;
    } catch (err) {
        console.error('❌ Error al conectar a PostgreSQL:', err.message);
        return false;
    }
};

// ===================================================================================
// CONFIGURACIÓN DE NODEMAILER (Para envío de correos)
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
        subject: 'Verifica tu cuenta WaterKontrol',
        html: `
            <h1>Verificación de Cuenta</h1>
            <p>Gracias por registrarte en WaterKontrol. Por favor, haz clic en el siguiente enlace para verificar tu cuenta:</p>
            <a href="${verificationUrl}">Verificar mi Cuenta</a>
            <p>Si no solicitaste este registro, ignora este correo.</p>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Correo de verificación enviado a ${correo}`);
    } catch (error) {
        console.error(`❌ Error al enviar correo de verificación a ${correo}:`, error.message);
    }
};

const sendPasswordResetEmail = async (correo, token) => {
    const resetUrl = `${process.env.APP_BASE_URL}/reset_password.html?token=${token}`;
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: correo,
        subject: 'Recuperación de Contraseña WaterKontrol',
        html: `
            <h1>Recuperación de Contraseña</h1>
            <p>Has solicitado restablecer tu contraseña. Haz clic en el siguiente enlace:</p>
            <a href="${resetUrl}">Restablecer Contraseña</a>
            <p>Este enlace expirará en 1 hora. Si no solicitaste esto, ignora este correo.</p>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Correo de recuperación enviado a ${correo}`);
    } catch (error) {
        console.error(`❌ Error al enviar correo de recuperación a ${correo}:`, error.message);
    }
};

// ===================================================================================
// LÓGICA DE MIDDLEWARE DE AUTENTICACIÓN
// ===================================================================================

/**
 * Middleware para asegurar que el usuario ha iniciado sesión.
 * Asume que el ID de usuario está en el token JWT (cookie 'token').
 */
const ensureAuthenticated = async (req, res, next) => {
    // ** TEMPORALMENTE DESHABILITADO PARA PRUEBAS SIN LOGIN **
    // const token = req.cookies.token;
    
    // if (!token) {
    //     return res.status(401).sendFile(path.join(__dirname, 'www', 'login.html'));
    // }

    // try {
    //     const result = await pool.query('SELECT * FROM usuarios WHERE token = $1', [token]);
    //     if (result.rows.length === 0) {
    //         res.clearCookie('token');
    //         return res.status(401).sendFile(path.join(__dirname, 'www', 'login.html'));
    //     }

    //     req.user = result.rows[0];
    //     next();
    // } catch (error) {
    //     console.error('Error en ensureAuthenticated:', error);
    //     res.clearCookie('token');
    //     return res.status(500).send('Error interno del servidor.');
    // }
    next(); // <--- CRÍTICO: Permitir el paso para pruebas sin login
};

/**
 * Middleware para verificar si la cuenta ha sido validada por correo.
 */
const checkVerificationStatus = (req, res, next) => {
    // ** TEMPORALMENTE DESHABILITADO PARA PRUEBAS SIN LOGIN **
    // if (req.user && !req.user.is_verified) {
    //     // Si la cuenta no está verificada, redirigir a una página de advertencia
    //     // En este caso, solo enviamos un error 403.
    //     return res.status(403).json({ message: 'Cuenta no verificada. Revisa tu correo.' });
    // }
    next(); // <--- CRÍTICO: Permitir el paso para pruebas sin login
};

// ===================================================================================
// RUTAS DE AUTENTICACIÓN (Login, Register, Logout)
// ===================================================================================

// [ ... Código de rutas de autenticación: /auth/register, /auth/login, /auth/verify, /auth/forgot, /auth/reset, /auth/logout ... ]
// NOTA: El código de estas rutas NO se modifica, pero el middleware 'ensureAuthenticated' ahora está comentado.

// Ruta /auth/register
app.post('/auth/register', async (req, res) => {
    const { nombre, correo, clave } = req.body;
    if (!nombre || !correo || !clave) {
        return res.status(400).json({ message: 'Todos los campos son obligatorios.' });
    }

    try {
        const checkUser = await pool.query('SELECT * FROM usuarios WHERE correo = $1', [correo]);
        if (checkUser.rows.length > 0) {
            return res.status(409).json({ message: 'El correo ya está registrado.' });
        }

        const hashedPassword = await bcrypt.hash(clave, saltRounds);
        const verificationToken = crypto.randomBytes(32).toString('hex');
        
        await pool.query(
            'INSERT INTO usuarios (nombre, correo, clave_hash, verification_token) VALUES ($1, $2, $3, $4)',
            [nombre, correo, hashedPassword, verificationToken]
        );

        // Enviar correo de verificación (ejecutado en segundo plano)
        sendVerificationEmail(correo, verificationToken);

        res.status(201).json({ message: 'Registro exitoso. Revisa tu correo para verificar tu cuenta.' });
    } catch (error) {
        console.error('Error en el registro:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// Ruta /auth/login
app.post('/auth/login', async (req, res) => {
    const { correo, clave } = req.body;
    try {
        const result = await pool.query('SELECT * FROM usuarios WHERE correo = $1', [correo]);
        const user = result.rows[0];

        if (!user || !(await bcrypt.compare(clave, user.clave_hash))) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }
        
        if (!user.is_verified) {
             return res.status(403).json({ message: 'Cuenta no verificada. Revisa tu correo.' });
        }

        // Generar y guardar un nuevo token de sesión si es necesario, o usar el existente
        const sessionToken = crypto.randomBytes(32).toString('hex');
        await pool.query('UPDATE usuarios SET token = $1 WHERE id = $2', [sessionToken, user.id]);

        // Establecer la cookie de sesión
        res.cookie('token', sessionToken, { 
            httpOnly: true, 
            secure: isProduction, // Usar 'secure: true' en producción (HTTPS)
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 días
        });
        
        res.json({ message: 'Login exitoso', redirect: '/app.html' });
    } catch (error) {
        console.error('Error en el login:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// Ruta /auth/verify
app.get('/auth/verify', async (req, res) => {
    const { token } = req.query;
    if (!token) {
        return res.status(400).send('Token de verificación faltante.');
    }

    try {
        const result = await pool.query(
            'UPDATE usuarios SET is_verified = TRUE, verification_token = NULL WHERE verification_token = $1 AND is_verified = FALSE RETURNING *',
            [token]
        );

        if (result.rowCount === 0) {
            // El token no es válido o la cuenta ya está verificada
            return res.status(400).send('Token de verificación inválido o expirado.');
        }

        // Verificación exitosa, redirigir al login con un mensaje
        res.redirect('/login.html?message=✅ Cuenta verificada. ¡Puedes iniciar sesión!');

    } catch (error) {
        console.error('Error en la verificación:', error);
        res.status(500).send('Error interno del servidor.');
    }
});

// Ruta /auth/forgot
app.post('/auth/forgot', async (req, res) => {
    const { correo } = req.body;
    try {
        const result = await pool.query('SELECT * FROM usuarios WHERE correo = $1', [correo]);
        const user = result.rows[0];

        if (!user) {
            // No revelar si el correo existe por seguridad. Responder como si se hubiera enviado.
            return res.json({ message: 'Si el correo está registrado, se enviará un enlace de recuperación.' });
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        // El token expira en 1 hora
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); 

        await pool.query(
            'UPDATE usuarios SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
            [resetToken, expiresAt, user.id]
        );

        sendPasswordResetEmail(correo, resetToken);

        res.json({ message: 'Si el correo está registrado, se enviará un enlace de recuperación.' });
    } catch (error) {
        console.error('Error en la recuperación de contraseña:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// Ruta /auth/reset (para restablecer la contraseña)
app.post('/auth/reset', async (req, res) => {
    const { token, nueva_clave } = req.body;
    if (!token || !nueva_clave) {
        return res.status(400).json({ message: 'Datos incompletos.' });
    }

    try {
        const result = await pool.query(
            'SELECT * FROM usuarios WHERE reset_token = $1 AND reset_token_expires > NOW()',
            [token]
        );
        const user = result.rows[0];

        if (!user) {
            return res.status(400).json({ message: 'Token inválido o expirado.' });
        }

        const hashedPassword = await bcrypt.hash(nueva_clave, saltRounds);

        await pool.query(
            'UPDATE usuarios SET clave_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
            [hashedPassword, user.id]
        );

        res.json({ message: '✅ Contraseña restablecida con éxito. Inicia sesión.' });

    } catch (error) {
        console.error('Error al restablecer contraseña:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});


// Ruta /auth/logout
app.post('/auth/logout', (req, res) => {
    // Borrar el token del usuario en la base de datos (opcional, pero buena práctica)
    // El ID de usuario se obtendría de req.user si el ensureAuthenticated estuviera activo.
    // Por ahora, solo borramos la cookie.
    res.clearCookie('token');
    res.status(200).json({ message: 'Sesión cerrada.' });
});


// ===================================================================================
// RUTAS DE LA APLICACIÓN (API y Páginas)
// ===================================================================================

/**
 * Endpoint de prueba de la API para obtener dispositivos.
 * Ahora usa ensureAuthenticated, que está desactivado.
 */
app.get('/api/dispositivos', ensureAuthenticated, checkVerificationStatus, async (req, res) => {
  // ** Temporalmente usamos un mock de dispositivos **
  // Aquí es donde se conectaría a la DB para obtener los dispositivos
  // asociados al req.user.id.
  const mockDevices = [
    {
      id: 1,
      serie: 'WKM-0001',
      modelo: 'Medidor pH/Temp',
      tipo: 'Medidor',
      marca: 'WaterKontrol',
      topic: 'dispositivos/WKM-0001/telemetria',
      estatus: 'online',
      ultimos_valores: { temperatura: 25, ph: 7.2 }
    },
    {
      id: 2,
      serie: 'WKM-0002',
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

// Ruta /api/dispositivo/registro
app.post('/api/dispositivo/registro', ensureAuthenticated, checkVerificationStatus, async (req, res) => {
    // Aquí iría la lógica para registrar el dispositivo en la DB de Railway
    // por ahora, solo simulamos un registro exitoso.
    const { serie, modelo, tipo, marca, topic } = req.body;
    
    // Simulación de validación
    if (!serie) {
        return res.status(400).json({ message: 'Número de serie es requerido.' });
    }

    console.log(`✅ Dispositivo ${serie} simulado en la plataforma.`);

    // En una implementación real, se haría:
    // await pool.query('INSERT INTO dispositivos (...) VALUES (...)', [...]);
    
    res.status(200).json({ message: `Dispositivo ${serie} registrado exitosamente.` });
});


// ===================================================================================
// LÓGICA DE CONEXIÓN MQTT
// ===================================================================================
// [ ... Código de MQTT no modificado ... ]

const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL);
const procesarMensajesMqtt = () => {
  mqttClient.on('connect', () => {
    console.log('✅ Conexión a MQTT Broker exitosa.');
    // Suscribirse a un topic global para telemetría
    // En un sistema real, se suscribiría a los topics de los dispositivos del usuario.
    mqttClient.subscribe('dispositivos/+/telemetria', (err) => {
      if (!err) {
        console.log('✅ Suscrito al topic de telemetría general: dispositivos/+/telemetria');
      }
    });
  });

  mqttClient.on('message', async (topic, message) => {
    let dbClient;
    try {
      dbClient = await pool.connect();
      await dbClient.query('BEGIN');

      const payload = JSON.parse(message.toString());
      const { msg_id, ...valores } = payload;
      const dsp_serie = topic.split('/')[1]; // Extraer la serie del topic

      // 1. Verificar si el dispositivo existe
      const dsp_res = await dbClient.query('SELECT id FROM dispositivos WHERE serie = $1', [dsp_serie]);
      if (dsp_res.rows.length === 0) {
        console.warn(`⚠️ Mensaje recibido para dispositivo no registrado: ${dsp_serie}`);
        await dbClient.query('ROLLBACK');
        return;
      }
      const dsp_id = dsp_res.rows[0].id;

      // 2. Insertar el registro de telemetría (asumiendo tabla 'telemetria')
      const keys = Object.keys(valores);
      const values = Object.values(valores);
      const valuePlaceholders = keys.map((_, i) => `$${i + 4}`).join(', '); // +4 porque $1,$2,$3 ya están usados

      await dbClient.query(`
        INSERT INTO telemetria (dispositivo_id, msg_id, topic, ${keys.join(', ')})
        VALUES ($1, $2, $3, ${valuePlaceholders})
      `, [dsp_id, msg_id, topic, ...values]);
      
      // 3. Actualizar el estado del dispositivo (simulación de 'ultimos_valores' en la tabla 'dispositivos')
      // Esta lógica se dejará como conceptual por ahora, pero en el frontend estamos usando valores mockeados.

      await dbClient.query('COMMIT');
      console.log(`✅ Datos de telemetría de ${dsp_serie} guardados (MSG_ID: ${msg_id}).`);

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
// SERVIDOR DE ARCHIVOS ESTÁTICOS (FRONTEND)
// ===================================================================================

// Ruta raíz
app.get('/', (req, res) => {
    // CRÍTICO: Servir directamente app.html para evitar el problema de login
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
    });
};

initializeApplicationServices();
startServer();