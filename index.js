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
const jwt = require('jsonwebtoken'); // <-- AÑADIDO: jsonwebtoken
const saltRounds = 10;

// ===================================================================================
// CONSTANTES GLOBALES
// ===================================================================================
// CRÍTICO: Detectar el entorno para configurar SSL y Host
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
// La clave secreta para firmar los JWT. ¡CRÍTICO: No usar un valor por defecto en producción!
const JWT_SECRET = process.env.JWT_SECRET || 'mi_clave_secreta_super_segura_de_desarrollo';

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
console.log('📋 DATABASE_URL:', process.env.DATABASE_URL ? '✅ Definida' : '❌ NO DEFINIDA');
console.log(`📋 Entorno: ${isProduction ? 'Producción (SSL ON)' : 'Local (SSL OFF)'}`);

const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  // CRÍTICO: Configuración SSL para Railway
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10,
};

const pool = new Pool(poolConfig);

const testDatabaseConnection = async () => {
  let client;
  try {
    client = await pool.connect();
    await client.query('SELECT 1');
    console.log('✅ Conexión a PostgreSQL exitosa.');
    return true;
  } catch (error) {
    console.error('❌ Error al conectar o probar la DB:', error.message);
    return false;
  } finally {
    if (client) client.release();
  }
};

// ===================================================================================
// MIDDLEWARE DE AUTENTICACIÓN (JWT + Cookie)
// ===================================================================================

const generateToken = (userId) => {
  return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '7d' });
};

const authMiddleware = (req, res, next) => {
  // 1. Obtener el token de la cookie
  const token = req.cookies.auth_token;

  if (!token) {
    // Si no hay token, el usuario no está autenticado.
    // Para rutas API, responder 401. Para rutas de frontend, redirigir a login.
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ message: 'No autorizado. Token no encontrado.' });
    }
    // Si es una solicitud de página (p.ej., /app.html), redirigir al login
    return res.redirect('/login.html');
  }

  // 2. Verificar el token
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id; // Almacenar el ID del usuario en el request
    next();
  } catch (err) {
    // Si la verificación falla (token inválido o expirado)
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ message: 'Token inválido o expirado.' });
    }
    // Si es una solicitud de página, limpiar la cookie y redirigir
    res.clearCookie('auth_token');
    return res.redirect('/login.html');
  }
};

// ===================================================================================
// RUTAS DE AUTENTICACIÓN
// ===================================================================================

// Función auxiliar para establecer la cookie de sesión
const setAuthCookie = (res, token) => {
  res.cookie('auth_token', token, {
    httpOnly: true, // No accesible mediante JS en el cliente
    secure: isProduction, // Solo enviar sobre HTTPS en producción
    sameSite: 'Lax', // Protección contra CSRF
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
  });
};

// POST /auth/register
app.post('/auth/register', async (req, res) => {
  const { nombre, correo, clave } = req.body;
  let client;

  if (!nombre || !correo || !clave) {
    return res.status(400).json({ message: 'Todos los campos son obligatorios.' });
  }

  try {
    client = await pool.connect();
    // 1. Verificar si el correo ya existe
    const checkUser = await client.query('SELECT user_id FROM usuarios WHERE correo = $1', [correo]);
    if (checkUser.rows.length > 0) {
      return res.status(409).json({ message: 'El correo ya está registrado.' });
    }

    // 2. Hashear la contraseña
    const hashedPassword = await bcrypt.hash(clave, saltRounds);

    // 3. Generar un token de verificación (simple token de 32 bytes en hex)
    const verificationToken = crypto.randomBytes(32).toString('hex');

    // 4. Insertar el nuevo usuario (por defecto 'verificado' = false)
    const insertUserQuery = `
      INSERT INTO usuarios (nombre, correo, clave_hash, verification_token, verificado)
      VALUES ($1, $2, $3, $4, FALSE) RETURNING user_id;
    `;
    await client.query(insertUserQuery, [nombre, correo, hashedPassword, verificationToken]);

    // 5. Enviar correo de verificación (Lógica de nodemailer)
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const verificationLink = `${process.env.APP_BASE_URL}/auth/verify?token=${verificationToken}`;
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: correo,
      subject: 'Verifica tu cuenta de WaterKontrol',
      html: `
        <p>Hola ${nombre},</p>
        <p>Gracias por registrarte en WaterKontrol. Haz clic en el siguiente enlace para verificar tu cuenta:</p>
        <p><a href="${verificationLink}">Verificar Cuenta</a></p>
        <p>Si no te registraste, por favor ignora este correo.</p>
      `,
    };

    await transporter.sendMail(mailOptions);
    console.log(`📧 Correo de verificación enviado a ${correo}.`);

    res.status(201).json({ message: '✅ Registro exitoso. Por favor, revisa tu correo para verificar tu cuenta.' });

  } catch (error) {
    console.error('❌ Error en el registro:', error.message);
    res.status(500).json({ message: 'Error interno del servidor durante el registro.' });
  } finally {
    if (client) client.release();
  }
});

// GET /auth/verify
app.get('/auth/verify', async (req, res) => {
  const { token } = req.query;
  let client;

  if (!token) {
    return res.status(400).send('❌ Token de verificación faltante.');
  }

  try {
    client = await pool.connect();
    // Buscar usuario por token y verificar si ya está verificado
    const result = await client.query(
      'SELECT user_id, verificado FROM usuarios WHERE verification_token = $1',
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).send('❌ Token inválido o expirado.');
    }

    const user = result.rows[0];

    if (user.verificado) {
      // Si ya está verificado, redirigir con un mensaje
      return res.redirect('/login.html?message=Ya has verificado tu cuenta. Inicia sesión.');
    }

    // Marcar como verificado y limpiar el token de un solo uso
    await client.query(
      'UPDATE usuarios SET verificado = TRUE, verification_token = NULL WHERE user_id = $1',
      [user.user_id]
    );

    // Redirigir al login con un mensaje de éxito
    return res.redirect('/login.html?message=✅ ¡Cuenta verificada con éxito! Ya puedes iniciar sesión.');

  } catch (error) {
    console.error('❌ Error en la verificación:', error.message);
    res.status(500).send('❌ Error interno del servidor durante la verificación.');
  } finally {
    if (client) client.release();
  }
});


// POST /auth/login
app.post('/auth/login', async (req, res) => {
  const { correo, clave } = req.body;
  let client;

  if (!correo || !clave) {
    return res.status(400).json({ message: 'El correo y la contraseña son obligatorios.' });
  }

  try {
    client = await pool.connect();
    // 1. Buscar usuario
    const result = await client.query(
      'SELECT user_id, clave_hash, verificado FROM usuarios WHERE correo = $1',
      [correo]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Credenciales inválidas.' });
    }

    const user = result.rows[0];

    // 2. Verificar la contraseña
    const match = await bcrypt.compare(clave, user.clave_hash);
    if (!match) {
      return res.status(401).json({ message: 'Credenciales inválidas.' });
    }

    // 3. Verificar si la cuenta está activa
    if (!user.verificado) {
      return res.status(403).json({ message: 'Tu cuenta no ha sido verificada. Revisa tu correo.' });
    }

    // 4. Generar JWT y establecer cookie
    const token = generateToken(user.user_id);
    setAuthCookie(res, token); // Función para establecer la cookie

    // 5. Respuesta exitosa
    res.status(200).json({
      message: 'Inicio de sesión exitoso.',
      redirect: '/app.html', // Redirigir a la aplicación principal
    });

  } catch (error) {
    console.error('❌ Error en el login:', error.message);
    res.status(500).json({ message: 'Error interno del servidor.' });
  } finally {
    if (client) client.release();
  }
});

// POST /auth/logout
app.post('/auth/logout', (req, res) => {
  // Simplemente borra la cookie
  res.clearCookie('auth_token');
  res.status(200).json({ message: 'Sesión cerrada exitosamente.' });
});

// ===================================================================================
// RUTAS DE API (Requieren Autenticación)
// ===================================================================================

// Ruta para registrar un nuevo dispositivo
app.post('/api/dispositivo/registro', authMiddleware, async (req, res) => {
  const { serie, modelo, tipo, marca, topic } = req.body;
  const userId = req.userId; // Obtenido del token JWT
  let client;

  if (!serie || !topic) {
    return res.status(400).json({ message: 'La serie y el topic son obligatorios.' });
  }

  try {
    client = await pool.connect();

    // 1. Verificar si el dispositivo ya está registrado
    const checkDevice = await client.query('SELECT dsp_id FROM dispositivos WHERE serie = $1', [serie]);
    if (checkDevice.rows.length > 0) {
      return res.status(409).json({ message: `El dispositivo con serie ${serie} ya está registrado.` });
    }

    // 2. Insertar el nuevo dispositivo
    const insertDeviceQuery = `
      INSERT INTO dispositivos (serie, modelo, tipo, marca, topic, user_id, estatus)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING dsp_id;
    `;
    const result = await client.query(insertDeviceQuery, [
      serie,
      modelo || 'N/A',
      tipo || 'N/A',
      marca || 'N/A',
      topic,
      userId,
      'offline' // Estatus inicial por defecto
    ]);

    // 3. Suscribir al topic MQTT
    // Esta parte puede requerir que la función de MQTT se exponga o se maneje globalmente.
    // Por ahora, solo emitimos un log (la lógica de suscripción real se ejecuta en procesarMensajesMqtt)
    console.log(`✅ Dispositivo ${serie} registrado. Intentando suscribirse al topic: ${topic}`);

    res.status(201).json({
      message: 'Dispositivo registrado con éxito.',
      dsp_id: result.rows[0].dsp_id
    });

  } catch (error) {
    console.error(`❌ Error registrando dispositivo ${serie}:`, error.message);
    res.status(500).json({ message: 'Error interno del servidor al registrar el dispositivo.' });
  } finally {
    if (client) client.release();
  }
});

// Ruta para obtener todos los dispositivos del usuario
app.get('/api/dispositivos', authMiddleware, async (req, res) => {
  const userId = req.userId;
  let client;

  try {
    client = await pool.connect();
    const result = await client.query(
      'SELECT serie, modelo, tipo, marca, topic, estatus FROM dispositivos WHERE user_id = $1 ORDER BY serie',
      [userId]
    );
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('❌ Error al obtener dispositivos:', error.message);
    res.status(500).json({ message: 'Error interno del servidor.' });
  } finally {
    if (client) client.release();
  }
});


// ===================================================================================
// LÓGICA DE MQTT (Se mantiene igual, solo se usa la Pool de la DB)
// ===================================================================================

const procesarMensajesMqtt = () => {
  const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL);
  const TOPIC_SUBSCRIBE = 'dispositivos/+/telemetria'; // Topic genérico

  mqttClient.on('connect', () => {
    console.log('✅ Conectado a MQTT Broker.');
    mqttClient.subscribe(TOPIC_SUBSCRIBE, (err) => {
      if (err) {
        console.error('❌ Error al suscribirse al topic:', err);
      } else {
        console.log(`📡 Suscrito al topic: ${TOPIC_SUBSCRIBE}`);
      }
    });
  });

  mqttClient.on('message', async (topic, message) => {
    let dbClient;
    try {
      const payload = JSON.parse(message.toString());
      const { serie, msg_id, temperatura, ph, tds } = payload;

      if (!serie || !msg_id) {
        console.warn(`⚠️ Mensaje MQTT inválido en [${topic}]. Faltan serie o msg_id.`);
        return;
      }

      dbClient = await pool.connect();
      await dbClient.query('BEGIN'); // Iniciar transacción

      // 1. Obtener dsp_id
      const deviceResult = await dbClient.query(
        'SELECT dsp_id, topic FROM dispositivos WHERE serie = $1',
        [serie]
      );

      if (deviceResult.rows.length === 0) {
        console.warn(`⚠️ Mensaje recibido para serie no registrada: ${serie}.`);
        await dbClient.query('COMMIT');
        return;
      }

      const dsp_id = deviceResult.rows[0].dsp_id;

      // 2. Insertar el registro de telemetría (Histórico)
      const insertDataQuery = `
        INSERT INTO telemetria (dsp_id, msg_id, temperatura, ph, tds, topic_recibido)
        VALUES ($1, $2, $3, $4, $5, $6);
      `;
      await dbClient.query(insertDataQuery, [
        dsp_id,
        msg_id,
        temperatura || null,
        ph || null,
        tds || null,
        topic
      ]);

      // 3. Actualizar el estado del dispositivo (Último valor)
      const updateDeviceQuery = `
        UPDATE dispositivos SET
          ultimos_valores = jsonb_set(COALESCE(ultimos_valores, '{}'::jsonb), '{temperatura}', $2::jsonb, TRUE),
          ultimos_valores = jsonb_set(COALESCE(ultimos_valores, '{}'::jsonb), '{ph}', $3::jsonb, TRUE),
          ultimos_valores = jsonb_set(COALESCE(ultimos_valores, '{}'::jsonb), '{tds}', $4::jsonb, TRUE),
          estatus = $5,
          ultima_conexion = NOW()
        WHERE dsp_id = $1;
      `;
      await dbClient.query(updateDeviceQuery, [
        dsp_id,
        temperatura ? JSON.stringify(temperatura) : 'null',
        ph ? JSON.stringify(ph) : 'null',
        tds ? JSON.stringify(tds) : 'null',
        'online'
      ]);

      await dbClient.query('COMMIT'); // Confirmar transacción

      console.log(`✨ Mensaje de telemetría procesado para ${serie} (MSG_ID: ${msg_id}).`);

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
// RUTAS DE FRONTEND Y ESTÁTICAS
// ===================================================================================

// Middleware para proteger rutas de frontend que requieren sesión
const protectFrontendRoute = (req, res, next) => {
  const token = req.cookies.auth_token;
  if (!token) {
    // Si no hay token, redirige a login
    return res.sendFile(path.join(__dirname, 'www', 'login.html'));
  }

  // Verificar token. Si es inválido/expirado, el middleware lo limpiará y redirigirá.
  try {
    jwt.verify(token, JWT_SECRET);
    next(); // Token válido, continuar
  } catch (err) {
    res.clearCookie('auth_token');
    return res.sendFile(path.join(__dirname, 'www', 'login.html'));
  }
};

// Ruta raíz (redirige a login.html si no hay cookie, o a app.html si la hay)
app.get('/', (req, res) => {
    // Si la cookie existe, redirige a la app principal, de lo contrario, al login
    if (req.cookies.auth_token) {
        return res.redirect('/app.html');
    }
    res.sendFile(path.join(__dirname, 'www', 'login.html'));
});

// Proteger la ruta de la aplicación principal
app.get('/app.html', protectFrontendRoute, (req, res) => {
    res.sendFile(path.join(__dirname, 'www', 'app.html'));
});

// Proteger la ruta de añadir dispositivo
app.get('/add_device.html', protectFrontendRoute, (req, res) => {
    res.sendFile(path.join(__dirname, 'www', 'add_device.html'));
});

// Servir archivos estáticos restantes (login.html, register.html, css, js, etc.)
// Nota: Las rutas protegidas anteriores tienen prioridad.
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
            procesarMensajesMqtt();
        } catch (error) {
            console.error('❌ Error iniciando MQTT:', error);
        }
    }
};

const startServer = () => {
    console.log('🚀 Iniciando servidor Express...');
    // CRÍTICO: Asegurarse de escuchar en 0.0.0.0 si es Railway
    const host = isProduction ? '0.0.0.0' : 'localhost';

    app.listen(PORT, host, () => {
        console.log(`✅ Servidor Express ejecutándose en ${host}:${PORT}`);
    });
};

initializeApplicationServices().then(() => {
    startServer();
});